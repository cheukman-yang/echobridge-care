import { GoogleGenAI } from '@google/genai';
import type { GenerateContentParameters, GenerateContentResponse, Schema } from '@google/genai';
import type { ZodType } from 'zod';
import type { AiBackend, AiFailureReason, AiMeta, AiStatus } from '../src/lib/aiMeta';

/**
 * GAで応答が速い系統。Vertexでの退役は2027-07-21以降。
 * GEMINI_MODEL で変えるときは、公式のモデルライフサイクル表で退役日を確認すること。
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_EXTRACTION_TIMEOUT_MS = 20_000;

/** 一時的な過負荷だけを、短く1回だけ再試行する。全体の待ち時間はタイムアウトで打ち切る。 */
const RETRY_OPTIONS = {
  attempts: 2,
  initialDelay: 0.25,
  maxDelay: 0.5,
  httpStatusCodes: [429, 500, 502, 503, 504],
};

const BLOCKING_FINISH_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'MODEL_ARMOR',
  'IMAGE_SAFETY',
]);

export interface GeminiConfig {
  backend: AiBackend | null;
  model: string;
  timeoutMs: number;
  extractionTimeoutMs: number;
  project?: string;
  location?: string;
  apiKey?: string;
  /** backend が null の理由。起動時のログ用で、秘密情報は含めない。 */
  problem?: string;
}

type Env = Record<string, string | undefined>;

function isTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveGeminiConfig(env: Env): GeminiConfig {
  const base = {
    model: env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
    timeoutMs: positiveInt(env.GEMINI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    extractionTimeoutMs: positiveInt(env.GEMINI_EXTRACTION_TIMEOUT_MS, DEFAULT_EXTRACTION_TIMEOUT_MS),
  };

  const wantsVertex = isTrue(env.GOOGLE_GENAI_USE_VERTEXAI) || isTrue(env.GOOGLE_GENAI_USE_ENTERPRISE);
  if (wantsVertex) {
    const project = env.GOOGLE_CLOUD_PROJECT?.trim();
    if (!project) {
      // APIキーがあっても切り替えない。意図と違う経路へ通話内容を送らないため。
      return { ...base, backend: null, problem: 'Vertex AIにはGOOGLE_CLOUD_PROJECTが必要です' };
    }
    return {
      ...base,
      backend: 'vertex',
      project,
      location: env.GOOGLE_CLOUD_LOCATION?.trim() || 'global',
    };
  }

  const apiKey = env.GEMINI_API_KEY?.trim();
  if (apiKey) return { ...base, backend: 'api_key', apiKey };

  return { ...base, backend: null, problem: 'Geminiの認証設定がありません' };
}

export type GeminiModels = {
  generateContent(
    params: GenerateContentParameters,
  ): Promise<Pick<GenerateContentResponse, 'text' | 'promptFeedback' | 'candidates'>>;
};

export function createGeminiModels(config: GeminiConfig): GeminiModels | null {
  const httpOptions = { retryOptions: RETRY_OPTIONS };
  if (config.backend === 'vertex') {
    return new GoogleGenAI({
      vertexai: true,
      project: config.project,
      location: config.location,
      httpOptions,
    }).models;
  }
  if (config.backend === 'api_key') {
    return new GoogleGenAI({ vertexai: false, apiKey: config.apiKey, httpOptions }).models;
  }
  return null;
}

export type AiFeature = 'suggestions' | 'polish' | 'appointment';

export interface AiCallLog {
  feature: AiFeature;
  source: AiMeta['source'];
  model: string;
  reason: AiFailureReason | null;
  httpStatus: number | null;
  errorName: string | null;
  latencyMs: number;
}

/**
 * 実AIとフォールバックをログでも区別する。Cloud Loggingが読めるよう1行のJSONで出す。
 * 通話本文を残さないため、プロンプト・応答・エラーメッセージは渡さない。
 */
export function logAiCall(entry: AiCallLog): void {
  const line = JSON.stringify({
    severity: entry.source === 'gemini' ? 'INFO' : 'WARNING',
    message: 'ai_call',
    ...entry,
  });
  if (entry.source === 'gemini') {
    console.log(line);
  } else {
    console.warn(line);
  }
}

function readHttpStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) return null;
  return typeof error.status === 'number' ? error.status : null;
}

