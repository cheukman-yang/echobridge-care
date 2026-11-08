import { useRef, useState } from 'react';
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
import { ReplyTabs, TabMark, replyPanelId, replyTabId } from './ReplyTabs';
import type { ReplyTab } from './ReplyTabs';
import { cx } from './ui';

/** これより広い画面では、返答の方法を切り替えずに全部を同時に見せる。Tailwind の lg と同じ境目。 */
export const WIDE_LAYOUT_QUERY = '(min-width: 1024px)';

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
 * - 広い画面: 左に会話の記録と、その下に即答フレーズと手入力（AI案の確認もここ）。
 *   右に相手の最新の発言、返答候補、登録した文。全部を同時に見せ、AI案の確認中も候補と登録文を使える。
 * - 狭い画面: 会話の記録の下で「返答候補・入力・登録文」を切り替え、即答フレーズは下端に固定する。
 *
 * 切り替えは本人の操作だけで行う。候補が届いた瞬間に画面が入れ替わると、押そうとしていた所に別の文が来て、
 * 確かめていない文を送ってしまうため。新しい候補はタブの印で知らせる。
 * 開いていない方法は隠すだけで外さないので、入力中の文や登録文の編集中の文は消えない。
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
  const phrases = useCustomPhrases();
  const canSend = !isPartnerSpeaking;

  // 本人が見た候補を覚え、別の方法を開いている間に届いた候補に「新着」を付ける。
  const suggestionsKey = suggestions.map((suggestion) => suggestion.text).join('\n');
  const [seenSuggestionsKey, setSeenSuggestionsKey] = useState(suggestionsKey);
  if ((wide || tab === 'suggestions') && seenSuggestionsKey !== suggestionsKey) {
    setSeenSuggestionsKey(suggestionsKey);
  }
  const hasNewSuggestions = suggestionsKey !== '' && suggestionsKey !== seenSuggestionsKey;

  const selectTab = (next: ReplyTab) => {
    setTab(next);
    // 前に開いていた方法のスクロール位置を持ち越さない。
    if (panelScrollerRef.current) panelScrollerRef.current.scrollTop = 0;
  };

  // AIに頼んでから確認を終えるまでは返答欄を広げ、原文・案・送るボタンを近くに置く（広い画面は手入力の部分を広げる）。
  // 広げるのは「AIで整える」を押したとき（本人の操作）で、案が届いたときには動かさない。
  const composeExpanded = !wide && tab === 'compose' && composer.phase !== 'editing';

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

  /** 狭い画面ではタブの中身、広い画面ではただの区切り。要素の種類と位置は変えず、状態を保つ。 */
  const panelProps = (id: ReplyTab) =>
    wide
      ? {}
      : { role: 'tabpanel', id: replyPanelId(id), 'aria-labelledby': replyTabId(id), hidden: tab !== id };

  const composerNode = (
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
  );

  return (
    <div
      className={cx(
        // 横向きの端末では、画面の切り欠きや角の丸みに文字やボタンが掛からないようにする。
        'mx-auto h-full max-w-[1440px] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]',
        wide ? 'grid grid-cols-[minmax(0,1fr)_minmax(26rem,34rem)]' : 'flex flex-col landscape-short:flex-row',
      )}
    >
      <section
        aria-label="会話"
        className={cx(
          'flex min-h-0 flex-col',
          // 低い画面では返答欄の上限（82%）が記録の場所を残すので、記録の最小の高さは外す。
          wide ? 'border-r border-line' : 'min-h-24 flex-1 short:min-h-0',
        )}
      >
        <div className="min-h-0 flex-1">{log}</div>
        {wide ? (
          // 即答フレーズは固定し、AI案の確認で高くなったときは入力の部分だけをスクロールする。
          <div
            className={cx(
              'flex shrink-0 flex-col border-t border-line bg-surface',
              composer.phase === 'editing' ? 'max-h-[65%]' : 'max-h-[75%]',
            )}
          >
            <SendErrorNotice message={sendError} />
            <QuickPhraseBar wide disabled={!canSend} partnerLabel={partnerLabel} onSend={props.onSendQuickPhrase} />
            <div className="min-h-0 overflow-y-auto overscroll-contain">
              <div className="mx-auto max-w-3xl px-8 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                {composerNode}
              </div>
            </div>
          </div>
        ) : null}
      </section>

      <section
        aria-label="返答"
        className={cx(
          'flex min-h-0 flex-col bg-surface',
          !wide &&
            'shrink-0 border-t border-line landscape-short:max-h-none landscape-short:w-[min(26rem,52%)] landscape-short:border-t-0 landscape-short:border-l',
          // 記録には少なくとも約3割を残し、相手の最新の発言が見えるようにする。
          !wide && (composeExpanded ? 'max-h-[82%]' : 'max-h-[72%] short:max-h-[82%]'),
          !wide && 'tiny:max-h-none',
        )}
      >
        {wide ? null : <ReplyTabs active={tab} onSelect={selectTab} marks={marks} />}
        <div
          ref={panelScrollerRef}
          className={cx(
            'flex-1 overflow-y-auto overscroll-contain',
            wide
              ? 'min-h-0 space-y-6 px-6 pt-6 pb-8'
              : 'min-h-[min(13rem,35dvh)] px-4 pt-4 pb-5 short:pt-3 short:pb-3',
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
          {wide ? null : <div {...panelProps('compose')}>{composerNode}</div>}
          <div {...panelProps('custom')}>
            <CustomPhrasesSection
              mode="call"
              canSend={canSend}
              partnerLabel={partnerLabel}
              onSend={props.onSendCustomPhrase}
            />
          </div>
        </div>
        {wide ? null : <SendErrorNotice message={sendError} />}
        {wide ? null : (
          <QuickPhraseBar wide={false} disabled={!canSend} partnerLabel={partnerLabel} onSend={props.onSendQuickPhrase} />
        )}
      </section>
    </div>
  );
}
