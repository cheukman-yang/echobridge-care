"use client";

import { ShieldCheck } from 'lucide-react';
import { useUserLanguage } from '@/contexts/UserLanguageContext';
import { cx } from './ui';

interface LocalStorageBadgeProps {
  compact?: boolean;
  className?: string;
}

/**
 * センシティブな医療対話ログをクラウドに永続保存せず、端末の localStorage のみに保存することを示すバッジ。
 */
export function LocalStorageBadge({ compact = false, className }: LocalStorageBadgeProps) {
  const { userLanguage } = useUserLanguage();
  const isEn = userLanguage === 'en';

  if (compact) {
    return (
      <span
        data-testid="local-storage-badge"
        title={
          isEn
            ? 'Sensitive medical logs are never stored in the cloud — saved only in this browser (localStorage)'
            : '医療対話ログはクラウドに永続保存せず、このブラウザの localStorage のみに保存します'
        }
        className={cx(
          'inline-flex items-center gap-1 rounded-full border border-voice/40 bg-voice-soft px-2.5 py-1 text-[11px] font-bold text-voice-strong whitespace-nowrap',
          className,
        )}
      >
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
        <span>{isEn ? 'Saved Locally Only' : '端末ローカル安全保存'}</span>
      </span>
    );
  }

  return (
    <div
      data-testid="local-storage-badge"
      className={cx(
        'flex items-start gap-2.5 rounded-xl border border-voice/35 bg-voice-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-ink',
        className,
      )}
    >
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-voice-strong" aria-hidden />
      <div className="min-w-0">
        <p className="font-bold text-voice-strong">
          {isEn ? 'Saved Locally Only (Never Stored in Cloud)' : '端末ローカル安全保存（クラウド非保存）'}
        </p>
        <p className="text-[12px] text-ink-2">
          {isEn
            ? 'Sensitive consultation transcripts and summaries are saved strictly in your browser (localStorage), never on external servers.'
            : 'センシティブな医療対話ログ・要約はサーバーに永続保存せず、お使いのブラウザ（localStorage）のみに保存します。'}
        </p>
      </div>
    </div>
  );
}
