import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCloudSynthesizer,
  resolveSynthesizerConfig,
  synthesisTimeoutMs,
} from '../../server/speechSynthesizer';
import type { CloudSynthesizerConfig, TtsClientLike } from '../../server/speechSynthesizer';

type Request = Parameters<TtsClientLike['synthesizeSpeech']>[0];

function makeClient(options: { auth?: Promise<unknown> } = {}) {
  const requests: Request[] = [];
  let respond: (request: Request) => Promise<[{ audioContent?: Uint8Array | string | null }]> = async (request) => [
    { audioContent: new TextEncoder().encode(`mp3:${request.input.text.length}`) },
  ];
  const client: TtsClientLike = {
    auth: { getClient: () => options.auth ?? Promise.resolve({}) },
    synthesizeSpeech: vi.fn(async (request: Request) => {
      requests.push(request);
      return respond(request);
    }) as unknown as TtsClientLike['synthesizeSpeech'],
  };
  return {
    client,
    requests,
    setRespond: (next: typeof respond) => (respond = next),
  };
}

const CONFIG: CloudSynthesizerConfig = {
  voices: { female: 'ja-JP-Chirp3-HD-Aoede', male: 'ja-JP-Chirp3-HD-Charon' },
  languageCode: 'ja-JP',
  speakingRate: 1,
  dailyCharLimit: 1_000,
  cacheableTexts: [],
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Cloud Text-to-Speech の合成', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(String(line)));
    vi.spyOn(console, 'warn').mockImplementation((line: string) => logs.push(String(line)));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('認証を確かめるまでは使えないとし、確かめたら知らせる', async () => {
    const { client } = makeClient();
    const tts = createCloudSynthesizer(client, CONFIG);
    const changes: boolean[] = [];
    tts.onAvailabilityChange((available) => changes.push(available));
    expect(tts.available).toBe(false);

    await flush();

    expect(tts.available).toBe(true);
    expect(changes).toEqual([true]);
  });

  it('認証がなければ使えないままで、合成を呼ばない', async () => {
    const { client, requests } = makeClient({ auth: Promise.reject(new Error('no credentials')) });
    const tts = createCloudSynthesizer(client, CONFIG);
    await flush();

    expect(tts.available).toBe(false);
    expect(await tts.synthesize('本人の文', 'female')).toEqual({ ok: false, reason: 'unavailable' });
    expect(requests).toEqual([]);
  });

  it('選んだ声とMP3で合成し、base64で返す。ログに本文を出さない', async () => {
    const { client, requests } = makeClient();
    const tts = createCloudSynthesizer(client, CONFIG);
    await flush();

    const outcome = await tts.synthesize('架空の文です', 'male');

    expect(requests[0]).toEqual({
      input: { text: '架空の文です' },
      voice: { languageCode: 'ja-JP', name: 'ja-JP-Chirp3-HD-Charon' },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1 },
    });
    expect(outcome).toEqual({
      ok: true,
      cached: false,
      audio: Buffer.from('mp3:6').toString('base64'),
      mimeType: 'audio/mpeg',
    });
    expect(logs.join('\n')).not.toContain('架空の文です');
    expect(logs.some((line) => line.includes('"tts_synthesized"') && line.includes('"chars":6'))).toBe(true);
  });

  it('1日の文字数の上限を超えたら合成しない', async () => {
    const { client, requests } = makeClient();
    const tts = createCloudSynthesizer(client, { ...CONFIG, dailyCharLimit: 10 });
    await flush();

    expect((await tts.synthesize('あ'.repeat(8), 'female')).ok).toBe(true);
    expect(await tts.synthesize('あ'.repeat(3), 'female')).toEqual({ ok: false, reason: 'quota' });
    expect(requests).toHaveLength(1);
  });

  it('日本時間で日が変わったら、上限を数え直す', async () => {
    let now = Date.parse('2026-11-08T14:00:00Z'); // 日本時間 23:00
    const { client } = makeClient();
    const tts = createCloudSynthesizer(client, { ...CONFIG, dailyCharLimit: 10, now: () => now });
    await flush();
    await tts.synthesize('あ'.repeat(10), 'female');
    expect((await tts.synthesize('い', 'female')).ok).toBe(false);

    now = Date.parse('2026-11-08T15:30:00Z'); // 日本時間 翌日 0:30

    expect((await tts.synthesize('い', 'female')).ok).toBe(true);
  });

  it('権限やAPIの無効で断られたら、しばらく使えないとし、時間がたてば試し直す', async () => {
    let now = 1_000_000;
    const { client, requests, setRespond } = makeClient();
    const tts = createCloudSynthesizer(client, { ...CONFIG, unavailableCooldownMs: 60_000, now: () => now });
    const changes: boolean[] = [];
    tts.onAvailabilityChange((available) => changes.push(available));
    await flush();
    setRespond(async () => {
      throw Object.assign(new Error('PERMISSION_DENIED'), { code: 7 });
    });

    expect(await tts.synthesize('本人の文', 'female')).toEqual({ ok: false, reason: 'unavailable' });
    expect(tts.available).toBe(false);
    expect(await tts.synthesize('次の文', 'female')).toEqual({ ok: false, reason: 'unavailable' });
    expect(requests).toHaveLength(1);

    now += 60_000;
    expect(tts.available).toBe(true);
    expect(changes).toEqual([true, false]);
  });

  it('そのほかの失敗は1文だけの失敗として返し、使えないことにはしない', async () => {
    const { client, setRespond } = makeClient();
    const tts = createCloudSynthesizer(client, CONFIG);
    await flush();
    setRespond(async () => {
      throw Object.assign(new Error('INTERNAL'), { code: 13 });
    });

    expect(await tts.synthesize('本人の文', 'female')).toEqual({ ok: false, reason: 'error' });
    expect(tts.available).toBe(true);
  });

  it('時間内に返らなければ時間切れとして返す', async () => {
    const { client, setRespond } = makeClient();
    const tts = createCloudSynthesizer(client, CONFIG);
    await flush();
    vi.useFakeTimers();
    setRespond(() => new Promise(() => {}));

    const pending = tts.synthesize('本人の文', 'female');
    await vi.advanceTimersByTimeAsync(synthesisTimeoutMs('本人の文'));

    expect(await pending).toEqual({ ok: false, reason: 'timeout' });
  });

  it('決まった文は起動時に作っておき、待たずに返す。作り直さない', async () => {
    const { client, requests } = makeClient();
    const tts = createCloudSynthesizer(client, { ...CONFIG, cacheableTexts: ['はい。', 'いいえ。'] });
    await flush();
    await flush();

    // 既定の声（女性）を先に、もう一方の声も作っておく。
    await flush();
    await flush();
    expect(requests.map((request) => `${request.voice.name}:${request.input.text}`)).toEqual([
      'ja-JP-Chirp3-HD-Aoede:はい。',
      'ja-JP-Chirp3-HD-Aoede:いいえ。',
      'ja-JP-Chirp3-HD-Charon:はい。',
      'ja-JP-Chirp3-HD-Charon:いいえ。',
    ]);
    expect(tts.cachedAudio('はい。', 'female')).toEqual({
      audio: Buffer.from('mp3:3').toString('base64'),
      mimeType: 'audio/mpeg',
    });
    expect((await tts.synthesize('はい。', 'female')).ok).toBe(true);
    expect(requests).toHaveLength(4);
    // 本人が入力した文は残さない。
    await tts.synthesize('個人的な文', 'female');
    expect(tts.cachedAudio('個人的な文', 'female')).toBeNull();
  });

  it('合成の待ち時間は文の長さに比例し、上限がある', () => {
    expect(synthesisTimeoutMs('あ'.repeat(10))).toBe(3_400);
    expect(synthesisTimeoutMs('あ'.repeat(300))).toBe(15_000);
  });
});

