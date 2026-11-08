import { useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, CalendarDays, CalendarPlus, Info, MapPin } from 'lucide-react';
import { MOCK_AI_MODEL } from '@/lib/aiMeta';
import {
  buildCalendarDayUrl,
  buildCalendarUrl,
  buildMapsSearchUrl,
  checkSchedule,
  describeIssue,
  formatDateJa,
  isReadyForCalendar,
  isValidDate,
  joinPlace,
} from '@/lib/appointment';
import type { ScheduleProblem } from '@/lib/appointment';
import type { AppointmentDraft, AppointmentField, AppointmentIssue } from '@/lib/callProtocol';
import { buttonClass, cx } from './ui';

/** 下書きの出どころ。AIが読み取ったものか、本人が一から入力するものか。 */
export type AppointmentSource = { kind: 'ai'; model: string } | { kind: 'manual' };

interface AppointmentReviewCardProps {
  appointment: AppointmentDraft;
  source: AppointmentSource;
}

// 高さは48px。日付と時刻の欄は、iOSで空のときに潰れないよう globals.css でも補う。
const INPUT_CLASS =
  'block min-h-12 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-3 py-2.5 text-[16px] text-ink focus:border-voice aria-invalid:border-danger';

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
    <label className="block min-w-0 space-y-1.5">
      {/* 印はラベルのすぐ後ろに置く。幅が狭いと次の行へ回るので、並んだ欄は下端でそろえる。 */}
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-bold text-ink-2">
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

type NoteTone = 'info' | 'caution' | 'danger';

const NOTE_TONES: Record<NoteTone, string> = {
  info: 'text-ink-2',
  caution: 'text-caution',
  danger: 'text-danger-strong',
};

