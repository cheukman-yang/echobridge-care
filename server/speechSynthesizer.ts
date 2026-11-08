import { EventEmitter } from 'node:events';
import { DEFAULT_SPEECH_VOICE, SPEECH_VOICES } from '../src/lib/callProtocol';
import type { SpeechAudio, SpeechVoice, SynthesisFailureReason } from '../src/lib/callProtocol';

/** 合成の結果。失敗しても例外にせず、理由を返す。呼び出し側は端末の声に切り替える。 */
export type SynthesisOutcome =
  | ({ ok: true; cached: boolean } & SpeechAudio)
  | { ok: false; reason: SynthesisFailureReason };

/**
 * 本人の文を音声にする入口。
 *
 * 通話の処理はこの形だけに依存する。実際のCloud Text-to-Speech、開発用のモック、テストの偽物を差し替えられる。
 */
export interface SpeechSynthesizer {
  /** 今、合成を試す価値があるか。false なら相手の画面は音声を待たない。 */
  readonly available: boolean;
  /** available が変わるたびに呼ぶ。戻り値の関数で購読をやめる。 */
  onAvailabilityChange(listener: (available: boolean) => void): () => void;
  /** 文を合成する。拒否しない。 */
  synthesize(text: string, voice: SpeechVoice): Promise<SynthesisOutcome>;
  /** 決まった文（即答フレーズなど）の合成済みの音声。待たずに返せるものだけ。 */
  cachedAudio(text: string, voice: SpeechVoice): SpeechAudio | null;
}

/** 音声合成を使わない（開発用のモックや、設定で切った場合）。相手の画面は端末の声で読む。 */
export const DISABLED_SYNTHESIZER: SpeechSynthesizer = {
  available: false,
  onAvailabilityChange: () => () => {},
  synthesize: async () => ({ ok: false, reason: 'unavailable' }),
  cachedAudio: () => null,
};

/** Cloud Text-to-Speechのクライアントのうち、ここで使う部分。 */
export interface TtsClientLike {
  auth: { getClient(): Promise<unknown> };
  synthesizeSpeech(
    request: {
      input: { text: string };
      voice: { languageCode: string; name: string };
      audioConfig: { audioEncoding: 'MP3'; speakingRate?: number };
    },
    options?: { timeout?: number; maxRetries?: number },
  ): Promise<[{ audioContent?: Uint8Array | string | null }, ...unknown[]]>;
}

export interface CloudSynthesizerConfig {
  /** 本人の選択から実際の声の名前へ。例: ja-JP-Chirp3-HD-Aoede */
  voices: Record<SpeechVoice, string>;
  languageCode: string;
  speakingRate: number;
  /** 1日（日本時間）に合成する文字数の上限。超えたら端末の声に切り替える。 */
  dailyCharLimit: number;
  /** 起動時に作っておき、使い回す文。本人の個人的な文は入れない。 */
  cacheableTexts: readonly string[];
  /** 権限やAPIの無効で失敗した後、試し直すまでの時間。 */
  unavailableCooldownMs?: number;
  now?: () => number;
}

/**
 * 1文の合成を待つ上限。Chirp 3: HD の一括合成は実測で 10文字0.5秒、52文字1.8秒（2026-11-08）。
 * 長い文ほど時間がかかるので、文字数に比例させる。超えたら相手の端末の声で読む。
 */
export function synthesisTimeoutMs(text: string): number {
  return Math.min(15_000, 3_000 + text.length * 40);
}

const DEFAULT_UNAVAILABLE_COOLDOWN_MS = 60_000;

/** gRPCの状態コード。権限・認証・APIの無効は、試し直しても当面は直らない。 */
const GRPC_PERMISSION_DENIED = 7;
const GRPC_UNAUTHENTICATED = 16;

function jstDay(now: number): string {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function log(severity: 'INFO' | 'WARNING', message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ severity, message, ...fields });
  if (severity === 'INFO') console.log(line);
  else console.warn(line);
}

function errorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

/**
 * Cloud Text-to-Speech（Chirp 3: HD）で合成する。
 *
 * - 認証を確認できるまで available は false。確認できなければ、相手の画面は最初から端末の声で読む
 * - 権限不足・APIの無効は一定時間 available を false にし、相手を毎回待たせない
 * - 決まった文はプロセスの中に残して使い回す。本人が入力した文は残さない（通話の記録と同じく、通話の中でだけ持つ）
 * - ログには文字数と時間だけを出し、本文は出さない
 */
