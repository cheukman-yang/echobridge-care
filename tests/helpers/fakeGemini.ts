import { vi } from 'vitest';
import type { GenerateContentParameters, Schema } from '@google/genai';
import { createGeminiRunner } from '../../server/geminiClient';
import type { GeminiConfig, GeminiModels, GeminiRunner } from '../../server/geminiClient';

type FakeResponse = Awaited<ReturnType<GeminiModels['generateContent']>>;
type Handler = (params: GenerateContentParameters) => Promise<FakeResponse> | FakeResponse;

export const TEST_MODEL = 'test-model';

export const TEST_CONFIG: GeminiConfig = {
  backend: 'vertex',
  model: TEST_MODEL,
  timeoutMs: 200,
  extractionTimeoutMs: 200,
};

export function jsonReply(data: unknown): FakeResponse {
  return { text: JSON.stringify(data), promptFeedback: undefined, candidates: undefined };
}

export function textReply(text: string | undefined): FakeResponse {
  return { text, promptFeedback: undefined, candidates: undefined };
}

export function createFakeModels(handler: Handler) {
  return { generateContent: vi.fn(async (params: GenerateContentParameters) => handler(params)) };
}

export function createFakeRunner(models: GeminiModels | null, config = TEST_CONFIG): GeminiRunner {
  return createGeminiRunner(config, models);
}

/** Geminiに渡した本文（JSON文字列）を取り出す。 */
export function sentContents(params: GenerateContentParameters): string {
  return String(params.contents);
}

/** どの機能の呼び出しかを、指定された出力スキーマのキーで見分ける。 */
export function requestsField(params: GenerateContentParameters, field: string): boolean {
  const schema = params.config?.responseSchema as Schema | undefined;
  return field in (schema?.properties ?? {});
}

export class HttpError extends Error {
  constructor(public status: number, message = 'request failed') {
    super(message);
  }
}