function Note({ tone, children }: { tone: NoteTone; children: ReactNode }) {
  const Icon = tone === 'info' ? Info : AlertTriangle;
  return (
    <p className={cx('flex items-start gap-1.5 text-[13px] leading-relaxed', NOTE_TONES[tone], tone !== 'info' && 'font-bold')}>
      <Icon className="mt-[3px] size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 text-pretty [overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}

/**
 * 予定を本人が確認・修正するカード。
 * AIが入れた値には印を付け、本人が直したら外す。AIの値と本人の入力を混同させない。
 * 日時がそろわない・矛盾している間はカレンダーへ進めない。保存するのはGoogleカレンダーの画面で、本人が押したとき。
 */
export function AppointmentReviewCard({ appointment, source }: AppointmentReviewCardProps) {
  const [draft, setDraft] = useState(appointment);
  // 過ぎた日時の判定に使う。カードを開いた時刻で十分で、表示のたびに変わらない値にする。
  const [openedAt] = useState(() => new Date());
  const update = (patch: Partial<AppointmentDraft>) => setDraft((prev) => ({ ...prev, ...patch }));
  const check = checkSchedule(draft, openedAt);
  const ready = check.blocking.length === 0 && isReadyForCalendar(draft);
  const address = draft.address ?? '';
  // 本人が直した場所で検索する。カレンダーに追加するときも同じ値を使う。
  const place = joinPlace(draft.location, address);
  const mapsUrl = buildMapsSearchUrl(place);

  const aiFields = new Set<AppointmentField>(source.kind === 'ai' ? (appointment.aiFields ?? []) : []);
  // AIが入れた値のまま残っている項目だけに印を付ける。
  const fromAi = (field: AppointmentField) =>
    aiFields.has(field) && draft[field] === appointment[field];

  // AIの日時を採用しなかった理由。本人がその欄を入れるまで見せる。
  const pendingIssues = (fields: AppointmentIssue['field'][]) =>
    (appointment.issues ?? []).filter(
      (item) => fields.includes(item.field) && draft[item.field] === appointment[item.field],
    );
  const problemsFor = (fields: ScheduleProblem['field'][], list: ScheduleProblem[]) =>
    list.filter(
      (problem) =>
        fields.includes(problem.field) && problem.code !== 'missing_date' && problem.code !== 'missing_start',
    );
  const hasBlocking = (field: ScheduleProblem['field']) =>
    check.blocking.some((problem) => problem.field === field && !problem.code.startsWith('missing'));

  const dateNotes = {
    issues: pendingIssues(['date']),
    blocking: problemsFor(['date'], check.blocking),
    warnings: problemsFor(['date'], check.warnings),
  };
  const timeNotes = {
    issues: pendingIssues(['startTime', 'endTime']),
    blocking: problemsFor(['startTime', 'endTime'], check.blocking),
    warnings: problemsFor(['startTime', 'endTime'], check.warnings),
  };

  const openCalendar = () => {
    if (ready && isReadyForCalendar(draft)) {
      window.open(buildCalendarUrl(draft), '_blank', 'noopener');
    }
  };

  return (
    <div className="space-y-5 rounded-xl border border-line bg-surface p-4 sm:p-5">
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

      <Field label="予定の名前" fromAi={fromAi('title')}>
        <input
          value={draft.title}
          onChange={(event) => update({ title: event.target.value })}
          className={INPUT_CLASS}
        />
      </Field>

      {/* スマートフォンでは縦に並べ、広い画面では日付と時刻を横に並べる。 */}
      <div className="grid gap-5 sm:grid-cols-2 sm:items-start">
        <div className="min-w-0 space-y-2">
          <Field label="日付" needsCheck={!draft.date} fromAi={fromAi('date')}>
            <input
              type="date"
              value={draft.date ?? ''}
              onChange={(event) => update({ date: event.target.value || null })}
              aria-describedby="appointment-date-notes"
              aria-invalid={hasBlocking('date') || undefined}
              className={INPUT_CLASS}
            />
          </Field>
          <div id="appointment-date-notes" className="space-y-1">
            {draft.date && isValidDate(draft.date) && (
              <p className="text-[14px] font-bold text-ink tabular-nums">{formatDateJa(draft.date)}</p>
            )}
            {draft.spoken?.date && <Note tone="info">会話での言い方：「{draft.spoken.date}」</Note>}
            {dateNotes.issues.map((item) => (
              <Note key={item.code} tone="caution">
                {describeIssue(item)}
              </Note>
            ))}
            {dateNotes.blocking.map((problem) => (
              <Note key={problem.code} tone="danger">
                {problem.message}
              </Note>
            ))}
            {dateNotes.warnings.map((problem) => (
              <Note key={problem.code} tone="caution">
                {problem.message}
              </Note>
            ))}
          </div>
        </div>

        <div className="min-w-0 space-y-2">
          <div className="grid grid-cols-2 items-end gap-3">
            <Field label="開始" needsCheck={!draft.startTime} fromAi={fromAi('startTime')}>
              <input
                type="time"
                value={draft.startTime ?? ''}
                onChange={(event) => update({ startTime: event.target.value || null })}
                aria-describedby="appointment-time-notes"
                aria-invalid={hasBlocking('startTime') || undefined}
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="終了（任意）" fromAi={fromAi('endTime')}>
              <input
                type="time"
                value={draft.endTime ?? ''}
                onChange={(event) => update({ endTime: event.target.value || null })}
                aria-describedby="appointment-time-notes"
                aria-invalid={hasBlocking('endTime') || undefined}
                className={INPUT_CLASS}
              />
            </Field>
          </div>
          <div id="appointment-time-notes" className="space-y-1">
            {draft.spoken?.time && <Note tone="info">会話での言い方：「{draft.spoken.time}」</Note>}
            {timeNotes.issues.map((item) => (
              <Note key={`${item.field}-${item.code}`} tone="caution">
                {describeIssue(item)}
              </Note>
            ))}
            {timeNotes.blocking.map((problem) => (
              <Note key={`${problem.field}-${problem.code}`} tone="danger">
                {problem.message}
              </Note>
            ))}
            {timeNotes.warnings.map((problem) => (
              <Note key={`${problem.field}-${problem.code}`} tone="caution">
                {problem.message}
              </Note>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <Field label="場所（施設名など）" fromAi={fromAi('location')}>
          <input
            value={draft.location}
            onChange={(event) => update({ location: event.target.value })}
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="住所（任意）" fromAi={fromAi('address')}>
          <input
            value={address}
            onChange={(event) => update({ address: event.target.value })}
            placeholder="会話で話された住所だけが入ります"
            className={INPUT_CLASS}
          />
        </Field>
        {mapsUrl && (
          <div className="text-[13px] leading-relaxed text-ink-2">
            <a
              href={mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 max-w-full items-start gap-1.5 py-2.5 font-bold text-voice-strong underline underline-offset-2"
            >
              <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="min-w-0 [overflow-wrap:anywhere]">Googleマップで「{place}」を検索</span>
            </a>
            <p>検索結果が目的の場所か確かめてください。施設や住所は自動では決めません。</p>
          </div>
        )}
      </div>

      <Field label="メモ（持ち物など）" fromAi={fromAi('details')}>
        <textarea
          value={draft.details}
          onChange={(event) => update({ details: event.target.value })}
          rows={2}
          className={`${INPUT_CLASS} resize-none leading-relaxed`}
        />
      </Field>

      <div className="space-y-2 border-t border-line pt-4">
        <button
          type="button"
          onClick={openCalendar}
          disabled={!ready}
          aria-describedby="appointment-calendar-status"
          className={buttonClass('primary', 'lg', 'w-full px-4 sm:w-auto sm:px-6')}
        >
          <CalendarPlus className="size-5 shrink-0" aria-hidden />
          {/* 狭い画面や大きな文字で折り返すときは、語の途中で切らない。 */}
          <span className="min-w-0 text-left">
            <span className="whitespace-nowrap">Google カレンダー</span>
            <span className="whitespace-nowrap">に追加</span>
          </span>
        </button>
        {/* 入力のたびに読み上げないよう、ライブ領域にはしない。ボタンの説明として読まれる。 */}
        <div id="appointment-calendar-status" className="text-[13px] leading-relaxed text-ink-2">
          {ready ? (
            <p>Googleカレンダーの作成画面が開きます。保存はその画面で行います。</p>
          ) : (
            <>
              <p className="font-bold text-ink">追加する前に、次を直してください。</p>
              <ul className="list-disc space-y-0.5 pl-5">
                {check.blocking.map((problem) => (
                  <li key={`${problem.field}-${problem.code}`}>{problem.message}</li>
                ))}
              </ul>
            </>
          )}
        </div>
        {/* 地図のリンクと同じ形。狭い画面でも文の途中で不自然に折り返さない。 */}
        <a
          href={buildCalendarDayUrl(draft.date)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 max-w-full items-start gap-1.5 py-2.5 text-[14px] font-bold text-voice-strong underline underline-offset-2"
        >
          <CalendarDays className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0">
            {draft.date ? 'この日の予定をGoogleカレンダーで見る' : 'Googleカレンダーで予定を見る'}
          </span>
        </a>
      </div>
    </div>
  );
}