export function createCloudSynthesizer(client: TtsClientLike, config: CloudSynthesizerConfig): SpeechSynthesizer {
  const now = config.now ?? Date.now;
  const cooldownMs = config.unavailableCooldownMs ?? DEFAULT_UNAVAILABLE_COOLDOWN_MS;
  const events = new EventEmitter();
  const cacheable = new Set(config.cacheableTexts);
  const cache = new Map<string, Promise<SynthesisOutcome>>();
  const ready = new Map<string, SpeechAudio>();
  let credentialsReady = false;
  let unavailableUntil = 0;
  let cooldownTimer: NodeJS.Timeout | null = null;
  let budgetDay = jstDay(now());
  let usedChars = 0;
  let lastAvailable = false;

  const isAvailable = () => credentialsReady && now() >= unavailableUntil;

  const publish = () => {
    const available = isAvailable();
    if (available === lastAvailable) return;
    lastAvailable = available;
    events.emit('availability', available);
  };

  const markUnavailable = () => {
    unavailableUntil = now() + cooldownMs;
    publish();
    if (cooldownTimer) clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      publish();
    }, cooldownMs);
    cooldownTimer.unref?.();
  };

  /** 日が変わったら数え直す。超えていれば false。 */
  const reserveChars = (count: number): boolean => {
    const today = jstDay(now());
    if (today !== budgetDay) {
      budgetDay = today;
      usedChars = 0;
    }
    if (usedChars + count > config.dailyCharLimit) return false;
    usedChars += count;
    return true;
  };

  const callApi = async (text: string, voice: SpeechVoice): Promise<SynthesisOutcome> => {
    if (!isAvailable()) return { ok: false, reason: 'unavailable' };
    if (!reserveChars(text.length)) {
      log('WARNING', 'tts_daily_limit_reached', { limit: config.dailyCharLimit });
      return { ok: false, reason: 'quota' };
    }
    const voiceName = config.voices[voice];
    const timeoutMs = synthesisTimeoutMs(text);
    const startedAt = now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const request = client.synthesizeSpeech(
        {
          input: { text },
          voice: { languageCode: config.languageCode, name: voiceName },
          audioConfig: { audioEncoding: 'MP3', speakingRate: config.speakingRate },
        },
        { timeout: timeoutMs, maxRetries: 0 },
      );
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
        timer.unref?.();
      });
      const result = await Promise.race([request, timedOut]);
      if (result === 'timeout') {
        // 遅れて返った結果は使わない。拒否されても未処理にしない。
        request.catch(() => {});
        log('WARNING', 'tts_failed', { reason: 'timeout', chars: text.length, voice: voiceName });
        return { ok: false, reason: 'timeout' };
      }
      const content = result[0].audioContent;
      const audio =
        typeof content === 'string' ? content : content ? Buffer.from(content).toString('base64') : '';
      if (!audio) {
        log('WARNING', 'tts_failed', { reason: 'empty', chars: text.length, voice: voiceName });
        return { ok: false, reason: 'error' };
      }
      log('INFO', 'tts_synthesized', { chars: text.length, ms: now() - startedAt, voice: voiceName });
      return { ok: true, cached: false, audio, mimeType: 'audio/mpeg' };
    } catch (error) {
      const code = errorCode(error);
      const unavailable = code === GRPC_PERMISSION_DENIED || code === GRPC_UNAUTHENTICATED;
      log('WARNING', 'tts_failed', {
        reason: unavailable ? 'unavailable' : 'error',
        code,
        chars: text.length,
        voice: voiceName,
      });
      if (unavailable) markUnavailable();
      return { ok: false, reason: unavailable ? 'unavailable' : 'error' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const cacheKey = (text: string, voice: SpeechVoice) => `${config.voices[voice]}\n${text}`;

  const synthesize = (text: string, voice: SpeechVoice): Promise<SynthesisOutcome> => {
    if (!cacheable.has(text)) return callApi(text, voice);
    const key = cacheKey(text, voice);
    const existing = cache.get(key);
    if (existing) return existing.then((outcome) => (outcome.ok ? { ...outcome, cached: true } : outcome));
    const pending = callApi(text, voice).then((outcome) => {
      if (outcome.ok) ready.set(key, { audio: outcome.audio, mimeType: outcome.mimeType });
      else cache.delete(key);
      return outcome;
    });
    cache.set(key, pending);
    return pending;
  };

  /**
   * 決まった文を順に作っておく。最初の1回でgRPCの接続も温まる。
   * 既定の声を先に作る。2つの声で合わせて約130文字（起動1回あたり。無料枠は毎月100万文字）。
   */
  const warmUp = async () => {
    const voices = [DEFAULT_SPEECH_VOICE, ...SPEECH_VOICES.filter((voice) => voice !== DEFAULT_SPEECH_VOICE)];
    for (const voice of voices) {
      for (const text of cacheable) {
        if (!isAvailable()) return;
        await synthesize(text, voice);
      }
    }
  };

  client.auth.getClient().then(
    () => {
      credentialsReady = true;
      publish();
      void warmUp();
    },
    (error: unknown) => {
      log('WARNING', 'tts_not_configured', { errorName: error instanceof Error ? error.name : 'unknown' });
      publish();
    },
  );

  return {
    get available() {
      return isAvailable();
    },
    onAvailabilityChange(listener) {
      events.on('availability', listener);
      return () => events.off('availability', listener);
    },
    synthesize,
    cachedAudio(text, voice) {
      return ready.get(cacheKey(text, voice)) ?? null;
    },
  };
}

/** 環境変数から合成の設定を読む。TTS_ENABLED=false で使わない。 */
export function resolveSynthesizerConfig(
  env: NodeJS.ProcessEnv,
  cacheableTexts: readonly string[],
): CloudSynthesizerConfig | null {
  if (/^(0|false|off|no)$/i.test(env.TTS_ENABLED ?? '')) return null;
  const rate = Number(env.TTS_SPEAKING_RATE);
  const limit = Number(env.TTS_DAILY_CHAR_LIMIT);
  return {
    voices: {
      female: env.TTS_VOICE_FEMALE || 'ja-JP-Chirp3-HD-Aoede',
      male: env.TTS_VOICE_MALE || 'ja-JP-Chirp3-HD-Charon',
    },
    languageCode: 'ja-JP',
    // Chirp 3: HD は 0.25〜2.0。範囲外は既定に戻す。
    speakingRate: rate >= 0.25 && rate <= 2 ? rate : 1,
    dailyCharLimit: limit > 0 ? limit : 50_000,
    cacheableTexts,
  };
}
