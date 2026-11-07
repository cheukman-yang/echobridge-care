import { ApiError, Type } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_GEMINI_MODEL,
  classifyGeminiError,
  createGeminiModels,
  resolveGeminiConfig,
} from '../../server/geminiClient';
import type { JsonRequest } from '../../server/geminiClient';
import {
  HttpError,
  TEST_MODEL,
  createFakeModels,
  createFakeRunner,
  jsonReply,
  textReply,
} from '../helpers/fakeGemini';

const request: JsonRequest<{ value: string }> = {
  feature: 'polish',
  systemInstruction: 'instruction',
  contents: '架空の通話本文',
  responseSchema: { type: Type.OBJECT },
  validator: z.object({ value: z.string() }),
  timeoutMs: 100,
};

describe('resolveGeminiConfig', () => {
  it('Vertex AIは global を既定にする', () => {
    const config = resolveGeminiConfig({
      GOOGLE_GENAI_USE_VERTEXAI: 'true',
      GOOGLE_CLOUD_PROJECT: 'demo-project',
    });

    expect(config).toMatchObject({
      backend: 'vertex',
      project: 'demo-project',
      location: 'global',
      model: DEFAULT_GEMINI_MODEL,
    });
  });

  it('公式クイックスタートの環境変数でもVertex AIになる', () => {
    const config = resolveGeminiConfig({
      GOOGLE_GENAI_USE_ENTERPRISE: 'True',
      GOOGLE_CLOUD_PROJECT: 'demo-project',
      GOOGLE_CLOUD_LOCATION: 'us',
    });

    expect(config).toMatchObject({ backend: 'vertex', location: 'us' });
  });

  it('Vertex AI指定でプロジェクトがなければ、APIキーへ切り替えない', () => {
    const config = resolveGeminiConfig({
      GOOGLE_GENAI_USE_VERTEXAI: 'true',
      GEMINI_API_KEY: 'dummy',
    });

    expect(config.backend).toBeNull();
    expect(config.problem).toContain('GOOGLE_CLOUD_PROJECT');
  });

  it('APIキーだけならDeveloper APIを使う', () => {
    expect(resolveGeminiConfig({ GEMINI_API_KEY: 'dummy' }).backend).toBe('api_key');
  });

  it('何も設定がなければ未設定として扱う', () => {
    expect(resolveGeminiConfig({}).backend).toBeNull();
  });

  it('モデルとタイムアウトを環境変数で変えられる', () => {
    const config = resolveGeminiConfig({
      GEMINI_API_KEY: 'dummy',
      GEMINI_MODEL: 'gemini-3.8-flash',
      GEMINI_TIMEOUT_MS: '1500',
      GEMINI_EXTRACTION_TIMEOUT_MS: 'abc',
    });

    expect(config.model).toBe('gemini-3.8-flash');
    expect(config.timeoutMs).toBe(1500);
    expect(config.extractionTimeoutMs).toBe(20_000);
  });

  it('既定モデルが退役済み・退役間近のモデルではない', () => {
    expect(DEFAULT_GEMINI_MODEL).not.toMatch(/^gemini-(1\.|2\.|3\.6-flash)/);
  });
});

describe('createGeminiModels', () => {
  type ModelsInternals = {
    apiClient: { isVertexAI(): boolean; getProject(): string; getLocation(): string };
  };

  it('公式SDKをVertex AIのモードで初期化する', () => {
    const config = resolveGeminiConfig({
      GOOGLE_GENAI_USE_VERTEXAI: 'true',
      GOOGLE_CLOUD_PROJECT: 'demo-project',
    });

    const models = createGeminiModels(config) as unknown as ModelsInternals;

    expect(models.apiClient.isVertexAI()).toBe(true);
    expect(models.apiClient.getProject()).toBe('demo-project');
    expect(models.apiClient.getLocation()).toBe('global');
  });

  it('APIキーの経路はVertex AIにならない', () => {
    const config = resolveGeminiConfig({ GEMINI_API_KEY: 'dummy' });

    const models = createGeminiModels(config) as unknown as ModelsInternals;

    expect(models.apiClient.isVertexAI()).toBe(false);
  });

  it('未設定ならクライアントを作らない', () => {
    expect(createGeminiModels(resolveGeminiConfig({}))).toBeNull();
  });
});

describe('classifyGeminiError', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [404, 'model_unavailable'],
    [429, 'rate_limited'],
    [400, 'invalid_request'],
    [503, 'unavailable'],
  ])('SDKの ApiError %i を %s に分類する', (status, reason) => {
    expect(classifyGeminiError(new ApiError({ status, message: 'failed' }))).toBe(reason);
  });

  it('認証情報がないときの例外を auth にする', () => {
    const error = new Error('Could not load the default credentials.');

    expect(classifyGeminiError(error)).toBe('auth');
  });

  it('その他の例外は unavailable にする', () => {
    expect(classifyGeminiError(new Error('socket hang up'))).toBe('unavailable');
  });
});

