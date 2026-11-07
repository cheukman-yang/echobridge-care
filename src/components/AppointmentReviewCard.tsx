import { useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, Calendar, Check } from 'lucide-react';
import { AI_FAILURE_LABELS } from '@/lib/aiMeta';
import type { AiMeta } from '@/lib/aiMeta';
import { buildCalendarUrl, isReadyForCalendar } from '@/lib/appointment';
import type { AppointmentDraft } from '@/lib/callProtocol';

export interface TranscriptLine {
  id: string;
  speaker: string;
  text: string;
}

interface AppointmentReviewCardProps {
  appointment: AppointmentDraft;
  ai: AiMeta;
  transcript: TranscriptLine[];
  onBack: () => void;
}

const INPUT_CLASS =
  'w-full bg-slate-900 text-white text-sm rounded-lg px-2.5 py-1.5 border border-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500';

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
    <label className="block space-y-1">
      <span className="flex items-center justify-between text-xs text-slate-400">
        {label}
        {needsCheck && (
          <span className="text-[10px] font-bold text-amber-300 bg-amber-500/15 border border-amber-500/40 rounded-full px-1.5">
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
 */
export function AppointmentReviewCard({
  appointment,
  ai,
  transcript,
  onBack,
}: AppointmentReviewCardProps) {
  const [draft, setDraft] = useState(appointment);
  const update = (patch: Partial<AppointmentDraft>) => setDraft((prev) => ({ ...prev, ...patch }));
  const ready = isReadyForCalendar(draft);

  const openCalendar = () => {
    if (isReadyForCalendar(draft)) {
      window.open(buildCalendarUrl(draft), '_blank', 'noopener');
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3 animate-in fade-in duration-300">
      <div className="text-center space-y-1">
        <div className="w-10 h-10 bg-green-500/20 rounded-full flex items-center justify-center mx-auto">
          <Check className="w-5 h-5 text-green-400" />
        </div>
        <h2 className="text-base font-bold text-white">通話が完了しました</h2>
        <p className="text-xs text-slate-300">内容を確認し、必要なら直してから追加してください</p>
      </div>

      {ai.source === 'gemini' ? (
        <p className="text-xs text-slate-300 bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5">
          Geminiが通話内容から読み取った下書きです ({ai.model})
        </p>
      ) : (
        <p
          role="alert"
          className="flex items-start gap-1.5 text-xs leading-snug text-amber-200 bg-amber-500/10 border border-amber-500/40 rounded-lg px-2.5 py-1.5"
        >
          <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" />
          <span>
            <strong className="font-bold">AIで読み取れませんでした</strong>
            <br />
            {AI_FAILURE_LABELS[ai.reason]}。日時は自動で入力していません。下の通話の記録を見て入力してください。
          </span>
        </p>
      )}

      <div className="bg-slate-800 rounded-2xl p-3 border border-slate-700 space-y-2.5">
        <Field label="予定の名前">
          <input
            value={draft.title}
            onChange={(event) => update({ title: event.target.value })}
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="日付" needsCheck={!draft.date}>
          <input
            type="date"
            value={draft.date ?? ''}
            onChange={(event) => update({ date: event.target.value || null })}
            className={INPUT_CLASS}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="開始" needsCheck={!draft.startTime}>
            <input
              type="time"
              value={draft.startTime ?? ''}
              onChange={(event) => update({ startTime: event.target.value || null })}
              className={INPUT_CLASS}
            />
          </Field>
          <Field label="終了 (任意)">
            <input
              type="time"
              value={draft.endTime ?? ''}
              onChange={(event) => update({ endTime: event.target.value || null })}
              className={INPUT_CLASS}
            />
          </Field>
        </div>
        <Field label="場所">
          <input
            value={draft.location}
            onChange={(event) => update({ location: event.target.value })}
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="メモ (持ち物など)">
          <textarea
            value={draft.details}
            onChange={(event) => update({ details: event.target.value })}
            rows={2}
            className={`${INPUT_CLASS} resize-none`}
          />
        </Field>
      </div>

      {transcript.length > 0 && (
        <details className="text-xs text-slate-300 bg-slate-800/60 border border-slate-700 rounded-lg px-2.5 py-1.5">
          <summary className="cursor-pointer font-medium">通話の記録を見る</summary>
          <ul className="mt-2 space-y-1.5">
            {transcript.map((line) => (
              <li key={line.id}>
                <span className="text-slate-500">{line.speaker}: </span>
                {line.text}
              </li>
            ))}
          </ul>
        </details>
      )}

      <button
        type="button"
        onClick={openCalendar}
        disabled={!ready}
        className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:pointer-events-none text-white font-bold py-3 rounded-xl flex justify-center items-center gap-2 transition text-sm shadow-lg active:scale-95"
      >
        <Calendar className="w-4 h-4" />
        Google カレンダーに追加
      </button>
      {!ready && (
        <p className="text-xs text-center text-amber-200">日付と開始時刻を入力すると追加できます</p>
      )}

      <button
        type="button"
        onClick={onBack}
        className="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 py-2.5 rounded-xl transition text-xs font-medium"
      >
        最初の画面に戻る
      </button>
    </div>
  );
}
