import { AlertTriangle, Send, Undo2 } from 'lucide-react';
import { AI_FAILURE_LABELS } from '@/lib/aiMeta';
import { MAX_PATIENT_TEXT_LENGTH } from '@/lib/callProtocol';
import { findNumberChanges } from '@/lib/composer';
import type { ComposerState, SpeechChoice } from '@/lib/composer';

type ReviewState = Extract<ComposerState, { phase: 'reviewing' | 'failed' }>;

interface PolishReviewPanelProps {
  state: ReviewState;
  sendDisabled: boolean;
  onEditDraft: (draft: string) => void;
  onSend: (choice: SpeechChoice) => void;
  onClose: () => void;
}

const SECONDARY_BUTTON =
  'w-full bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:pointer-events-none text-slate-100 text-sm font-medium py-2.5 rounded-xl border border-slate-600 transition flex justify-center items-center gap-1.5 active:scale-[0.98]';

function NumberWarning({ original, draft }: { original: string; draft: string }) {
  const { removed, added } = findNumberChanges(original, draft);
  if (removed.length === 0 && added.length === 0) return null;
  return (
    <p
      role="alert"
      className="flex items-start gap-1.5 text-xs leading-snug text-amber-200 bg-amber-500/10 border border-amber-500/40 rounded-lg px-2.5 py-1.5"
    >
      <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" />
      <span>
        数字が原文と違います。日時や数量を確認してください。
        {removed.length > 0 && ` 原文のみ: ${removed.join('、')}`}
        {added.length > 0 && ` 案のみ: ${added.join('、')}`}
      </span>
    </p>
  );
}

/** AIの整形案を本人が確認する画面。ここで押すまで、相手には何も届かない。 */
export function PolishReviewPanel({
  state,
  sendDisabled,
  onEditDraft,
  onSend,
  onClose,
}: PolishReviewPanelProps) {
  const isReviewing = state.phase === 'reviewing';

  return (
    <section aria-label="送信前の確認" className="space-y-2.5">
      {isReviewing ? (
        <p className="text-sm font-bold text-white">AIの案を確認してください</p>
      ) : (
        <p
          role="alert"
          className="flex items-start gap-1.5 text-sm leading-snug text-amber-200 bg-amber-500/10 border border-amber-500/40 rounded-lg px-2.5 py-2"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>
            <strong className="font-bold">AIで整えられませんでした</strong>
            <br />
            {AI_FAILURE_LABELS[state.reason]}。入力した文は変更していません。
          </span>
        </p>
      )}

      <p className="text-xs text-slate-300">まだ相手には届いていません。</p>

      <div>
        <div className="text-xs text-slate-400 mb-1">あなたの入力</div>
        <p
          data-testid="polish-original"
          className="text-sm text-slate-100 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 break-words"
        >
          {state.original}
        </p>
      </div>

      {state.phase === 'reviewing' && (
        <div>
          <label htmlFor="polish-draft" className="flex justify-between gap-2 text-xs text-indigo-300 mb-1">
            <span>AIの案 (編集できます)</span>
            <span className="text-slate-500 truncate">{state.model}</span>
          </label>
          <textarea
            id="polish-draft"
            value={state.draft}
            maxLength={MAX_PATIENT_TEXT_LENGTH}
            onChange={(event) => onEditDraft(event.target.value)}
            rows={3}
            className="w-full bg-slate-900 text-white text-sm leading-relaxed rounded-lg px-3 py-2 resize-none border border-indigo-500/60 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <NumberWarning original={state.original} draft={state.draft} />
        </div>
      )}

      {sendDisabled && (
        <p className="text-xs text-slate-300">相手が話し終わると送信できます。</p>
      )}

      <div className="space-y-2">
        {state.phase === 'reviewing' && (
          <button
            type="button"
            onClick={() => onSend('draft')}
            disabled={sendDisabled || !state.draft.trim()}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:pointer-events-none text-white text-sm font-bold py-2.5 rounded-xl transition flex justify-center items-center gap-1.5 active:scale-[0.98]"
          >
            <Send className="w-4 h-4" />
            この文を送る
          </button>
        )}
        <button
          type="button"
          onClick={() => onSend('original')}
          disabled={sendDisabled}
          className={SECONDARY_BUTTON}
        >
          <Send className="w-4 h-4" />
          入力した文をそのまま送る
        </button>
        <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
          <Undo2 className="w-4 h-4" />
          送らずに入力へ戻る
        </button>
      </div>
    </section>
  );
}
