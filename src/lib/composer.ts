import type { AiFailureReason, AiMeta } from './aiMeta';
import type { SpeechOrigin } from './callProtocol';

/**
 * 手入力の確認フロー。
 * AIの結果は状態を変えるだけで、送信は resolveConfirmedSpeech を本人の操作から呼んだときにしか起きない。
 */
export type ComposerState =
  | { phase: 'editing' }
  | { phase: 'polishing'; requestId: string; original: string }
  | { phase: 'reviewing'; original: string; aiDraft: string; draft: string; model: string }
  | { phase: 'failed'; original: string; reason: AiFailureReason };

export type ComposerAction =
  | { type: 'request'; requestId: string; original: string }
  | { type: 'result'; requestId: string; polished: string | null; ai: AiMeta }
  | { type: 'edit_draft'; draft: string }
  | { type: 'connection_lost' }
  | { type: 'close' };

export const INITIAL_COMPOSER: ComposerState = { phase: 'editing' };

export function composerReducer(state: ComposerState, action: ComposerAction): ComposerState {
  switch (action.type) {
    case 'request':
      return state.phase === 'editing'
        ? { phase: 'polishing', requestId: action.requestId, original: action.original }
        : state;

    case 'result': {
      // 取り消し済みや古い依頼の結果は捨てる。
      if (state.phase !== 'polishing' || state.requestId !== action.requestId) return state;
      const { original } = state;
      if (action.ai.source === 'gemini' && action.polished) {
        return {
          phase: 'reviewing',
          original,
          aiDraft: action.polished,
          draft: action.polished,
          model: action.ai.model,
        };
      }
      const reason = action.ai.source === 'fallback' ? action.ai.reason : 'invalid_response';
      return { phase: 'failed', original, reason };
    }

    case 'edit_draft':
      return state.phase === 'reviewing' ? { ...state, draft: action.draft } : state;

    case 'connection_lost':
      return state.phase === 'polishing'
        ? { phase: 'failed', original: state.original, reason: 'unavailable' }
        : state;

    case 'close':
      return INITIAL_COMPOSER;
  }
}

export type SpeechChoice = 'draft' | 'original';

export interface ConfirmedSpeech {
  text: string;
  origin: SpeechOrigin;
}

/** 本人が押したボタンに対応する文を、書き換えずに取り出す。送れないときは null。 */
export function resolveConfirmedSpeech(
  state: ComposerState,
  choice: SpeechChoice,
): ConfirmedSpeech | null {
  if (state.phase !== 'reviewing' && state.phase !== 'failed') return null;

  if (choice === 'original') {
    return { text: state.original, origin: 'typed' };
  }
  if (state.phase !== 'reviewing') return null;

  const text = state.draft.trim();
  if (!text) return null;
  return { text, origin: text === state.aiDraft.trim() ? 'ai_reviewed' : 'ai_edited' };
}

export interface NumberChanges {
  /** 原文にあって案にない数字 */
  removed: string[];
  /** 案にあって原文にない数字 */
  added: string[];
}

function extractNumbers(text: string): string[] {
  const halfWidth = text.replace(/[０-９]/g, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
  );
  return halfWidth.match(/\d+/g) ?? [];
}

function subtract(from: string[], other: string[]): string[] {
  const rest = [...other];
  return from.filter((value) => {
    const index = rest.indexOf(value);
    if (index === -1) return true;
    rest.splice(index, 1);
    return false;
  });
}

/**
 * 日時や数量の取り違えは実害が大きいので、数字の増減だけを本人に知らせる。
 * 送信は止めない。「15時」と「午後3時」のように同じ意味でも知らせるのは、確認を促す目的のため。
 */
export function findNumberChanges(original: string, draft: string): NumberChanges {
  const before = extractNumbers(original);
  const after = extractNumbers(draft);
  return { removed: subtract(before, after), added: subtract(after, before) };
}
