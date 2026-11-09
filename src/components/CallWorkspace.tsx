import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import type { AiMeta } from '@/lib/aiMeta';
import type { SuggestionItem } from '@/lib/callProtocol';
import type { ComposerState, SpeechChoice } from '@/lib/composer';
import { CustomPhrasesSection, useCustomPhrases } from './CustomPhrases';
import {
  LatestPartnerUtterance,
  QuickPhraseBar,
  ReplyComposer,
  SendErrorNotice,
  SuggestionsSection,
} from './ReplyPanel';
import { REPLY_TABS, ReplyTabs, TabMark, replyPanelId, replyTabId } from './ReplyTabs';
import type { ReplyTab } from './ReplyTabs';
import { cx } from './ui';

/** これより広い画面では、返答の方法を切り替えずに全部を同時に見せる。Tailwind の lg と同じ境目。 */
export const WIDE_LAYOUT_QUERY = '(min-width: 1024px)';

/** 返答の方法ごとの領域に付ける印。幅が変わったとき、本人が操作していた方法を開くために使う。 */
const REPLY_AREA_ATTRIBUTE = 'data-reply-area';

/** いまフォーカスがある返答の方法。どの方法の中にもなければ null。 */
function focusedReplyArea(): ReplyTab | null {
  if (typeof document === 'undefined') return null;
  const area = document.activeElement?.closest(`[${REPLY_AREA_ATTRIBUTE}]`)?.getAttribute(REPLY_AREA_ATTRIBUTE);
  return REPLY_TABS.some((tab) => tab.id === area) ? (area as ReplyTab) : null;
}

