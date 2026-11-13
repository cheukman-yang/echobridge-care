"use client";

import { Sparkles } from 'lucide-react';
import { useUserLanguage } from '@/contexts/UserLanguageContext';
import { AI_FAILURE_LABELS, isMockAi } from '@/lib/aiMeta';
import type { AiMeta, AiStatus } from '@/lib/aiMeta';
import type { SpeechStatus } from '@/lib/callProtocol';
import type { UserLanguage } from '@/lib/userLanguage';
import { Notice, cx } from './ui';

const PILL_BASE =
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[13px] font-bold';
const PILL_OK = 'border-voice/40 bg-voice-soft text-voice-strong';
const PILL_WARN = 'border-caution-line bg-caution-soft text-caution';
const PILL_NEUTRAL = 'border-line bg-surface text-ink-2';

/** 狭い画面で残す、印の先頭の部分。 */
const SHORT_PREFIXES = ['Gemini', 'モック', 'Mock'];

function describe(status: AiStatus | null, last: AiMeta | null, lang: UserLanguage) {
  const isEn = lang === 'en';
  if (last?.source === 'fallback') {
    return {
      label: isEn ? 'AI Offline' : 'AI未接続',
      title: AI_FAILURE_LABELS[last.reason],
      tone: PILL_WARN,
    };
  }
  if (isMockAi(last) || status?.backend === 'mock') {
    return {
      label: isEn ? 'Mock (Dev)' : 'モック（開発用）',
      title: isEn ? 'Scripted mock mode (no live AI)' : 'AIは使っていません。台本の結果です',
      tone: PILL_WARN,
    };
  }
  if (last?.source === 'gemini') {
    return {
      label: isEn ? 'Gemini Active' : 'Gemini応答',
      title: last.model,
      tone: PILL_OK,
    };
  }
  if (!status) return null;
  if (!status.configured) {
    return {
      label: isEn ? 'AI Offline' : 'AI未接続',
      title: AI_FAILURE_LABELS.not_configured,
      tone: PILL_WARN,
    };
  }
  // 設定があるだけで、応答を確認できたわけではない。
  return {
    label: isEn ? 'AI Ready' : 'AI未確認',
    title: status.model ?? '',
    tone: PILL_NEUTRAL,
  };
}

/** 直近のAI呼び出しの結果を常に見えるようにする。応答を確認できるまで「Gemini」と表示しない。 */
export function AiStatusBadge({ status, last }: { status: AiStatus | null; last: AiMeta | null }) {
  const { userLanguage } = useUserLanguage();
  const view = describe(status, last, userLanguage);
  if (!view) return null;
  // 通話中の見出しは狭い画面で込み合うので、補足の部分（「応答」「（開発用）」）だけを省く。何のAIかは残す。
  const short = SHORT_PREFIXES.find((prefix) => view.label.startsWith(prefix) && view.label !== prefix);
  return (
    <span data-testid="ai-status" className={cx(PILL_BASE, view.tone)} title={view.title}>
      {short ? (
        <>
          {short}
          <span className="max-sm:hidden">{view.label.slice(short.length)}</span>
        </>
      ) : (
        view.label
      )}
    </span>
  );
}

/** 音声認識が使えないと相手の発話が文字にならないので、発信前から本人に知らせる。 */
export function SpeechUnavailableNotice({ status }: { status: SpeechStatus | null }) {
  const { userLanguage } = useUserLanguage();
  if (status !== 'unavailable') return null;
  return (
    <Notice tone="caution" role="status">
      {userLanguage === 'en'
        ? 'Live speech-to-text is unavailable on the server. You can still test safely using the Mock Clinic sandbox below.'
        : '音声認識を利用できません。相手の発話を文字にできません。'}
    </Notice>
  );
}

/** 通話の接続や終了を知らせる帯。画面の上部、操作の邪魔にならない位置に出す。 */
export function CallNotice({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <Notice tone="caution" live testId="call-notice">
      {text}
    </Notice>
  );
}

/**
 * 開発用のモックサーバーにつないでいることを、両方の画面の上部に出し続ける。
 * 台本の結果を、実際のAIや音声認識の結果と取り違えないようにする。
 */
export function MockModeNotice({ active }: { active: boolean }) {
  const { userLanguage } = useUserLanguage();
  if (!active) return null;
  const isEn = userLanguage === 'en';
  return (
    <Notice
      tone="caution"
      testId="mock-mode-notice"
      title={isEn ? 'Development Mock Mode (Not Live AI)' : '開発用のモックモードです（AIではありません）'}
    >
      {/* 狭い画面では会話の表示を狭めないよう、見出しだけにする。 */}
      <p className="max-sm:sr-only">
        {isEn
          ? 'Transcription, suggestions, polishing, and appointment extraction use scripted mock responses instead of Gemini or Speech-to-Text.'
          : '文字起こし・返答候補・文の整形・予定の読み取りは台本の結果で、Gemini と Speech-to-Text は使っていません。デモや提出物で実際の機能として見せないでください。'}
      </p>
    </Notice>
  );
}

/** 返答候補の出所を示す見出し。定型文をAIの回答に見せない。 */
export function SuggestionSourceNote({ ai }: { ai: AiMeta | null }) {
  const { userLanguage } = useUserLanguage();
  const isEn = userLanguage === 'en';

  if (isMockAi(ai)) {
    return (
      <p className="text-[13px] font-bold text-caution">
        {isEn
          ? 'Mock reply suggestions (dev mode). Tapping speaks the displayed Japanese text.'
          : 'モックの返答候補です（開発用・AIではありません）。押すと表示どおりに読み上げます。'}
      </p>
    );
  }
  if (ai?.source === 'fallback') {
    return (
      <Notice
        tone="caution"
        role="status"
        title={isEn ? 'Preset reply options (AI unavailable)' : '定型文の候補です（AIの回答ではありません）'}
      >
        {isEn
          ? 'Tapping speaks the displayed Japanese phrase verbatim.'
          : `${AI_FAILURE_LABELS[ai.reason]}。表示された文がそのまま読み上げられます。`}
      </Notice>
    );
  }

  return (
    <p className="flex items-center gap-1.5 text-[13px] text-ink-2">
      <Sparkles className="size-3.5 text-voice" aria-hidden />
      {isEn
        ? 'AI Reply Suggestions (tapping speaks in Japanese)'
        : 'AIの返答候補（押すと表示どおりに読み上げます）'}
    </p>
  );
}
