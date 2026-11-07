import { useState } from 'react';
import type { ReactNode } from 'react';
import { CalendarPlus } from 'lucide-react';
import { AI_FAILURE_LABELS } from '@/lib/aiMeta';
import type { AiMeta } from '@/lib/aiMeta';
import { buildCalendarUrl, isReadyForCalendar } from '@/lib/appointment';
import type { AppointmentDraft } from '@/lib/callProtocol';
import { Notice, buttonClass } from './ui';

interface AppointmentReviewCardProps {
  appointment: AppointmentDraft;
  ai: AiMeta;
}

const INPUT_CLASS =
  'w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5 text-[16px] text-ink focus:border-voice';

function Field({
  label,
  needsCheck = false,
  children,
}: {
  label: string;
  needsCheck?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="flex items-center justify-between gap-2 text-[13px] font-bold text-ink-2">
        {label}
        {needsCheck && (
          <span className="rounded-full border border-caution-line bg-caution-soft px-2 py-0.5 text-[12px] font-bold text-caution">
            要確認
          </span>
        )}
      </span>
      {children}
    </label>
  );
}

/**
 * 通話から読み取った予定を本人が確認・修正するカード。
 * 分からなかった項目は空欄のまま見せ、日付と開始時刻がそろうまでカレンダーへ進めない。
 * 保存するのはGoogleカレンダーの画面で、本人が押したとき。
 */
export function AppointmentReviewCard({ appointment, ai }: AppointmentReviewCardProps) {
  const [draft, setDraft] = useState(appointment);
  const update = (patch: Partial<AppointmentDraft>) => setDraft((prev) => ({ ...prev, ...patch }));
  const ready = isReadyForCalendar(draft);

  const openCalendar = () => {
    if (isReadyForCalendar(draft)) {
      window.open(buildCalendarUrl(draft), '_blank', 'noopener');
    }
  };

  return (
    <div className="space-y-4 rounded-xl border border-line bg-surface p-5">
      {ai.source === 'gemini' ? (
        <p className="text-[14px] leading-relaxed text-ink-2">
          Geminiが通話内容から読み取った下書きです（{ai.model}）。正しいか確かめてから追加してください。
        </p>
      ) : (
        <Notice tone="caution" role="alert" title="AIで読み取れませんでした">
          {AI_FAILURE_LABELS[ai.reason]}。日時は自動で入力していません。通話の記録を見て入力してください。
        </Notice>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="予定の名前">
            <input
              value={draft.title}
              onChange={(event) => update({ title: event.target.value })}
              className={INPUT_CLASS}
            />
          </Field>
        </div>
        <Field label="日付" needsCheck={!draft.date}>
          <input
            type="date"
            value={draft.date ?? ''}
            onChange={(event) => update({ date: event.target.value || null })}
            className={INPUT_CLASS}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="開始" needsCheck={!draft.startTime}>
            <input
              type="time"
              value={draft.startTime ?? ''}
              onChange={(event) => update({ startTime: event.target.value || null })}
              className={INPUT_CLASS}
            />
          </Field>
          <Field label="終了（任意）">
            <input
              type="time"
              value={draft.endTime ?? ''}
              onChange={(event) => update({ endTime: event.target.value || null })}
              className={INPUT_CLASS}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="場所">
            <input
              value={draft.location}
              onChange={(event) => update({ location: event.target.value })}
              className={INPUT_CLASS}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="メモ（持ち物など）">
            <textarea
              value={draft.details}
              onChange={(event) => update({ details: event.target.value })}
              rows={2}
              className={`${INPUT_CLASS} resize-none leading-relaxed`}
            />
          </Field>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          onClick={openCalendar}
          disabled={!ready}
          className={buttonClass('primary', 'lg')}
        >
          <CalendarPlus className="size-5" aria-hidden />
          Google カレンダーに追加
        </button>
        <p className="text-[13px] text-ink-2">
          {ready
            ? 'Googleカレンダーの作成画面が開きます。保存はその画面で行います。'
            : '日付と開始時刻を入力すると追加できます'}
        </p>
      </div>
    </div>
  );
}
