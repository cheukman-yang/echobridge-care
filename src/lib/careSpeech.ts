import type { SpeechVoice } from './callProtocol';

/**
 * 模擬クリニック通話および対面診察モード向けの音声合成（TTS）・ブラウザ音声認識ヘルパー。
 *
 * - TTS: まず `/api/care/tts`（Cloud Text-to-Speech）を試み、未設定・失敗時はブラウザの `speechSynthesis`（日本語音声）で読み上げる。
 * - STT: ブラウザの Web Speech API（`SpeechRecognition` / `webkitSpeechRecognition`）を使い、医師用Push-to-Talk（ja-JP）と患者音声入力（ja-JP / en-US）を支援する。
 */

export interface SpeakCareOptions {
  voice?: SpeechVoice;
  lang?: 'ja-JP' | 'en-US';
  onStart?: () => void;
  onEnd?: () => void;
}

let activeAudio: HTMLAudioElement | null = null;
let activeObjectUrl: string | null = null;
let cloudTtsUnavailable = false;

export function resetCareSpeechCache(): void {
  cloudTtsUnavailable = false;
}

export function stopCareSpeech(): void {
  if (activeAudio) {
    activeAudio.onended = null;
    activeAudio.onerror = null;
    activeAudio.pause();
    activeAudio = null;
  }
  if (activeObjectUrl) {
    URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
  }
}

function speakWithBrowser(text: string, lang: 'ja-JP' | 'en-US', options: SpeakCareOptions): boolean {
  if (typeof window === 'undefined' || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
    options.onEnd?.();
    return false;
  }
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = 1.0;
    const prefix = lang.slice(0, 2).toLowerCase();
    const voices = typeof window.speechSynthesis.getVoices === 'function' ? window.speechSynthesis.getVoices() : [];
    const matched = voices.find((candidate) => candidate.lang.replace('_', '-').toLowerCase().startsWith(prefix));
    if (matched) utterance.voice = matched;
    utterance.onstart = () => options.onStart?.();
    utterance.onend = () => options.onEnd?.();
    utterance.onerror = () => options.onEnd?.();
    window.speechSynthesis.speak(utterance);
    return true;
  } catch {
    options.onEnd?.();
    return false;
  }
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

export async function speakCareText(text: string, options: SpeakCareOptions = {}): Promise<'cloud' | 'device' | 'none'> {
  const trimmed = text.trim();
  if (!trimmed) {
    options.onEnd?.();
    return 'none';
  }

  stopCareSpeech();
  const lang = options.lang ?? 'ja-JP';

  if (lang === 'ja-JP' && !cloudTtsUnavailable && typeof Audio !== 'undefined' && typeof fetch === 'function') {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 2_500) : null;
    try {
      const response = await fetch('/api/care/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed, voice: options.voice ?? 'female' }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (response.ok) {
        const data = (await response.json()) as { available?: boolean; audio?: string; mimeType?: string };
        if (data.available === false) {
          cloudTtsUnavailable = true;
        } else if (data.available && data.audio && data.mimeType) {
          const blob = base64ToBlob(data.audio, data.mimeType);
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          activeAudio = audio;
          activeObjectUrl = url;
          audio.onplaying = () => options.onStart?.();
          audio.onended = () => {
            if (activeObjectUrl === url) {
              URL.revokeObjectURL(url);
              activeObjectUrl = null;
            }
            if (activeAudio === audio) activeAudio = null;
            options.onEnd?.();
          };
          audio.onerror = () => {
            if (activeObjectUrl === url) {
              URL.revokeObjectURL(url);
              activeObjectUrl = null;
            }
            if (activeAudio === audio) activeAudio = null;
            speakWithBrowser(trimmed, lang, options);
          };
          await audio.play();
          return 'cloud';
        }
      } else {
        cloudTtsUnavailable = true;
      }
    } catch {
      cloudTtsUnavailable = true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return speakWithBrowser(trimmed, lang, options) ? 'device' : 'none';
}

interface BrowserSpeechRecognitionAlternative {
  transcript: string;
}

interface BrowserSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: BrowserSpeechRecognitionAlternative;
}

interface BrowserSpeechRecognitionResultList {
  readonly length: number;
  [index: number]: BrowserSpeechRecognitionResult;
}

interface BrowserSpeechRecognitionEvent {
  readonly results: BrowserSpeechRecognitionResultList;
}

interface BrowserSpeechRecognitionInstance {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognitionInstance;

type SpeechWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

export function isBrowserSpeechRecognitionSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const win = window as SpeechWindow;
  return typeof (win.SpeechRecognition ?? win.webkitSpeechRecognition) === 'function';
}

export interface BrowserSpeechSession {
  stop(): void;
  abort(): void;
}

export interface StartBrowserSpeechOptions {
  lang: 'ja-JP' | 'en-US';
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  onError?: (reason: string) => void;
  onEnd?: () => void;
}

export function startBrowserSpeechRecognition(options: StartBrowserSpeechOptions): BrowserSpeechSession | null {
  if (typeof window === 'undefined') return null;
  const win = window as SpeechWindow;
  const RecognitionCtor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
  if (!RecognitionCtor) return null;

  const recognition = new RecognitionCtor();
  recognition.lang = options.lang;
  recognition.interimResults = true;
  recognition.continuous = true;

  let finalTranscript = '';
  let interimTranscript = '';
  let finished = false;

  recognition.onresult = (event) => {
    let finalBuf = '';
    let interimBuf = '';
    for (let i = 0; i < event.results.length; i += 1) {
      const res = event.results[i];
      const chunk = res[0]?.transcript ?? '';
      if (res.isFinal) {
        finalBuf += chunk;
      } else {
        interimBuf += chunk;
      }
    }
    finalTranscript = finalBuf;
    interimTranscript = interimBuf;
    options.onInterim?.((finalTranscript + interimTranscript).trim());
  };

  recognition.onerror = (event) => {
    options.onError?.(event.error ?? 'speech_error');
  };

  recognition.onend = () => {
    if (finished) return;
    finished = true;
    const combined = (finalTranscript + interimTranscript).trim();
    if (combined) {
      options.onFinal(combined);
    }
    options.onEnd?.();
  };

  try {
    recognition.start();
  } catch {
    options.onError?.('start_failed');
    return null;
  }

  return {
    stop() {
      try {
        recognition.stop();
      } catch {
        // ignore
      }
    },
    abort() {
      finished = true;
      try {
        recognition.abort();
      } catch {
        // ignore
      }
    },
  };
}
