import type { KeyboardEvent } from 'react';
import { CalendarDays, LoaderCircle, Send, Sparkles, X } from 'lucide-react';
import { buildCalendarDayUrl } from '@/lib/appointment';
import type { AiMeta } from '@/lib/aiMeta';
import { MAX_PATIENT_TEXT_LENGTH } from '@/lib/callProtocol';
import type { SuggestionItem } from '@/lib/callProtocol';
import type { ComposerState, SpeechChoice } from '@/lib/composer';
import { QUICK_PHRASES } from '@/lib/quickPhrases';
import { SuggestionSourceNote } from './AiStatusBadge';
import { PolishReviewPanel } from './PolishReviewPanel';
import { SectionHeading, buttonClass, cx } from './ui';

/**
 * 返答の部品。並べ方（広い画面で同時に見せるか、狭い画面で切り替えるか）は CallWorkspace が決める。
 * どの部品でも、表示している文がそのまま読み上げられる。部品は状態を持たず、切り替えても入力は消えない。
 */

function SuggestionSkeleton() {
  return (
    <div className="space-y-2" aria-hidden>
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-[68px] rounded-lg border border-line bg-subtle" />
      ))}
    </div>
  );
}

/** 広い画面の右列の先頭。候補が何への返事かを、相手の言葉で示す。 */
export function LatestPartnerUtterance({
  partnerLabel,
  text,
  isPartnerSpeaking,
}: {
  partnerLabel: string;
  text: string | null;
  isPartnerSpeaking: boolean;
}) {
  if (!text && !isPartnerSpeaking) return null;
  return (
    <div className="space-y-3">
      {text && (
        <figure>
          <figcaption className="text-[13px] font-bold text-ink-2">{partnerLabel}の最新の発言</figcaption>
          <blockquote className="mt-1.5 border-l-4 border-line-strong pl-3.5 text-[20px] leading-(--leading-talk) text-ink text-pretty break-words">
            {text}
          </blockquote>
        </figure>
      )}
      {isPartnerSpeaking && (
        <p className="flex items-center gap-2 rounded-lg bg-subtle px-3.5 py-2.5 text-[14px] text-ink">
          <span aria-hidden className="eb-live-dot size-2 shrink-0 rounded-full bg-danger" />
          {partnerLabel}が話しています。話し終わると送信できます。
        </p>
      )}
    </div>
  );
}

interface SuggestionsSectionProps {
  isGenerating: boolean;
  suggestions: SuggestionItem[];
  suggestionsAi: AiMeta | null;
  canSend: boolean;
  /** 狭い画面では切り替えの名前が見出しを兼ねるので、見出しは読み上げ用だけにする。 */
  hideHeading?: boolean;
  onSend(text: string): void;
}

export function SuggestionsSection({
  isGenerating,
  suggestions,
  suggestionsAi,
  canSend,
  hideHeading = false,
  onSend,
}: SuggestionsSectionProps) {
  return (
    <section aria-labelledby="suggestions-heading" className="space-y-2.5">
      {hideHeading ? (
        <h2 id="suggestions-heading" className="sr-only">
          返答候補
        </h2>
      ) : (
        <SectionHeading id="suggestions-heading">返答候補</SectionHeading>
      )}
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
                onClick={() => onSend(suggestion.text)}
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
        <p className="text-[14px] leading-relaxed text-ink-2">相手が話し終えると、ここに3つの候補が出ます。</p>
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
  );
}

export interface ReplyComposerProps {
  /** 広い画面では会話の記録の下に横長で置く。 */
  wide: boolean;
  partnerLabel: string;
  isPartnerSpeaking: boolean;
  composer: ComposerState;
  input: string;
  onInputChange(value: string): void;
  onInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
  onRequestPolish(): void;
  onCancelPolish(): void;
  onSendTyped(): void;
  onEditDraft(draft: string): void;
  onReviewSend(choice: SpeechChoice): void;
  onCloseReview(): void;
}

/**
 * 手入力と、AIの整形案の確認。確認中は入力欄の場所に確認の画面を出し、ほかの返答の方法は隠さない。
 * 送るのは本人が押したときだけ。Enterは案を作るだけで送らない。
 */
