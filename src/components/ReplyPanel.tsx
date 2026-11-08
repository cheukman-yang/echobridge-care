import type { KeyboardEvent } from 'react';
import { CalendarDays, LoaderCircle, Send, Sparkles } from 'lucide-react';
import { buildCalendarDayUrl } from '@/lib/appointment';
import type { AiMeta } from '@/lib/aiMeta';
import { MAX_PATIENT_TEXT_LENGTH } from '@/lib/callProtocol';
import type { SuggestionItem } from '@/lib/callProtocol';
import type { ComposerState, SpeechChoice } from '@/lib/composer';
import { QUICK_PHRASES } from '@/lib/quickPhrases';
import { SuggestionSourceNote } from './AiStatusBadge';
import { CustomPhrasesSection } from './CustomPhrases';
import { PolishReviewPanel } from './PolishReviewPanel';
import { SectionHeading, buttonClass, cx } from './ui';

interface ReplyPanelProps {
  partnerLabel: string;
  latestPartnerText: string | null;
  isPartnerSpeaking: boolean;
  isGenerating: boolean;
  suggestions: SuggestionItem[];
  suggestionsAi: AiMeta | null;
  composer: ComposerState;
  input: string;
  sendError: string | null;
  onInputChange(value: string): void;
  onInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
  onRequestPolish(): void;
  onCancelPolish(): void;
  onSendTyped(): void;
  onSendSuggestion(text: string): void;
  onSendQuickPhrase(text: string): void;
  onSendCustomPhrase(text: string): void;
  onEditDraft(draft: string): void;
  onReviewSend(choice: SpeechChoice): void;
  onCloseReview(): void;
}

function SuggestionSkeleton() {
  return (
    <div className="space-y-2" aria-hidden>
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-[60px] rounded-lg border border-line bg-subtle" />
      ))}
    </div>
  );
}

/**
 * 返答の操作をまとめた欄。速く返せる順（AI候補 → 即答 → 入力）に並べる。
 * どの経路でも、表示している文がそのまま読み上げられる。
 */
