import { Sparkles } from 'lucide-react';
import { AI_FAILURE_LABELS } from '@/lib/aiMeta';
import type { AiMeta, AiStatus } from '@/lib/aiMeta';
import type { SpeechStatus } from '@/lib/callProtocol';
import { Notice, cx } from './ui';

const PILL_BASE =
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[13px] font-bold';
const PILL_OK = 'border-voice/40 bg-voice-soft text-voice-strong';
const PILL_WARN = 'border-caution-line bg-caution-soft text-caution';
const PILL_NEUTRAL = 'border-line bg-surface text-ink-2';

function describe(status: AiStatus | null, last: AiMeta | null) {
  if (last?.source === 'gemini') {
    return { label: 'Gemini応答', title: last.model, tone: PILL_OK };
  }
  if (last?.source === 'fallback') {
    return { label: 'AI未接続', title: AI_FAILURE_LABELS[last.reason], tone: PILL_WARN };
  }
  if (!status) return null;
  if (!status.configured) {
    return { label: 'AI未接続', title: AI_FAILURE_LABELS.not_configured, tone: PILL_WARN };
  }
  // 設定があるだけで、応答を確認できたわけではない。
  return { label: 'AI未確認', title: status.model ?? '', tone: PILL_NEUTRAL };
}

/** 直近のAI呼び出しの結果を常に見えるようにする。応答を確認できるまで「Gemini」と表示しない。 */
export function AiStatusBadge({ status, last }: { status: AiStatus | null; last: AiMeta | null }) {
  const view = describe(status, last);
  if (!view) return null;
  return (
    <span data-testid="ai-status" className={cx(PILL_BASE, view.tone)} title={view.title}>
      {view.label}
    </span>
  );
}

/** 音声認識が使えないと相手の発話が文字にならないので、発信前から本人に知らせる。 */
export function SpeechUnavailableNotice({ status }: { status: SpeechStatus | null }) {
  if (status !== 'unavailable') return null;
  return (
    <Notice tone="caution" role="status">
      音声認識を利用できません。相手の発話を文字にできません。
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

/** 返答候補の出所を示す見出し。定型文をAIの回答に見せない。 */
export function SuggestionSourceNote({ ai }: { ai: AiMeta | null }) {
  if (ai?.source === 'fallback') {
    return (
      <Notice tone="caution" role="status" title="定型文の候補です（AIの回答ではありません）">
        {AI_FAILURE_LABELS[ai.reason]}。表示された文がそのまま読み上げられます。
      </Notice>
    );
  }

  return (
    <p className="flex items-center gap-1.5 text-[13px] text-ink-2">
      <Sparkles className="size-3.5 text-voice" aria-hidden />
      AIの返答候補（押すと表示どおりに読み上げます）
    </p>
  );
}
