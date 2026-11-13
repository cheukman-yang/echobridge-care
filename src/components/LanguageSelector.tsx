"use client";

import { useUserLanguage } from '@/contexts/UserLanguageContext';
import type { UserLanguage } from '@/lib/userLanguage';
import { cx } from './ui';

interface LanguageSelectorProps {
  className?: string;
  compact?: boolean;
}

const LANGUAGE_OPTIONS: ReadonlyArray<{
  value: UserLanguage;
  label: string;
}> = [
  { value: 'ja', label: '🇯🇵 日本語' },
  { value: 'en', label: '🇺🇸 English' },
];

/**
 * 発信前・対面診察開始前に患者自身の使用言語を選択するセグメントスイッチ。
 */
export function LanguageSelector({ className, compact = false }: LanguageSelectorProps) {
  const { userLanguage, setUserLanguage } = useUserLanguage();

  return (
    <div
      role="group"
      aria-labelledby="user-language-label"
      className={cx(
        'rounded-xl border border-line bg-surface p-3.5',
        compact && 'p-3',
        className,
      )}
    >
      <p id="user-language-label" className="text-[14px] font-bold text-ink">
        あなたの言語 / Select Your Language
      </p>
      <div className="mt-2 grid grid-cols-2 gap-1.5 rounded-lg bg-subtle p-1">
        {LANGUAGE_OPTIONS.map((option) => {
          const active = userLanguage === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => setUserLanguage(option.value)}
              className={cx(
                'min-h-11 rounded-md px-3 py-2 text-[15px] font-bold transition-colors duration-150',
                active
                  ? 'border border-voice bg-voice text-on-voice shadow-xs'
                  : 'text-ink hover:bg-surface/80',
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {!compact && (
        <p className="mt-2 text-[12px] leading-relaxed text-ink-2">
          {userLanguage === 'ja'
            ? '発話・聴覚障がいや電話への不安がある方へ：医療表現への整形と日本語での3択回答候補・文字起こしを生成します。'
            : 'For visitors & English speakers: Generates 3-choice English replies and real-time bidirectional medical translation with Japanese staff/doctors.'}
        </p>
      )}
    </div>
  );
}