interface CallWorkspaceProps {
  /** 会話の記録。どちらの並べ方でも同じ位置に置き、読み返している位置を保つ。 */
  log: ReactNode;
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

/**
 * 通話中の画面。広い画面と狭い画面で並べ方を変える。
 *
 * - 広い画面: 左に会話の記録、その下に手入力（AI案の確認もここ）と即答フレーズ。
 *   右に相手の最新の発言、返答候補、登録した文。全部を同時に見せ、AI案の確認中も候補と登録文を使える。
 * - 狭い画面: 会話の記録の下で「返答候補・入力・登録文」を切り替え、即答フレーズは下端に固定する。
 *
 * 部品は1つの格子（globals.css の .eb-call）に同じ順で置き、幅で変えるのは配置だけにする。
 * 幅が変わっても入力欄やAI案の欄は作り直されず、フォーカス・カーソル位置・取り消しの履歴が残る。
 * 狭い画面へ移るときは、本人が操作していた方法（入力・登録文）を開き、編集中の欄を隠さない。
 *
 * 候補が届いても勝手には切り替えない。押そうとしていた所に別の文が来て、確かめていない文を送ってしまうため。
 * 新しい候補はタブの印で知らせる。開いていない方法は隠すだけで外さないので、入力中の文は消えない。
 */
export function CallWorkspace(props: CallWorkspaceProps) {
  const {
    log,
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

  // matchMedia のない環境（テスト）では同時表示にする。
  const wide = useMediaQuery(WIDE_LAYOUT_QUERY, true);
  const [tab, setTab] = useState<ReplyTab>('suggestions');
  const panelScrollerRef = useRef<HTMLDivElement>(null);
  const composeScrollerRef = useRef<HTMLDivElement>(null);
  // 方法ごとのスクロール位置。切り替えて戻ったとき、見ていた所（登録文の途中など）に戻す。
  const scrollPositions = useRef<Partial<Record<ReplyTab, number>>>({});
  const phrases = useCustomPhrases();
  const canSend = !isPartnerSpeaking;

  // 狭い画面へ移る描画の中で、まだ画面に残っているフォーカスの場所を読み、その方法を同じ描画で開く。
  // 描き終えてから開くと、一度隠れた欄からフォーカスが外れてしまう。
  const [renderedWide, setRenderedWide] = useState(wide);
  if (renderedWide !== wide) {
    setRenderedWide(wide);
    const area = wide ? null : focusedReplyArea();
    if (area && area !== tab) setTab(area);
  }

  // 本人が見た候補を覚え、別の方法を開いている間に届いた候補に「新着」を付ける。
  const suggestionsKey = suggestions.map((suggestion) => suggestion.text).join('\n');
  const [seenSuggestionsKey, setSeenSuggestionsKey] = useState(suggestionsKey);
  if ((wide || tab === 'suggestions') && seenSuggestionsKey !== suggestionsKey) {
    setSeenSuggestionsKey(suggestionsKey);
  }
  const hasNewSuggestions = suggestionsKey !== '' && suggestionsKey !== seenSuggestionsKey;

  const scrollerFor = (id: ReplyTab) => (id === 'compose' ? composeScrollerRef.current : panelScrollerRef.current);

  const selectTab = (next: ReplyTab) => {
    if (next === tab) return;
    // 閉じる方法の位置を覚える。返答候補と登録文は同じ枠でスクロールするので、方法ごとに分けて持つ。
    const current = scrollerFor(tab);
    if (current) scrollPositions.current[tab] = current.scrollTop;
    setTab(next);
  };

  // 開いた方法の位置を、描いた直後（見える前）に戻す。初めて開く方法は先頭から。
  useLayoutEffect(() => {
    if (wide) return;
    const scroller = tab === 'compose' ? composeScrollerRef.current : panelScrollerRef.current;
    if (scroller) scroller.scrollTop = scrollPositions.current[tab] ?? 0;
  }, [tab, wide]);

  // AIに頼んでから確認を終えるまでは、手入力の部分に高さを回し、原文・案・送るボタンを近くに置く。
  // 広げるのは「AIで整える」を押したとき（本人の操作）で、案が届いたときには動かさない。
  const composerBusy = composer.phase !== 'editing';
  const expanded = wide ? composerBusy : composerBusy && tab === 'compose';

  const composeMark =
    composer.phase === 'polishing' ? (
      <TabMark tone="neutral">AI作成中</TabMark>
    ) : composer.phase === 'reviewing' || composer.phase === 'failed' ? (
      <TabMark tone="caution">確認待ち</TabMark>
    ) : input.trim() ? (
      <TabMark tone="neutral">下書き</TabMark>
    ) : null;

  const marks: Partial<Record<ReplyTab, ReactNode>> = {
    suggestions:
      tab === 'suggestions' ? null : isGenerating ? (
        <TabMark tone="neutral">準備中</TabMark>
      ) : hasNewSuggestions ? (
        <TabMark tone="new">新着</TabMark>
      ) : null,
    compose: tab === 'compose' ? null : composeMark,
    custom:
      phrases.length > 0 ? (
        <span className="text-[13px] font-normal text-ink-2 tabular-nums">
          {phrases.length}
          <span className="sr-only">件</span>
        </span>
      ) : null,
  };

  /** 狭い画面ではタブの中身、広い画面ではただの区切り。要素の種類と位置は変えない。 */
  const panelProps = (id: ReplyTab) => ({
    [REPLY_AREA_ATTRIBUTE]: id,
    ...(wide
      ? {}
      : { role: 'tabpanel', id: replyPanelId(id), 'aria-labelledby': replyTabId(id), hidden: tab !== id }),
  });

  // 要素の順は、狭い画面でのタブ → 中身 → 失敗の帯 → 即答フレーズの読み上げ・フォーカスの順と同じにする。
  return (
    <div
      className={cx(
        'eb-call mx-auto max-w-[1440px] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]',
        wide ? 'eb-call--wide' : 'eb-call--narrow',
        expanded && 'eb-call--expanded',
      )}
    >
      <section
        aria-label="会話"
        className={cx('min-h-0 [grid-area:log]', !wide && 'landscape-short:border-r landscape-short:border-line')}
      >
        {log}
      </section>

      {wide ? null : <ReplyTabs active={tab} onSelect={selectTab} marks={marks} className="[grid-area:tabs]" />}
      {/* 別の方法を開いている間に届いた候補を、読み上げソフトにも一度だけ知らせる。 */}
      <p className="sr-only" aria-live="polite">
        {!wide && hasNewSuggestions && tab !== 'suggestions' ? '新しい返答候補が届きました。「返答候補」で確認できます。' : ''}
      </p>

      <div
        ref={panelScrollerRef}
        hidden={!wide && tab === 'compose'}
        className={cx(
          'min-h-0 overflow-y-auto overscroll-contain bg-surface',
          wide
            ? 'space-y-6 border-l border-line px-6 pt-6 pb-8 [grid-area:side]'
            : 'px-4 pt-4 pb-5 [grid-area:panel] short:pt-3 short:pb-3',
        )}
      >
        {wide ? (
          <LatestPartnerUtterance
            partnerLabel={partnerLabel}
            text={latestPartnerText}
            isPartnerSpeaking={isPartnerSpeaking}
          />
        ) : null}
        <div {...panelProps('suggestions')}>
          <SuggestionsSection
            isGenerating={isGenerating}
            suggestions={suggestions}
            suggestionsAi={suggestionsAi}
            canSend={canSend}
            hideHeading={!wide}
            onSend={props.onSendSuggestion}
          />
        </div>
        <div {...panelProps('custom')}>
          <CustomPhrasesSection
            mode="call"
            canSend={canSend}
            partnerLabel={partnerLabel}
            onSend={props.onSendCustomPhrase}
          />
        </div>
      </div>

      {/* 手入力とAI案の確認。広い画面では記録の下、狭い画面では「入力」の中身。どちらでも同じ要素のまま。 */}
      <div
        ref={composeScrollerRef}
        {...panelProps('compose')}
        className={cx(
          'min-h-0 overflow-y-auto overscroll-contain bg-surface',
          wide ? 'border-t border-line [grid-area:compose]' : '[grid-area:panel]',
        )}
      >
        <div
          className={
            wide
              ? 'mx-auto max-w-3xl px-8 pt-4 pb-4'
              : 'px-4 pt-4 pb-5 short:pt-3 short:pb-3 tiny:pt-2 tiny:pb-2'
          }
        >
          <ReplyComposer
            wide={wide}
            partnerLabel={partnerLabel}
            isPartnerSpeaking={isPartnerSpeaking}
            composer={composer}
            input={input}
            onInputChange={props.onInputChange}
            onInputKeyDown={props.onInputKeyDown}
            onRequestPolish={props.onRequestPolish}
            onCancelPolish={props.onCancelPolish}
            onSendTyped={props.onSendTyped}
            onEditDraft={props.onEditDraft}
            onReviewSend={props.onReviewSend}
            onCloseReview={props.onCloseReview}
          />
        </div>
      </div>

      <SendErrorNotice message={sendError} className="[grid-area:error]" />
      <QuickPhraseBar
        wide={wide}
        disabled={!canSend}
        partnerLabel={partnerLabel}
        onSend={props.onSendQuickPhrase}
        className="[grid-area:quick]"
      />
    </div>
  );
}
