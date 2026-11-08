/**
 * AIの結果がどこから来たかを表す共有の型。
 * サーバーとブラウザの両方が使うので、Node専用のAPIに依存させない。
 */

export const AI_FAILURE_REASONS = [
  'not_configured',
  'auth',
  'model_unavailable',
  'rate_limited',
  'timeout',
  'blocked',
  'invalid_request',
  'invalid_response',
  'unavailable',
] as const;

export type AiFailureReason = (typeof AI_FAILURE_REASONS)[number];

/** 実AIの結果か、AIを使えなかった結果かを必ず区別する。 */
export type AiMeta =
  | { source: 'gemini'; model: string }
  | { source: 'fallback'; reason: AiFailureReason };

/** mock は開発用のモックサーバー（scripts/mock-server.ts）。実際のAIは使わない。 */
export type AiBackend = 'vertex' | 'api_key' | 'mock';

/** 開発用のモックが結果に付けるモデル名。画面はこれを見て、AIの結果と区別して表示する。 */
export const MOCK_AI_MODEL = 'mock-dev-only';

/** 開発用のモックの結果か。台本の結果をAIの回答に見せないために使う。 */
export function isMockAi(meta: AiMeta | null | undefined): boolean {
  return meta?.source === 'gemini' && meta.model === MOCK_AI_MODEL;
}

/** サーバーの設定状態。接続の確認ではないので、configured でも実際の呼び出しは失敗し得る。 */
export interface AiStatus {
  configured: boolean;
  backend: AiBackend | null;
  model: string | null;
}

export const AI_FAILURE_LABELS: Record<AiFailureReason, string> = {
  not_configured: 'AIが未設定です',
  auth: 'AIの認証に失敗しました',
  model_unavailable: 'AIモデルを利用できません',
  rate_limited: 'AIの利用上限に達しました',
  timeout: 'AIの応答が時間内に返りませんでした',
  blocked: 'AIが安全上の理由で応答しませんでした',
  invalid_request: 'AIへの要求を受け付けられませんでした',
  invalid_response: 'AIの応答を読み取れませんでした',
  unavailable: 'AIに接続できませんでした',
};
