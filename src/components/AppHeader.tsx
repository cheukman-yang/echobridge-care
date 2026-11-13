import type { ReactNode } from 'react';
import { cx } from './ui';

export type CallStatusTone = 'idle' | 'waiting' | 'live' | 'warning' | 'ended';

const DOT_TONES: Record<CallStatusTone, string> = {
  idle: 'bg-line-strong',
  waiting: 'bg-caution-line',
  live: 'bg-voice',
  warning: 'bg-danger',
  ended: 'bg-line-strong',
};

interface CallStatusProps {
  tone: CallStatusTone;
  label: string;
  detail?: string;
}

/** 今の通話の段階を、点と言葉で示す。色だけに頼らない。 */
export function CallStatus({ tone, label, detail }: CallStatusProps) {
  return (
    <p className="flex min-w-0 items-center gap-2 text-sm">
      <span
        aria-hidden
        className={cx('size-2.5 shrink-0 rounded-full', DOT_TONES[tone], tone === 'live' && 'eb-live-dot')}
      />
      <span className="min-w-0 truncate font-bold text-ink">{label}</span>
      {/* 狭い画面では相手の名前を省く。名前は会話の記録の発言者として出ている。 */}
      {detail && <span className="min-w-0 truncate text-ink-2 max-sm:hidden">{detail}</span>}
    </p>
  );
}

interface AppHeaderProps {
  /** 通話の状態。狭い画面では2行目に回る。 */
  status?: ReactNode;
  actions?: ReactNode;
  /** 通話中は狭い画面で製品名を隠し、状態と操作に場所を譲る。 */
  compactOnMobile?: boolean;
  /** 対面診察中など、上部の余白を最小限に圧縮して会話タイムラインを広く取る。 */
  slim?: boolean;
}

export function AppHeader({
  status,
  actions,
  compactOnMobile = false,
  slim = false,
}: AppHeaderProps) {
  return (
    <header className="border-b border-line bg-surface pt-[env(safe-area-inset-top)]">
      {/* キーボード表示中など高さが低いときは、上下の余白を詰めて返答欄に高さを回す。ボタンの大きさは変えない。 */}
      <div
        className={cx(
          'mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-4 gap-y-1 lg:px-6 tiny:min-h-0 tiny:py-0.5',
          slim ? 'min-h-9 px-3 py-1' : 'min-h-14 px-4 py-2',
        )}
      >
        <p
          className={cx(
            'font-bold tracking-normal text-ink',
            slim ? 'text-[14px]' : 'text-[17px]',
            compactOnMobile && 'max-sm:hidden',
          )}
        >
          EchoBridge Care
        </p>
        {status && (
          <div
            className={cx(
              'min-w-0',
              compactOnMobile ? 'flex-1 sm:flex-none' : 'order-last w-full sm:order-none sm:w-auto',
            )}
          >
            {status}
          </div>
        )}
        {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