export function ReplyComposer(props: ReplyComposerProps) {
  const { wide, partnerLabel, isPartnerSpeaking, composer, input } = props;
  const isPolishing = composer.phase === 'polishing';
  const hasInput = input.trim().length > 0;

  if (composer.phase === 'reviewing' || composer.phase === 'failed') {
    return (
      <PolishReviewPanel
        state={composer}
        sendDisabled={isPartnerSpeaking}
        wide={wide}
        onEditDraft={props.onEditDraft}
        onSend={props.onReviewSend}
        onClose={props.onCloseReview}
      />
    );
  }

  const actions = isPolishing ? (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-subtle px-3.5 py-2">
      <p className="flex items-center gap-2 text-[14px] text-ink">
        <Sparkles className="size-4 text-voice" aria-hidden />
        AIが案を作っています（まだ送信されません）
      </p>
      {/* 帯の上でもボタンと分かるよう、通常時から枠と白い面を付ける。 */}
      <button type="button" onClick={props.onCancelPolish} className={buttonClass('secondary', 'md', 'shrink-0')}>
        <X className="size-4" aria-hidden />
        やめる
      </button>
    </div>
  ) : (
    <div className={cx('grid gap-2', wide ? 'grid-cols-[auto_auto]' : 'grid-cols-2')}>
      <button type="button" onClick={props.onRequestPolish} disabled={!hasInput} className={buttonClass('secondary', 'md')}>
        <Sparkles className="size-4" aria-hidden />
        AIで整える
      </button>
      <button
        type="button"
        onClick={props.onSendTyped}
        disabled={!hasInput || isPartnerSpeaking}
        className={buttonClass('primary', 'md')}
      >
        <Send className="size-4" aria-hidden />
        そのまま送る
      </button>
    </div>
  );

  const hint = (
    <p id="reply-input-hint" className="text-[13px] text-ink-2 short:sr-only">
      Enterで「AIで整える」。整えた文は送る前に確認できます。
    </p>
  );

  return (
    <section aria-labelledby="reply-input-label" className="space-y-2.5 short:space-y-2">
      <label id="reply-input-label" htmlFor="reply-input" className="block text-[15px] font-bold short:sr-only">
        相手に伝える文
      </label>
      <textarea
        id="reply-input"
        aria-describedby="reply-input-hint"
        value={input}
        rows={2}
        maxLength={MAX_PATIENT_TEXT_LENGTH}
        disabled={isPolishing}
        onChange={(event) => props.onInputChange(event.target.value)}
        onKeyDown={props.onInputKeyDown}
        placeholder="伝えたいことを入力"
        className="field-sizing-content block max-h-40 min-h-[3.5rem] w-full resize-none rounded-lg border border-line-strong bg-surface px-3.5 py-2.5 text-[17px] leading-relaxed text-ink placeholder:text-ink-2/70 focus:border-voice disabled:bg-subtle short:max-h-24"
      />
      {/* 広い画面ではヒントとボタンを1行に並べ、会話の記録に高さを残す。
          幅が変わってもボタンを作り直さないよう、包む要素はいつも同じにする。 */}
      <div
        className={cx(
          wide && !isPolishing ? 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2' : 'space-y-2.5 short:space-y-2',
        )}
      >
        {hint}
        {actions}
      </div>
      {isPartnerSpeaking && hasInput && !isPolishing && (
        <p className="text-[13px] text-ink-2">{partnerLabel}が話し終わると送信できます。</p>
      )}
    </section>
  );
}

/** 送信の失敗。どの方法で送っても見える場所（即答フレーズの上）に出す。開いていない方法の中には出さない。 */
export function SendErrorNotice({ message, className }: { message: string | null; className?: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className={cx('bg-danger-soft px-4 py-2.5 text-[14px] font-bold text-danger-strong lg:px-8', className)}
    >
      {message}
    </p>
  );
}

/**
 * 会話を続けるための定型の返事。時間をもらう文と聞き返しを先頭に置く。
 * どの方法を開いていても、AI案の確認中でも押せるよう、下端に固定する。
 * - 狭い画面: 返答欄の下端（親指の届く位置、キーボードの真上）。1列で横に流し、高さが低いときは見出しを省く。
 * - 広い画面: 左列の下端（手入力の下）。右列の高さを候補と登録文に回す。
 * 幅が変わってもボタンを作り直さないよう、要素の形は同じにし、クラスだけを変える。
 */
export function QuickPhraseBar({
  wide,
  disabled,
  partnerLabel,
  onSend,
  className,
}: {
  wide: boolean;
  disabled: boolean;
  partnerLabel: string;
  onSend(text: string): void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-labelledby="quick-heading"
      className={cx(
        'border-t border-line bg-surface pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] short:pt-2 short:pb-[max(0.5rem,env(safe-area-inset-bottom))] tiny:pt-1.5 tiny:pb-[max(0.375rem,env(safe-area-inset-bottom))]',
        wide ? 'px-8' : 'px-4',
        className,
      )}
    >
      <div className={cx('flex flex-wrap items-baseline justify-between gap-x-3 short:sr-only', wide && 'mx-auto max-w-3xl')}>
        <h2 id="quick-heading" className="text-[14px] font-bold text-ink">
          即答フレーズ
        </h2>
        <p className="text-[12px] text-ink-2">
          {disabled ? `${partnerLabel}が話し終えると送れます` : 'AIを待たずに、表示どおりに送ります'}
        </p>
      </div>
      <div
        className={cx(
          'mt-2 flex gap-2 short:mt-0',
          wide ? 'mx-auto max-w-3xl flex-wrap' : 'eb-scroll-row -mx-4 overflow-x-auto px-4 pb-0.5',
        )}
      >
        {QUICK_PHRASES.map((phrase) => (
          <button
            key={phrase}
            type="button"
            onClick={() => onSend(phrase)}
            disabled={disabled}
            className={cx(
              'shrink-0 rounded-full border border-line-strong bg-surface whitespace-nowrap transition-colors duration-150 hover:border-voice hover:bg-voice-soft disabled:cursor-not-allowed disabled:border-line disabled:bg-subtle disabled:text-ink-2',
              wide ? 'min-h-10 px-3.5 text-[14px]' : 'min-h-11 px-4 text-[15px]',
            )}
          >
            {phrase}
          </button>
        ))}
      </div>
    </div>
  );
}
