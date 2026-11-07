import { AlertTriangle, Sparkles } from 'lucide-react';
import { AI_FAILURE_LABELS } from '@/lib/aiMeta';
import type { AiMeta, AiStatus } from '@/lib/aiMeta';
import type { SpeechStatus } from '@/lib/callProtocol';

const PILL_BASE = 'text-[10px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap';
const PILL_OK = 'bg-green-500/15 text-green-300 border-green-500/40';
const PILL_WARN = 'bg-amber-500/15 text-amber-300 border-amber-500/40';
const PILL_NEUTRAL = 'bg-slate-700/60 text-slate-300 border-slate-600';

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
    <span data-testid="ai-status" className={`${PILL_BASE} ${view.tone}`} title={view.title}>
      {view.label}
    </span>
  );
}

/** 音声認識が使えないと相手の発話が文字にならないので、発信前から本人に知らせる。 */
export function SpeechUnavailableNotice({ status }: { status: SpeechStatus | null }) {
  if (status !== 'unavailable') return null;
  return (
    <div
      role="status"
      className="flex items-center gap-1.5 text-[11px] leading-snug text-amber-200 bg-amber-500/10 border-b border-amber-500/40 px-5 py-1.5 z-20"
    >
      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
      <span>音声認識を利用できません。相手の発話を文字にできません。</span>
    </div>
  );
}

/** 通話の接続や終了を知らせる帯。音声認識の表示と同じ場所に出す。 */
export function CallNotice({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div
      aria-live="polite"
      data-testid="call-notice"
      className="flex items-center gap-1.5 text-[11px] leading-snug text-amber-200 bg-amber-500/10 border-b border-amber-500/40 px-5 py-1.5 z-20"
    >
      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
      <span>{text}</span>
    </div>
  );
}

/** 返答候補の出所を示す見出し。定型文をAIの回答に見せない。 */
export function SuggestionSourceNote({ ai }: { ai: AiMeta | null }) {
  if (ai?.source === 'fallback') {
    return (
      <div
        role="status"
        className="flex items-start gap-1.5 text-[11px] leading-snug text-amber-200 bg-amber-500/10 border border-amber-500/40 rounded-lg px-2.5 py-1.5"
      >
        <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" />
        <span>
          <strong className="font-bold">定型文の候補です（AIの回答ではありません）</strong>
          <br />
          {AI_FAILURE_LABELS[ai.reason]}。表示された文がそのまま読み上げられます。
        </span>
      </div>
    );
  }

  return (
    <span className="flex items-center gap-1 text-[11px] text-slate-400 font-medium">
      <Sparkles className="w-3 h-3 text-indigo-300" />
      AIの返答候補 (タップで表示どおりに読み上げ)
    </span>
  );
}
