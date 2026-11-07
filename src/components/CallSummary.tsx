import { useState } from 'react';
import { CalendarPlus } from 'lucide-react';
import { hasScheduleHint } from '@/lib/appointment';
import type { AppointmentResult } from '@/lib/callProtocol';
import { AppointmentReviewCard } from './AppointmentReviewCard';
import { Notice, SectionHeading, buttonClass } from './ui';

export interface TranscriptLine {
  id: string;
  speaker: string;
  text: string;
}

interface CallSummaryProps {
  result: AppointmentResult;
  partnerLabel: string;
  transcript: TranscriptLine[];
  onBack: () => void;
}

/**
 * 通話の後の画面。予定が話された通話だけ、予定の下書きを前に出す。
 * 予定のない通話で、予約が済んだように見せない。
 */
export function CallSummary({ result, partnerLabel, transcript, onBack }: CallSummaryProps) {
  const found = result.ai.source === 'fallback' || hasScheduleHint(result.appointment);
  const [showManual, setShowManual] = useState(false);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8 lg:py-12">
      <div className="space-y-2">
        <h1 className="text-[26px] font-bold leading-snug text-balance">通話を終了しました</h1>
        <p className="text-[15px] text-ink-2">{partnerLabel}との通話の記録は、この画面を閉じると消えます。</p>
      </div>

      <section aria-labelledby="schedule-heading" className="space-y-3">
        <SectionHeading id="schedule-heading">予定</SectionHeading>
        {found || showManual ? (
          <AppointmentReviewCard appointment={result.appointment} ai={result.ai} />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-5">
            <p className="text-[15px] text-ink-2">通話の中で、決まった予定は見つかりませんでした。</p>
            <button type="button" onClick={() => setShowManual(true)} className={buttonClass('secondary', 'md')}>
              <CalendarPlus className="size-4" aria-hidden />
              予定を手で追加
            </button>
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
