import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { cx } from './ui';

export type ReplyTab = 'suggestions' | 'compose' | 'custom';

export const REPLY_TABS: ReadonlyArray<{ id: ReplyTab; label: string }> = [
  { id: 'suggestions', label: '返答候補' },
  { id: 'compose', label: '入力' },
  { id: 'custom', label: '登録文' },
];

export const replyTabId = (tab: ReplyTab) => `reply-tab-${tab}`;
export const replyPanelId = (tab: ReplyTab) => `reply-panel-${tab}`;

type MarkTone = 'new' | 'neutral' | 'caution';

const MARK_TONES: Record<MarkTone, string> = {
  // 新着は見落とすと返事が遅れるので、塗りつぶし（白い文字）にして、ほかの印より強くする。
  new: 'eb-attention bg-voice text-on-voice',
  neutral: 'bg-subtle text-ink-2',
  caution: 'bg-caution-soft text-caution',
};

/** タブの名前に添える小さな印。色だけに頼らず、言葉（と新着は点の形）で状態を伝える。 */
export function TabMark({ tone, children }: { tone: MarkTone; children: ReactNode }) {
  return (
    <span
      data-tone={tone}
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[12px] leading-snug font-bold',
        tone === 'new' && 'px-2',
        MARK_TONES[tone],
      )}
    >
      {tone === 'new' && <span aria-hidden className="size-1.5 rounded-full bg-on-voice" />}
      {children}
    </span>
  );
}

interface ReplyTabsProps {
  active: ReplyTab;
  onSelect(tab: ReplyTab): void;
  /** タブごとの状態（新着、下書き、件数など）。 */
  marks: Partial<Record<ReplyTab, ReactNode>>;
  className?: string;
}

/**
 * 狭い画面で返答の方法を切り替える。WAI-ARIAのタブの形（左右キーで移動し、移った先を開く）。
 * 切り替えるのは本人の操作だけで、候補が届いても勝手には切り替えない。
 */
export function ReplyTabs({ active, onSelect, marks, className }: ReplyTabsProps) {
  const buttons = useRef<Partial<Record<ReplyTab, HTMLButtonElement | null>>>({});

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = REPLY_TABS.findIndex((tab) => tab.id === active);
    const last = REPLY_TABS.length - 1;
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % REPLY_TABS.length
        : event.key === 'ArrowLeft'
        ? (index + last) % REPLY_TABS.length
        : event.key === 'Home'
        ? 0
        : event.key === 'End'
        ? last
        : null;
    if (next === null) return;
    event.preventDefault();
    const tab = REPLY_TABS[next].id;
    onSelect(tab);
    buttons.current[tab]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="返答の方法"
      onKeyDown={onKeyDown}
      className={cx(
        // 返答欄の上端。横向きでは右列の先頭なので上の線は引かない。
        'grid grid-cols-3 border-y border-line bg-surface px-2 landscape-short:border-t-0',
        className,
      )}
    >
      {REPLY_TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(element) => {
              buttons.current[tab.id] = element;
            }}
            type="button"
            role="tab"
            id={replyTabId(tab.id)}
            aria-controls={replyPanelId(tab.id)}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            className={cx(
              'relative flex min-h-12 flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 px-1 py-1.5 text-[15px] font-bold transition-colors duration-150 tiny:min-h-11 tiny:py-1',
              selected ? 'text-ink' : 'text-ink-2 hover:bg-subtle',
            )}
          >
            <span>{tab.label}</span>
            {marks[tab.id]}
            <span
              aria-hidden
              className={cx('absolute inset-x-3 bottom-0 h-[3px] rounded-t-full', selected ? 'bg-voice' : 'bg-transparent')}
            />
          </button>
        );
      })}
    </div>
  );
}
