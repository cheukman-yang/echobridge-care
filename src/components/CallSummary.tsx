import { useState } from 'react';
import { CalendarPlus, MapPin } from 'lucide-react';
import { AI_FAILURE_LABELS } from '@/lib/aiMeta';
import { buildMapsSearchUrl, hasPlaceHint, hasScheduleHint, joinPlace } from '@/lib/appointment';
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
 * 予定がなくても会話に場所が出ていれば、地図で確かめられるようにし、手で追加するときもその場所を使う。
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
    address: '',
    details: '',
  };
  const spokenPlace = ai.source === 'gemini' && hasPlaceHint(appointment);
  const place = joinPlace(appointment.location, appointment.address ?? '');
  const placeMapsUrl = spokenPlace ? buildMapsSearchUrl(place) : null;
  const addManually = (
    <button type="button" onClick={() => setManual(true)} className={buttonClass('secondary', 'md')}>
      <CalendarPlus className="size-4" aria-hidden />
      予定を手で追加
    </button>
  );

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:space-y-8 sm:py-8 lg:py-12">
      <div className="space-y-2">
        <h1 className="text-[24px] font-bold leading-snug text-balance sm:text-[26px]">通話を終了しました</h1>
        <p className="text-[15px] text-ink-2">{partnerLabel}との通話の記録は、この画面を閉じると消えます。</p>
      </div>

      <section aria-labelledby="schedule-heading" className="space-y-3">
        <SectionHeading id="schedule-heading">予定</SectionHeading>
        {manual && spokenPlace && ai.source === 'gemini' ? (
          <AppointmentReviewCard appointment={appointment} source={{ kind: 'ai', model: ai.model }} />
        ) : manual ? (
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
          <div className="space-y-3 rounded-xl border border-line bg-surface p-4 sm:p-5">
            <p className="text-[15px] text-ink-2">通話の中で、決まった予定は見つかりませんでした。</p>
            {placeMapsUrl && (
              <div className="space-y-1 text-[14px] leading-relaxed">
                <p className="text-ink-2">
                  会話に出た場所（AIの読み取り）：<span className="font-bold text-ink [overflow-wrap:anywhere]">{place}</span>
                </p>
                <a
                  href={placeMapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center gap-1.5 font-bold text-voice-strong underline underline-offset-2"
                >
                  <MapPin className="size-4 shrink-0" aria-hidden />
                  Googleマップで確かめる
                </a>
              </div>
            )}
            {addManually}
          </div>
        )}
      </section>

      <section aria-labelledby="record-heading" className="space-y-3">
        <SectionHeading id="record-heading">会話の記録</SectionHeading>
        {transcript.length > 0 ? (
          <details className="group rounded-xl border border-line bg-surface">
            <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 px-4 py-3 text-[15px] font-bold sm:px-5">
              <span>通話の記録を見る</span>
              <span className="font-normal text-ink-2 tabular-nums">{transcript.length}件</span>
            </summary>
            <ol className="space-y-3 border-t border-line px-4 py-4 sm:px-5">
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
