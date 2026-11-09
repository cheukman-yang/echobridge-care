import type { SpeechAudio } from './callProtocol';
import type { AudioOutput, DeviceVoice, DeviceVoiceSupport, PlaybackEvents, PlaybackHandle } from './speechPlayback';

/**
 * ブラウザで音を鳴らす部品。相手の画面（/join）だけが使う。
 *
 * audio要素を使う理由（2026-11-08の判断）:
 * - iPhoneのSafariは、利用者の操作で一度鳴らしたaudio要素なら、後から操作なしで鳴らせる。
 *   Web Audio API はマナーモード（消音スイッチ）で鳴らないことがある
 * - MP3はiPhone・Android・PCのブラウザで再生できる
 */

/** 0.1秒の無音（8kHz・16bit・モノラルのWAV）。操作の中で鳴らして、audio要素の再生を許可させる。 */
function silentWav(): Blob {
  const samples = 800;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples * 2, true);
  return new Blob([buffer], { type: 'audio/wav' });
}

function base64ToBlob(base64: string, type: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

function failureKind(error: unknown): 'blocked' | 'failed' {
  return (error as { name?: unknown } | null)?.name === 'NotAllowedError' ? 'blocked' : 'failed';
}

/** 1つのaudio要素を使い回す。iPhoneでは、操作で許可された要素だけが後から鳴らせるため。 */
export function createHtmlAudioOutput(): AudioOutput {
  let element: HTMLAudioElement | null = null;
  let objectUrl: string | null = null;
  // 最後に始めた再生。古い再生の合図（止めた後の pause や AbortError）を無視する。
  let token = 0;

  const getElement = (): HTMLAudioElement | null => {
    if (typeof Audio === 'undefined') return null;
    if (!element) {
      element = new Audio();
      element.preload = 'auto';
      element.setAttribute('playsinline', '');
    }
    return element;
  };

  const releaseUrl = () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  };

  const detach = (el: HTMLAudioElement) => {
    el.onplaying = null;
    el.onended = null;
    el.onerror = null;
  };

  return {
    unlock() {
      const el = getElement();
      // 鳴らしている最中なら、もう許可されている。
      if (!el || !el.paused) return;
      token += 1;
      const mine = token;
      detach(el);
      releaseUrl();
      try {
        objectUrl = URL.createObjectURL(silentWav());
        el.src = objectUrl;
        const played = el.play();
        played?.then(
          () => {
            if (token === mine) el.pause();
          },
          () => {},
        );
      } catch {
        // 許可できなくても、再生のときに blocked として扱う。
      }
    },
    play(audio: SpeechAudio, events: PlaybackEvents): PlaybackHandle {
      const el = getElement();
      if (!el) {
        queueMicrotask(() => events.onError('failed'));
        return { stop: () => {} };
      }
      token += 1;
      const mine = token;
      const isMine = () => token === mine;
      el.pause();
      detach(el);
      releaseUrl();
      el.onplaying = () => {
        // 長さは鳴り始めた時点で分かっている（MP3を丸ごと渡しているため）。分からなければ渡さない。
        const seconds = el.duration;
        if (isMine()) events.onStart(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined);
      };
      el.onended = () => {
        if (isMine()) events.onEnd();
      };
      el.onerror = () => {
        if (isMine()) events.onError('failed');
      };
      try {
        objectUrl = URL.createObjectURL(base64ToBlob(audio.audio, audio.mimeType));
        el.src = objectUrl;
        const played = el.play();
        played?.catch((error: unknown) => {
          if (isMine()) events.onError(failureKind(error));
        });
      } catch (error) {
        queueMicrotask(() => {
          if (isMine()) events.onError(failureKind(error));
        });
      }
      return {
        stop() {
          if (!isMine()) return;
          token += 1;
          detach(el);
          el.pause();
          releaseUrl();
        },
      };
    },
  };
}

function isJapaneseVoice(voice: SpeechSynthesisVoice): boolean {
  return voice.lang.replace('_', '-').toLowerCase().startsWith('ja');
}

function synth(): SpeechSynthesis | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  if (typeof SpeechSynthesisUtterance === 'undefined') return null;
  return window.speechSynthesis;
}

function voices(): SpeechSynthesisVoice[] {
  const s = synth();
  try {
    return typeof s?.getVoices === 'function' ? s.getVoices() : [];
  } catch {
    return [];
  }
}

/**
 * 端末の声（speechSynthesis）。日本語の声を明示して選ぶ。
 * 言語だけを指定すると、端末の既定の声（たとえば広東語）で日本語を読む端末がある。
 */
export function createDeviceVoice(): DeviceVoice {
  return {
    support(): DeviceVoiceSupport {
      if (!synth()) return 'unsupported';
      const list = voices();
      if (list.length === 0) return 'unknown';
      return list.some(isJapaneseVoice) ? 'japanese' : 'none';
    },
    unlock() {
      const s = synth();
      if (!s) return;
      // 声の一覧は、最初に求めたときから読み込みが始まるブラウザがある。端末の声で読むときまでに日本語の声を選べるようにする。
      voices();
      try {
        // iPhoneのSafariは、最初の読み上げが操作の中でないと、その後も鳴らさない。
        const utterance = new SpeechSynthesisUtterance('');
        utterance.volume = 0;
        s.speak(utterance);
      } catch {
        // 読み上げのときに失敗として扱う。
      }
    },
    speak(text: string, events: PlaybackEvents): PlaybackHandle {
      const s = synth();
      if (!s) {
        queueMicrotask(() => events.onError('failed'));
        return { stop: () => {} };
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'ja-JP';
      utterance.rate = 1.0;
      const japanese = voices().find(isJapaneseVoice);
      if (japanese) utterance.voice = japanese;
      let active = true;
      utterance.onstart = () => {
        if (active) events.onStart();
      };
      utterance.onend = () => {
        if (active) events.onEnd();
      };
      utterance.onerror = () => {
        if (active) events.onError('failed');
      };
      s.speak(utterance);
      return {
        stop() {
          // 止めたことで届く終わりや失敗の合図は、もう使わない。
          active = false;
          s.cancel();
        },
      };
    },
    cancelAll() {
      synth()?.cancel();
    },
  };
}
