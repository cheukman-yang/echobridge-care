"use client";

import { Bot, Sparkles } from 'lucide-react';
import { useUserLanguage } from '@/contexts/UserLanguageContext';
import { isMockAi } from '@/lib/aiMeta';
import type { AiMeta } from '@/lib/aiMeta';
import { cx } from './ui';

interface CareAiModeBadgeProps {
  ai: AiMeta | null | undefined;
  compact?: boolean;
  className?: string;
}

/**
 * `/api/clinic-search`・`/api/sandbox-reception`・`/api/consult` の応答ソース（gemini / fallback）を
 * 画面上部のステータス付近にコンパクトに表示する動作モードバッジ。
 */
export function CareAiModeBadge({ ai, compact = false, className }: CareAiModeBadgeProps) {
  const { userLanguage } = useUserLanguage();
  if (!ai) return null;

  const isEn = userLanguage === 'en';
  const isLiveGemini = ai.source === 'gemini' && !isMockAi(ai);

  return (
    <span
      data-testid="care-ai-mode-badge"
      data-ai-source={isLiveGemini ? 'gemini' : 'fallback'}
      className={cx(
        'inline-flex items-center gap-1 rounded-full border font-bold whitespace-nowrap',
        compact ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-[12px]',
        isLiveGemini
          ? 'border-voice/50 bg-voice-soft text-voice-strong'
          : 'border-line-strong bg-subtle text-ink-2',
        className,
      )}
    >
      {isLiveGemini ? (
        <Sparkles className="size-3 shrink-0 text-voice" aria-hidden />
      ) : (
        <Bot className="size-3 shrink-0 text-ink-2" aria-hidden />
      )}
      <span>
        {isLiveGemini
          ? isEn
            ? 'Gemini AI Active'
            : 'Gemini AI 応答中'
          : isEn
          ? 'Local Demo Mode (No API Key)'
          : 'ローカルデモ応答（APIキー不要）'}
      </span>
    </span>
  );
}