describe('generateJson', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const lastLog = (spy: typeof logSpy) => JSON.parse(String(spy.mock.calls.at(-1)?.[0]));

  it('成功すると gemini とモデル名を返す', async () => {
    const runner = createFakeRunner(createFakeModels(() => jsonReply({ value: 'ok' })));

    const result = await runner.generateJson(request);

    expect(result).toEqual({
      ok: true,
      data: { value: 'ok' },
      ai: { source: 'gemini', model: TEST_MODEL },
    });
  });

  it('JSONとスキーマを指定し、非推奨のtemperatureを送らない', async () => {
    const models = createFakeModels(() => jsonReply({ value: 'ok' }));

    await createFakeRunner(models).generateJson(request);

    const params = models.generateContent.mock.calls[0][0];
    expect(params.model).toBe(TEST_MODEL);
    expect(params.config).toMatchObject({
      systemInstruction: 'instruction',
      responseMimeType: 'application/json',
      responseSchema: request.responseSchema,
    });
    expect(params.config?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(params.config).not.toHaveProperty('temperature');
  });

  it('未設定なら呼び出さず not_configured を返す', async () => {
    const result = await createFakeRunner(null).generateJson(request);

    expect(result).toEqual({ ok: false, ai: { source: 'fallback', reason: 'not_configured' } });
    expect(lastLog(warnSpy)).toMatchObject({ severity: 'WARNING', reason: 'not_configured' });
  });

  it('応答がなければ打ち切って timeout を返し、通信も中止する', async () => {
    let signal: AbortSignal | undefined;
    const models = createFakeModels((params) => {
      signal = params.config?.abortSignal;
      return new Promise(() => {});
    });

    const result = await createFakeRunner(models).generateJson({ ...request, timeoutMs: 10 });

    expect(result).toEqual({ ok: false, ai: { source: 'fallback', reason: 'timeout' } });
    expect(signal?.aborted).toBe(true);
  });

  it('プロンプトがブロックされたら blocked を返す', async () => {
    const models = createFakeModels(() => ({
      ...textReply(undefined),
      promptFeedback: { blockReason: 'SAFETY' as never },
    }));

    const result = await createFakeRunner(models).generateJson(request);

    expect(result).toEqual({ ok: false, ai: { source: 'fallback', reason: 'blocked' } });
  });

  it('安全上の理由で生成が止まったら blocked を返す', async () => {
    const models = createFakeModels(() => ({
      ...textReply('{"value":"途中'),
      candidates: [{ finishReason: 'SAFETY' as never }],
    }));

    const result = await createFakeRunner(models).generateJson(request);

    expect(result).toEqual({ ok: false, ai: { source: 'fallback', reason: 'blocked' } });
  });

  it.each([
    ['JSONでない応答', textReply('こんにちは')],
    ['空の応答', textReply(undefined)],
    ['スキーマ違反', jsonReply({ value: 1 })],
  ])('%sは invalid_response を返す', async (_, reply) => {
    const result = await createFakeRunner(createFakeModels(() => reply)).generateJson(request);

    expect(result).toEqual({ ok: false, ai: { source: 'fallback', reason: 'invalid_response' } });
  });

  it('APIの失敗を分類し、HTTPステータスをログに残す', async () => {
    const models = createFakeModels(() => {
      throw new HttpError(404);
    });

    const result = await createFakeRunner(models).generateJson(request);

    expect(result).toEqual({ ok: false, ai: { source: 'fallback', reason: 'model_unavailable' } });
    expect(lastLog(warnSpy)).toMatchObject({
      message: 'ai_call',
      source: 'fallback',
      reason: 'model_unavailable',
      httpStatus: 404,
      feature: 'polish',
    });
  });

  it('成功のログに gemini とモデル名を残す', async () => {
    await createFakeRunner(createFakeModels(() => jsonReply({ value: 'ok' }))).generateJson(request);

    expect(lastLog(logSpy)).toMatchObject({
      severity: 'INFO',
      source: 'gemini',
      model: TEST_MODEL,
      reason: null,
    });
  });

  it('ログに本文やエラーメッセージを出さない', async () => {
    const secret = '架空の通話本文';
    const models = createFakeModels(() => {
      throw new HttpError(500, `failed with ${secret}`);
    });

    await createFakeRunner(models).generateJson(request);

    const output = [...logSpy.mock.calls, ...warnSpy.mock.calls].flat().join('\n');
    expect(output).toContain('ai_call');
    expect(output).not.toContain(secret);
  });
});