export function classifyGeminiError(error: unknown): AiFailureReason {
  const status = readHttpStatus(error);
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model_unavailable';
  if (status === 429) return 'rate_limited';
  if (status === 400) return 'invalid_request';

  // google-auth-library はHTTPステータスのない例外で認証の失敗を知らせる。
  if (error instanceof Error && /credentials|authenticat/i.test(error.message)) return 'auth';
  return 'unavailable';
}

function detectBlocked(response: Awaited<ReturnType<GeminiModels['generateContent']>>): boolean {
  if (response.promptFeedback?.blockReason) return true;
  const finishReason = response.candidates?.[0]?.finishReason;
  return finishReason !== undefined && BLOCKING_FINISH_REASONS.has(finishReason);
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('gemini_timeout')), { once: true });
  });
}

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface JsonRequest<T> {
  feature: AiFeature;
  systemInstruction: string;
  contents: string;
  responseSchema: Schema;
  validator: ZodType<T>;
  timeoutMs: number;
}

export type JsonResult<T> = { ok: true; data: T; ai: AiMeta } | { ok: false; ai: AiMeta };

export interface GeminiRunner {
  status: AiStatus;
  config: GeminiConfig;
  generateJson<T>(request: JsonRequest<T>): Promise<JsonResult<T>>;
}

export interface GeminiRunnerOptions {
  /**
   * サーバー全体で1分間に送れる依頼の上限。公開URLで依頼を繰り返されても、課金に上限ができる。
   * 超えた分は呼ばずに rate_limited のフォールバックにする（画面には定型文と表示される）。
   */
  maxRequestsPerMinute?: number;
}

export const DEFAULT_MAX_REQUESTS_PER_MINUTE = 60;

export function createGeminiRunner(
  config: GeminiConfig,
  models: GeminiModels | null,
  options: GeminiRunnerOptions = {},
): GeminiRunner {
  const maxRequestsPerMinute = options.maxRequestsPerMinute ?? DEFAULT_MAX_REQUESTS_PER_MINUTE;
  const recentRequests: number[] = [];
  const takeRequestSlot = (now: number): boolean => {
    while (recentRequests.length > 0 && now - recentRequests[0] >= 60_000) recentRequests.shift();
    if (recentRequests.length >= maxRequestsPerMinute) return false;
    recentRequests.push(now);
    return true;
  };

  const status: AiStatus = {
    configured: models !== null,
    backend: models ? config.backend : null,
    model: models ? config.model : null,
  };

  async function generateJson<T>(request: JsonRequest<T>): Promise<JsonResult<T>> {
    const startedAt = Date.now();

    const finish = (
      reason: AiFailureReason | null,
      data?: T,
      error?: unknown,
    ): JsonResult<T> => {
      logAiCall({
        feature: request.feature,
        source: reason === null ? 'gemini' : 'fallback',
        model: config.model,
        reason,
        httpStatus: error === undefined ? null : readHttpStatus(error),
        errorName: error instanceof Error ? error.name : null,
        latencyMs: Date.now() - startedAt,
      });
      if (reason === null) {
        return { ok: true, data: data as T, ai: { source: 'gemini', model: config.model } };
      }
      return { ok: false, ai: { source: 'fallback', reason } };
    };

    if (!models) return finish('not_configured');
    if (!takeRequestSlot(startedAt)) return finish('rate_limited');

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);

    try {
      // temperature は新しいモデルで非推奨なので指定しない。thinkingはモデルの既定値を使う。
      const response = await Promise.race([
        models.generateContent({
          model: config.model,
          contents: request.contents,
          config: {
            systemInstruction: request.systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: request.responseSchema,
            abortSignal: controller.signal,
          },
        }),
        rejectOnAbort(controller.signal),
      ]);

      if (detectBlocked(response)) return finish('blocked');

      const validated = request.validator.safeParse(parseJson(response.text));
      if (!validated.success) return finish('invalid_response');
      return finish(null, validated.data);
    } catch (error) {
      return finish(timedOut ? 'timeout' : classifyGeminiError(error), undefined, error);
    } finally {
      clearTimeout(timer);
    }
  }

  return { status, config, generateJson };
}

export function createGeminiRunnerFromEnv(env: Env): GeminiRunner {
  const config = resolveGeminiConfig(env);
  if (config.problem) {
    console.warn(
      JSON.stringify({ severity: 'WARNING', message: 'ai_not_configured', detail: config.problem }),
    );
  }
  return createGeminiRunner(config, createGeminiModels(config), {
    maxRequestsPerMinute: positiveInt(env.GEMINI_MAX_REQUESTS_PER_MINUTE, DEFAULT_MAX_REQUESTS_PER_MINUTE),
  });
}
