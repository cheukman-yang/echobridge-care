import { useState } from 'react';
import type { ReactNode } from 'react';
import { CalendarDays, CalendarPlus, MapPin } from 'lucide-react';
import { MOCK_AI_MODEL } from '@/lib/aiMeta';
import { buildCalendarDayUrl, buildCalendarUrl, buildMapsSearchUrl, isReadyForCalendar } from '@/lib/appointment';
import type { AppointmentDraft, AppointmentField } from '@/lib/callProtocol';
import { buttonClass } from './ui';

/** 下書きの出どころ。AIが読み取ったものか、本人が一から入力するものか。 */
export type AppointmentSource = { kind: 'ai'; model: string } | { kind: 'manual' };

interface AppointmentReviewCardProps {
  appointment: AppointmentDraft;
  source: AppointmentSource;
}

const INPUT_CLASS =
  'w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5 text-[16px] text-ink focus:border-voice';

function Field({
  label,
  needsCheck = false,
  fromAi = false,
  children,
}: {
  label: string;
  needsCheck?: boolean;
  fromAi?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="flex flex-wrap items-center justify-between gap-2 text-[13px] font-bold text-ink-2">
        {label}
        {needsCheck && (
          <span className="rounded-full border border-caution-line bg-caution-soft px-2 py-0.5 text-[12px] font-bold text-caution">
            要確認
          </span>
        )}
        {fromAi && (
          <span className="rounded-full border border-voice/40 bg-voice-soft px-2 py-0.5 text-[12px] font-bold text-voice-strong">
            AIの読み取り
          </span>
        )}
      </span>
      {children}
    </label>
  );
}

/**
 * 予定を本人が確認・修正するカード。
 * AIが入れた値には印を付け、本人が直したら外す。AIの値と本人の入力を混同させない。
 * 日付と開始時刻がそろうまでカレンダーへ進めない。保存するのはGoogleカレンダーの画面で、本人が押したとき。
 */
export function AppointmentReviewCard({ appointment, source }: AppointmentReviewCardProps) {
  const [draft, setDraft] = useState(appointment);
  const update = (patch: Partial<AppointmentDraft>) => setDraft((prev) => ({ ...prev, ...patch }));
  const ready = isReadyForCalendar(draft);
  // 本人が直した場所で検索する。カレンダーに追加するときも同じ値を使う。
  const mapsUrl = buildMapsSearchUrl(draft.location);

  const aiFields = new Set<AppointmentField>(source.kind === 'ai' ? (appointment.aiFields ?? []) : []);
  // AIが入れた値のまま残っている項目だけに印を付ける。
  const fromAi = (field: AppointmentField) =>
    aiFields.has(field) && draft[field] === appointment[field];

  const openCalendar = () => {
    if (isReadyForCalendar(draft)) {
      window.open(buildCalendarUrl(draft), '_blank', 'noopener');
    }
  };

  return (
    <div className="space-y-4 rounded-xl border border-line bg-surface p-5">
      {source.kind === 'ai' && source.model === MOCK_AI_MODEL ? (
        <p className="text-[14px] font-bold leading-relaxed text-caution">
          開発用のモックが台本から作った下書きです（AIではありません）。「AIの読み取り」の印は、画面の確認のために付けています。
        </p>
      ) : source.kind === 'ai' ? (
        <p className="text-[14px] leading-relaxed text-ink-2">
          Geminiが通話内容から読み取った下書きです（{source.model}）。「AIの読み取り」と付いた項目はAIが入れた値です。正しいか確かめてから追加してください。
        </p>
      ) : (
        <p className="text-[14px] leading-relaxed text-ink-2">
          あなたが入力する予定です。AIは使っていません。
          {appointment.location
            ? '予定の名前と場所には、発信のときの入力を入れています。'
            : '予定の名前には、発信のときの用件を入れています。'}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="予定の名前" fromAi={fromAi('title')}>
            <input
              value={draft.title}
              onChange={(event) => update({ title: event.target.value })}
              className={INPUT_CLASS}
            />
          </Field>
        </div>
        <Field label="日付" needsCheck={!draft.date} fromAi={fromAi('date')}>
          <input
            type="date"
            value={draft.date ?? ''}
            onChange={(event) => update({ date: event.target.value || null })}
            className={INPUT_CLASS}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="開始" needsCheck={!draft.startTime} fromAi={fromAi('startTime')}>
            <input
              type="time"
              value={draft.startTime ?? ''}
              onChange={(event) => update({ startTime: event.target.value || null })}
              className={INPUT_CLASS}
            />
          </Field>
          <Field label="終了（任意）" fromAi={fromAi('endTime')}>
            <input
              type="time"
              value={draft.endTime ?? ''}
              onChange={(event) => update({ endTime: event.target.value || null })}
              className={INPUT_CLASS}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="場所" fromAi={fromAi('location')}>
            <input
              value={draft.location}
              onChange={(event) => update({ location: event.target.value })}
              className={INPUT_CLASS}
            />
          </Field>
          {mapsUrl && (
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
              <a
                href={mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-1.5 font-bold text-voice-strong underline underline-offset-2"
              >
                <MapPin className="size-4 shrink-0" aria-hidden />
                Googleマップで「{draft.location.trim()}」を検索
              </a>
              <span className="block">
                検索結果が目的の場所か確かめてください。施設や住所は自動では決めません。
              </span>
            </p>
          )}
        </div>
        <div className="sm:col-span-2">
          <Field label="メモ（持ち物など）" fromAi={fromAi('details')}>
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
      <a
        href={buildCalendarDayUrl(draft.date)}
        target="_blank"
        rel="noopener noreferrer"
        className={buttonClass('quiet', 'md', '-ml-4')}
      >
        <CalendarDays className="size-4" aria-hidden />
        {draft.date ? 'この日の予定をGoogleカレンダーで見る' : 'Googleカレンダーで予定を見る'}
      </a>
    </div>
  );
}
