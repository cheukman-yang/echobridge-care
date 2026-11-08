import { Send, Undo2 } from 'lucide-react';
import { AI_FAILURE_LABELS, MOCK_AI_MODEL } from '@/lib/aiMeta';
import { MAX_PATIENT_TEXT_LENGTH } from '@/lib/callProtocol';
import { findNumberChanges } from '@/lib/composer';
import type { ComposerState, SpeechChoice } from '@/lib/composer';
import { Notice, buttonClass } from './ui';

type ReviewState = Extract<ComposerState, { phase: 'reviewing' | 'failed' }>;

interface PolishReviewPanelProps {
  state: ReviewState;
  sendDisabled: boolean;
  onEditDraft: (draft: string) => void;
  onSend: (choice: SpeechChoice) => void;
  onClose: () => void;
}

function NumberWarning({ original, draft }: { original: string; draft: string }) {
  const { removed, added } = findNumberChanges(original, draft);
  if (removed.length === 0 && added.length === 0) return null;
  return (
    <Notice tone="caution" role="alert" className="mt-2">
      数字が原文と違います。日時や数量を確認してください。
      {removed.length > 0 && ` 原文のみ: ${removed.join('、')}`}
      {added.length > 0 && ` 案のみ: ${added.join('、')}`}
    </Notice>
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
    <section aria-label="送信前の確認" className="space-y-4">
      {isReviewing ? (
        <h2 className="text-[17px] font-bold">
          {state.model === MOCK_AI_MODEL ? 'モックの案を確認してください（開発用・AIではありません）' : 'AIの案を確認してください'}
        </h2>
      ) : (
        <Notice tone="caution" role="alert" title="AIで整えられませんでした">
          {AI_FAILURE_LABELS[state.reason]}。入力した文は変更していません。
        </Notice>
      )}

      <p className="text-[14px] font-bold text-voice-strong">まだ相手には届いていません。</p>

      <div className="space-y-1.5">
        <p className="text-[13px] font-bold text-ink-2">あなたの入力</p>
        <p
          data-testid="polish-original"
          className="rounded-lg bg-subtle px-3.5 py-2.5 text-[16px] leading-relaxed text-ink break-words"
        >
          {state.original}
        </p>
      </div>

      {state.phase === 'reviewing' && (
        <div className="space-y-1.5">
          <label
            htmlFor="polish-draft"
            className="flex flex-wrap justify-between gap-x-2 text-[13px] font-bold text-ink-2"
          >
            <span>AIの案（編集できます）</span>
            <span className="truncate font-normal">{state.model}</span>
          </label>
          <textarea
            id="polish-draft"
            value={state.draft}
            maxLength={MAX_PATIENT_TEXT_LENGTH}
            onChange={(event) => onEditDraft(event.target.value)}
            rows={3}
            className="w-full resize-none rounded-lg border-2 border-voice bg-surface px-3.5 py-2.5 text-[17px] leading-relaxed text-ink"
          />
          <NumberWarning original={state.original} draft={state.draft} />
        </div>
      )}

      {sendDisabled && <p className="text-[14px] text-ink-2">相手が話し終わると送信できます。</p>}

      <div className="grid gap-2">
        {state.phase === 'reviewing' && (
          <button
            type="button"
            onClick={() => onSend('draft')}
            disabled={sendDisabled || !state.draft.trim()}
            className={buttonClass('primary', 'lg', 'w-full')}
          >
            <Send className="size-4" aria-hidden />
            この文を送る
          </button>
        )}
        <button
          type="button"
          onClick={() => onSend('original')}
          disabled={sendDisabled}
          className={buttonClass(state.phase === 'reviewing' ? 'secondary' : 'primary', 'md', 'w-full')}
        >
          <Send className="size-4" aria-hidden />
          入力した文をそのまま送る
        </button>
        <button type="button" onClick={onClose} className={buttonClass('quiet', 'md', 'w-full')}>
          <Undo2 className="size-4" aria-hidden />
          送らずに入力へ戻る
        </button>
      </div>
    </section>
  );
}
