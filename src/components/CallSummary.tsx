import { useState } from 'react';
import { CalendarPlus } from 'lucide-react';
import { AI_FAILURE_LABELS } from '@/lib/aiMeta';
import { hasScheduleHint } from '@/lib/appointment';
import type { AppointmentDraft, AppointmentResult } from '@/lib/callProtocol';
import { AppointmentReviewCard } from './AppointmentReviewCard';
import { Notice, SectionHeading, buttonClass } from './ui';

export interface TranscriptLine {
  id: string;
  speaker: string;
  text: string;
}

interface CallSummaryProps {
  result: AppointmentResult;
  /** 本人が手で入力するときの初期値。発信のときの入力から作り、AIの値は入れない。 */
  manualDefaults: { title: string; location: string };
  partnerLabel: string;
  transcript: TranscriptLine[];
  onBack: () => void;
}

/**
 * 通話の後の画面。予定の状態を「予定あり」「予定なし」「読み取りの失敗」「本人の入力」に分ける。
 * 予定が話された通話だけ下書きを前に出し、予定のない通話で入力を求めたり、予約が済んだように見せたりしない。
 */
export function CallSummary({ result, manualDefaults, partnerLabel, transcript, onBack }: CallSummaryProps) {
  const { ai, appointment } = result;
  const state = ai.source === 'fallback' ? 'failed' : hasScheduleHint(appointment) ? 'found' : 'none';
  const [manual, setManual] = useState(false);
  const manualDraft: AppointmentDraft = {
    title: manualDefaults.title,
    date: null,
    startTime: null,
    endTime: null,
    location: manualDefaults.location,
    details: '',
  };
  const addManually = (
    <button type="button" onClick={() => setManual(true)} className={buttonClass('secondary', 'md')}>
      <CalendarPlus className="size-4" aria-hidden />
      予定を手で追加
    </button>
  );

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8 lg:py-12">
      <div className="space-y-2">
        <h1 className="text-[26px] font-bold leading-snug text-balance">通話を終了しました</h1>
        <p className="text-[15px] text-ink-2">{partnerLabel}との通話の記録は、この画面を閉じると消えます。</p>
      </div>

      <section aria-labelledby="schedule-heading" className="space-y-3">
        <SectionHeading id="schedule-heading">予定</SectionHeading>
        {manual ? (
          <AppointmentReviewCard appointment={manualDraft} source={{ kind: 'manual' }} />
        ) : state === 'found' && ai.source === 'gemini' ? (
          <AppointmentReviewCard appointment={appointment} source={{ kind: 'ai', model: ai.model }} />
        ) : state === 'failed' && ai.source === 'fallback' ? (
          <div className="space-y-3">
            <Notice tone="caution" role="status" title="AIで予定を読み取れませんでした">
              {AI_FAILURE_LABELS[ai.reason]}。予定が決まっていた場合は、会話の記録を見て手で追加できます。
            </Notice>
            {addManually}
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-5">
            <p className="text-[15px] text-ink-2">通話の中で、決まった予定は見つかりませんでした。</p>
            {addManually}
          </div>
        )}
      </section>

      <section aria-labelledby="record-heading" className="space-y-3">
        <SectionHeading id="record-heading">会話の記録</SectionHeading>
        {transcript.length > 0 ? (
          <details className="group rounded-xl border border-line bg-surface">
            <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 px-5 py-3 text-[15px] font-bold">
              <span>通話の記録を見る</span>
              <span className="font-normal text-ink-2 tabular-nums">{transcript.length}件</span>
            </summary>
            <ol className="space-y-3 border-t border-line px-5 py-4">
              {transcript.map((line) => (
                <li key={line.id} className="grid gap-0.5 text-[15px] leading-relaxed sm:grid-cols-[7rem_1fr] sm:gap-3">
                  <span className="text-[13px] font-bold text-ink-2 sm:pt-0.5">{line.speaker}</span>
                  <span className="text-pretty break-words">{line.text}</span>
                </li>
              ))}
            </ol>
          </details>
        ) : (
          <Notice tone="neutral">記録はありません。</Notice>
        )}
      </section>

      <button type="button" onClick={onBack} className={buttonClass('secondary', 'md')}>
        最初の画面に戻る
      </button>
    </div>
  );
}