export function ReplyPanel(props: ReplyPanelProps) {
  const {
    partnerLabel,
    latestPartnerText,
    isPartnerSpeaking,
    isGenerating,
    suggestions,
    suggestionsAi,
    composer,
    input,
    sendError,
  } = props;

  const isReviewing = composer.phase === 'reviewing' || composer.phase === 'failed';
  const isPolishing = composer.phase === 'polishing';
  const canSend = !isPartnerSpeaking;
  const canWrite = !isPolishing;
  const hasInput = input.trim().length > 0;

  // 即答フレーズはスクロールの外の下端に固定し、AI案の確認中も押せるようにする。
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 pb-5 lg:px-6 lg:pt-6">
        {isReviewing ? (
          <PolishReviewPanel
            state={composer}
            sendDisabled={isPartnerSpeaking}
            onEditDraft={props.onEditDraft}
            onSend={props.onReviewSend}
            onClose={props.onCloseReview}
          />
        ) : (
          <div className="space-y-6">
            {latestPartnerText && (
              <figure className="max-lg:hidden">
                <figcaption className="text-[13px] font-bold text-ink-2">{partnerLabel}の最新の発言</figcaption>
                <blockquote className="mt-1.5 border-l-4 border-line-strong pl-3.5 text-[20px] leading-(--leading-talk) text-ink text-pretty break-words">
                  {latestPartnerText}
                </blockquote>
              </figure>
            )}

            {/* 狭い画面では、すぐ上の会話の記録に同じ表示があるので出さない。 */}
            {isPartnerSpeaking && (
              <p className="flex items-center gap-2 rounded-lg bg-subtle px-3.5 py-2.5 text-[14px] text-ink max-lg:hidden">
                <span aria-hidden className="eb-live-dot size-2 shrink-0 rounded-full bg-danger" />
                {partnerLabel}が話しています。話し終わると送信できます。
              </p>
            )}

            <section aria-labelledby="suggestions-heading" className="space-y-2.5">
              <SectionHeading id="suggestions-heading">返答候補</SectionHeading>
              {isGenerating ? (
                <>
                  <p className="flex items-center gap-2 text-[13px] text-ink-2">
                    <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
                    返答候補を準備中...
                  </p>
                  <SuggestionSkeleton />
                </>
              ) : suggestions.length > 0 ? (
                <>
                  <SuggestionSourceNote ai={suggestionsAi} />
                  <div className="grid gap-2">
                    {suggestions.map((suggestion, index) => (
                      <button
                        key={`${index}-${suggestion.text}`}
                        type="button"
                        onClick={() => props.onSendSuggestion(suggestion.text)}
                        disabled={!canSend}
                        className="flex w-full flex-col items-start gap-1 rounded-lg border border-line-strong bg-surface px-4 py-3 text-left transition-colors duration-150 hover:border-voice hover:bg-voice-soft disabled:cursor-not-allowed disabled:border-line disabled:bg-subtle disabled:text-ink-2 disabled:hover:bg-subtle"
                      >
                        <span className="text-[16px] leading-snug text-pretty">{suggestion.text}</span>
                        {suggestion.tag && <span className="text-[12px] text-ink-2">{suggestion.tag}</span>}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-[14px] leading-relaxed text-ink-2">
                  相手が話し終えると、ここに3つの候補が出ます。
                </p>
              )}
              {/* 日時を提案されたときに、自分の予定を確かめられるようにする。EchoBridgeは予定を読まない。 */}
              <a
                href={buildCalendarDayUrl(null)}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonClass('quiet', 'md', '-ml-4')}
              >
                <CalendarDays className="size-4" aria-hidden />
                自分の予定をGoogleカレンダーで見る
              </a>
            </section>


            <section className="space-y-2.5">
              <label htmlFor="reply-input" className="block text-[15px] font-bold">
                相手に伝える文
              </label>
              <textarea
                id="reply-input"
                aria-describedby="reply-input-hint"
                value={input}
                rows={2}
                maxLength={MAX_PATIENT_TEXT_LENGTH}
                disabled={!canWrite}
                onChange={(event) => props.onInputChange(event.target.value)}
                onKeyDown={props.onInputKeyDown}
                placeholder="伝えたいことを入力"
                className="field-sizing-content block max-h-40 min-h-[3.5rem] w-full resize-none rounded-lg border border-line-strong bg-surface px-3.5 py-2.5 text-[17px] leading-relaxed text-ink placeholder:text-ink-2/70 focus:border-voice disabled:bg-subtle"
              />
              <p id="reply-input-hint" className="text-[13px] text-ink-2">
                Enterで「AIで整える」。整えた文は送る前に確認できます。
              </p>

              {isPolishing ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-subtle px-3.5 py-2">
                  <p className="flex items-center gap-2 text-[14px] text-ink">
                    <Sparkles className="size-4 text-voice" aria-hidden />
                    AIが案を作っています（まだ送信されません）
                  </p>
                  <button type="button" onClick={props.onCancelPolish} className={buttonClass('quiet', 'md')}>
                    やめる
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={props.onRequestPolish}
                    disabled={!hasInput}
                    className={buttonClass('secondary', 'md')}
                  >
                    <Sparkles className="size-4" aria-hidden />
                    AIで整える
                  </button>
                  <button
                    type="button"
                    onClick={props.onSendTyped}
                    disabled={!hasInput || !canSend}
                    className={buttonClass('primary', 'md')}
                  >
                    <Send className="size-4" aria-hidden />
                    そのまま送る
                  </button>
                </div>
              )}
              {isPartnerSpeaking && hasInput && !isPolishing && (
                <p className="text-[13px] text-ink-2">{partnerLabel}が話し終わると送信できます。</p>
              )}
              {sendError && (
                <p role="alert" className={cx('text-[14px] font-bold text-danger')}>
                  {sendError}
                </p>
              )}
            </section>

            <CustomPhrasesSection
              mode="call"
              canSend={canSend}
              partnerLabel={partnerLabel}
              onSend={props.onSendCustomPhrase}
            />
          </div>
        )}
      </div>

      <QuickPhraseBar disabled={!canSend} partnerLabel={partnerLabel} onSend={props.onSendQuickPhrase} />
    </div>
  );
}

/**
 * 会話を続けるための定型の返事。時間をもらう文と聞き返しを先頭に置く。
 * 狭い画面では1列で横に流し、返答欄の高さを取りすぎないようにする。
 */
function QuickPhraseBar({
  disabled,
  partnerLabel,
  onSend,
}: {
  disabled: boolean;
  partnerLabel: string;
  onSend(text: string): void;
}) {
  return (
    <div
      role="group"
      aria-labelledby="quick-heading"
      className="shrink-0 border-t border-line bg-surface px-4 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:px-6 lg:pt-3 lg:pb-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id="quick-heading" className="text-[14px] font-bold text-ink">
          即答フレーズ
        </h2>
        <p className="text-[12px] text-ink-2">
          {disabled ? `${partnerLabel}が話し終えると送れます` : 'AIを待たずに、表示どおりに送ります'}
        </p>
      </div>
      <div className="eb-scroll-row -mx-4 mt-2 flex gap-2 overflow-x-auto px-4 pb-0.5 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0">
        {QUICK_PHRASES.map((phrase) => (
          <button
            key={phrase}
            type="button"
            onClick={() => onSend(phrase)}
            disabled={disabled}
            className="min-h-11 shrink-0 rounded-full border border-line-strong bg-surface px-4 text-[15px] whitespace-nowrap transition-colors duration-150 hover:border-voice hover:bg-voice-soft disabled:cursor-not-allowed disabled:border-line disabled:bg-subtle disabled:text-ink-2 lg:min-h-10 lg:px-3.5 lg:text-[14px]"
          >
            {phrase}
          </button>
        ))}
      </div>
    </div>
  );
}