/** テストで渡す環境変数。NODE_ENV などは使わないので省く。 */
const env = (values: Record<string, string> = {}) => values as unknown as NodeJS.ProcessEnv;

describe('音声合成の設定', () => {
  it('既定は Chirp 3: HD の女性と男性の声、話す速さ1、1日5万文字', () => {
    expect(resolveSynthesizerConfig(env(), ['はい。'])).toEqual({
      voices: { female: 'ja-JP-Chirp3-HD-Aoede', male: 'ja-JP-Chirp3-HD-Charon' },
      languageCode: 'ja-JP',
      speakingRate: 1,
      dailyCharLimit: 50_000,
      cacheableTexts: ['はい。'],
    });
  });

  it('TTS_ENABLED=false なら使わない', () => {
    expect(resolveSynthesizerConfig(env({ TTS_ENABLED: 'false' }), [])).toBeNull();
    expect(resolveSynthesizerConfig(env({ TTS_ENABLED: '0' }), [])).toBeNull();
  });

  it('環境変数で声・速さ・上限を変えられ、範囲外の速さは既定に戻す', () => {
    const config = resolveSynthesizerConfig(
      env({
        TTS_VOICE_FEMALE: 'ja-JP-Chirp3-HD-Kore',
        TTS_SPEAKING_RATE: '0.9',
        TTS_DAILY_CHAR_LIMIT: '1000',
      }),
      [],
    );
    expect(config).toMatchObject({
      voices: { female: 'ja-JP-Chirp3-HD-Kore', male: 'ja-JP-Chirp3-HD-Charon' },
      speakingRate: 0.9,
      dailyCharLimit: 1_000,
    });
    expect(resolveSynthesizerConfig(env({ TTS_SPEAKING_RATE: '5' }), [])?.speakingRate).toBe(1);
  });
});
