import type { ReactNode } from 'react';
import { AlertTriangle, Info } from 'lucide-react';

/** 偽の値を除いてクラス名をつなぐ。 */
export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'quiet';
type ButtonSize = 'md' | 'lg';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-lg font-bold select-none transition-colors duration-150 disabled:cursor-not-allowed';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-voice text-on-voice hover:bg-voice-strong disabled:bg-subtle disabled:text-ink-2',
  secondary:
    'border border-line-strong bg-surface text-ink hover:bg-subtle disabled:border-line disabled:text-ink-2 disabled:hover:bg-surface',
  danger: 'bg-danger text-white hover:bg-danger-strong disabled:bg-subtle disabled:text-ink-2',
  quiet: 'text-voice hover:bg-voice-soft disabled:text-ink-2 disabled:hover:bg-transparent',
};

// どちらも44px以上。指の大きさと、手の動きに制約がある人の押しやすさに合わせる。
const BUTTON_SIZES: Record<ButtonSize, string> = {
  md: 'min-h-11 px-4 text-[15px]',
  lg: 'min-h-13 px-6 text-base',
};

export function buttonClass(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'md',
  extra?: string,
): string {
  return cx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], extra);
}

type NoticeTone = 'caution' | 'danger' | 'neutral';

const NOTICE_TONES: Record<NoticeTone, string> = {
  caution: 'border-caution-line bg-caution-soft text-caution',
  danger: 'border-danger/40 bg-danger-soft text-danger-strong',
  neutral: 'border-line bg-surface text-ink-2',
};

interface NoticeProps {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  role?: 'alert' | 'status';
  live?: boolean;
  testId?: string;
  className?: string;
}

/** 注意や失敗を、操作の近くで伝える枠。理由と次にできることを書く。 */
export function Notice({
  tone = 'caution',
  title,
  children,
  role,
  live,
  testId,
  className,
}: NoticeProps) {
  const Icon = tone === 'neutral' ? Info : AlertTriangle;
  return (
    <div
      role={role}
      aria-live={live ? 'polite' : undefined}
      data-testid={testId}
      className={cx(
        'flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm leading-relaxed',
        NOTICE_TONES[tone],
        className,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 text-pretty">
        {title && <p className="font-bold">{title}</p>}
        {children}
      </div>
    </div>
  );
}

/** 見出しと補足を持つ区切り。画面の中の段落の役割を示す。 */
export function SectionHeading({
  id,
  children,
  hint,
}: {
  id?: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <h2 id={id} className="text-[15px] font-bold text-ink">
        {children}
      </h2>
      {hint && <p className="text-[13px] text-ink-2">{hint}</p>}
    </div>
  );
}
