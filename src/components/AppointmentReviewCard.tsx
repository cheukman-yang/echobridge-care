"use client";

import { useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, CalendarDays, CalendarPlus, Info, MapPin, Navigation } from 'lucide-react';
import { useIsMobileFrame } from '@/contexts/MobileFrameContext';
import { useUserLanguage } from '@/contexts/UserLanguageContext';
import { MOCK_AI_MODEL } from '@/lib/aiMeta';
import {
  buildCalendarDayUrl,
  buildCalendarUrl,
  buildMapsDirectionsUrl,
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
  isEn = false,
  children,
}: {
  label: string;
  needsCheck?: boolean;
  fromAi?: boolean;
  isEn?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block min-w-0 space-y-1.5">
      {/* 印はラベルのすぐ後ろに置く。幅が狭いと次の行へ回るので、並んだ欄は下端でそろえる。 */}
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-bold text-ink-2">
        {label}
        {needsCheck && (
          <span className="rounded-full border border-caution-line bg-caution-soft px-2 py-0.5 text-[12px] font-bold text-caution">
            {isEn ? 'Required' : '要確認'}
          </span>
        )}
        {fromAi && (
          <span className="rounded-full border border-voice/40 bg-voice-soft px-2 py-0.5 text-[12px] font-bold text-voice-strong">
            {isEn ? 'AI Extracted' : 'AIの読み取り'}
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

function describeProblemEn(problem: ScheduleProblem): string {
  switch (problem.code) {
    case 'missing_date':
      return 'Please select an appointment date.';
    case 'missing_start':
      return 'Please enter a start time.';
    case 'past_date':
      return 'This date is in the past — please verify.';
    case 'past_time':
      return 'This time has already passed today — please verify.';
    case 'end_before_start':
      return 'End time must be after start time.';
    case 'differs_from_conversation':
      return 'Differs from what was spoken in the conversation — please double-check.';
  }
}

function describeIssueEn(item: AppointmentIssue): string {
  const value = item.value ?? '';
  switch (item.code) {
    case 'weekday_mismatch':
      return `The weekday of ${value} did not match "${item.said ?? ''}" in the call. Please confirm and select the date.`;
    case 'date_mismatch':
      return `Extracted date (${value}) did not match "${item.said ?? ''}" in the call. Please confirm and select the date.`;
    case 'past_date':
      return `Extracted date (${value}) is in the past. Please confirm and select the date.`;
    case 'not_in_conversation':
      return item.field === 'date'
        ? 'No specific date was mentioned in the call, so it was left blank. Please confirm and enter the date.'
        : 'No specific time was mentioned in the call, so it was left blank. Please confirm and enter the time.';
    case 'unclear_time':
      return `Could not determine an exact time from "${item.said ?? ''}". Please confirm and enter the time.`;
    case 'time_mismatch':
      return `Extracted time (${value}) did not match "${item.said ?? ''}" in the call. Please confirm and enter the time.`;
    case 'end_before_start':
      return `Extracted end time (${value}) was earlier than the start time, so it was left blank.`;
  }
}

/**
 * 予定を本人が確認・修正するカード。
 * AIが入れた値には印を付け、本人が直したら外す。AIの値と本人の入力を混同させない。
 * 日時がそろわない・矛盾している間はカレンダーへ進めない。保存するのはGoogleカレンダーの画面で、本人が押したとき。
 */
export function AppointmentReviewCard({ appointment, source }: AppointmentReviewCardProps) {
  const { userLanguage } = useUserLanguage();
  const isEn = userLanguage === 'en';
  const isMobileFrame = useIsMobileFrame();
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
  const directionsUrl = buildMapsDirectionsUrl(address.trim() || place);

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
    <div className="space-y-5 rounded-xl border border-line bg-surface p-4">
      {source.kind === 'ai' && source.model === MOCK_AI_MODEL ? (
        <p className="text-[14px] font-bold leading-relaxed text-caution">
          {isEn
            ? 'Scripted mock draft for development testing (not live AI).'
            : '開発用のモックが台本から作った下書きです（AIではありません）。「AIの読み取り」の印は、画面の確認のために付けています。'}
        </p>
      ) : source.kind === 'ai' ? (
        <p className="text-[14px] leading-relaxed text-ink-2">
          {isEn
            ? `Draft extracted by Gemini (${source.model}). Fields marked "AI Extracted" were pre-filled from the call — please review before adding to your calendar.`
            : `Geminiが通話内容から読み取った下書きです（${source.model}）。「AIの読み取り」と付いた項目はAIが入れた値です。正しいか確かめてから追加してください。`}
        </p>
      ) : (
        <p className="text-[14px] leading-relaxed text-ink-2">
          {isEn
            ? 'Manual calendar entry (AI was not used).'
            : `あなたが入力する予定です。AIは使っていません。${
                appointment.location
                  ? '予定の名前と場所には、発信のときの入力を入れています。'
                  : '予定の名前には、発信のときの用件を入れています。'
              }`}
        </p>
      )}

      <Field label={isEn ? 'Event Title' : '予定の名前'} fromAi={fromAi('title')} isEn={isEn}>
        <input
          value={draft.title}
          onChange={(event) => update({ title: event.target.value })}
          className={INPUT_CLASS}
        />
      </Field>

      <div className={cx('grid gap-5', !isMobileFrame && 'sm:grid-cols-2 sm:items-start')}>
        <div className="min-w-0 space-y-2">
          <Field label={isEn ? 'Date' : '日付'} needsCheck={!draft.date} fromAi={fromAi('date')} isEn={isEn}>
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
              <p className="text-[14px] font-bold text-ink tabular-nums">
                {isEn
                  ? new Date(`${draft.date}T00:00:00+09:00`).toLocaleDateString('en-US', {
                      weekday: 'short',
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                      timeZone: 'Asia/Tokyo',
                    })
                  : formatDateJa(draft.date)}
              </p>
            )}
            {draft.spoken?.date && (
              <Note tone="info">
                {isEn ? `Spoken in call: "${draft.spoken.date}"` : `会話での言い方：「${draft.spoken.date}」`}
              </Note>
            )}
            {dateNotes.issues.map((item) => (
              <Note key={item.code} tone="caution">
                {isEn ? describeIssueEn(item) : describeIssue(item)}
              </Note>
            ))}
            {dateNotes.blocking.map((problem) => (
              <Note key={problem.code} tone="danger">
                {isEn ? describeProblemEn(problem) : problem.message}
              </Note>
            ))}
            {dateNotes.warnings.map((problem) => (
              <Note key={problem.code} tone="caution">
                {isEn ? describeProblemEn(problem) : problem.message}
              </Note>
            ))}
          </div>
        </div>

        <div className="min-w-0 space-y-2">
          <div className="grid grid-cols-2 items-end gap-3">
            <Field
              label={isEn ? 'Start' : '開始'}
              needsCheck={!draft.startTime}
              fromAi={fromAi('startTime')}
              isEn={isEn}
            >
              <input
                type="time"
                value={draft.startTime ?? ''}
                onChange={(event) => update({ startTime: event.target.value || null })}
                aria-describedby="appointment-time-notes"
                aria-invalid={hasBlocking('startTime') || undefined}
                className={INPUT_CLASS}
              />
            </Field>
            <Field label={isEn ? 'End (Optional)' : '終了（任意）'} fromAi={fromAi('endTime')} isEn={isEn}>
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
            {draft.spoken?.time && (
              <Note tone="info">
                {isEn ? `Spoken in call: "${draft.spoken.time}"` : `会話での言い方：「${draft.spoken.time}」`}
              </Note>
            )}
            {timeNotes.issues.map((item) => (
              <Note key={`${item.field}-${item.code}`} tone="caution">
                {isEn ? describeIssueEn(item) : describeIssue(item)}
              </Note>
            ))}
            {timeNotes.blocking.map((problem) => (
              <Note key={`${problem.field}-${problem.code}`} tone="danger">
                {isEn ? describeProblemEn(problem) : problem.message}
              </Note>
            ))}
            {timeNotes.warnings.map((problem) => (
              <Note key={`${problem.field}-${problem.code}`} tone="caution">
                {isEn ? describeProblemEn(problem) : problem.message}
              </Note>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <Field label={isEn ? 'Clinic / Location' : '場所（施設名など）'} fromAi={fromAi('location')} isEn={isEn}>
          <input
            value={draft.location}
            onChange={(event) => update({ location: event.target.value })}
            className={INPUT_CLASS}
          />
        </Field>
        <Field label={isEn ? 'Address (Optional)' : '住所（任意）'} fromAi={fromAi('address')} isEn={isEn}>
          <input
            value={address}
            onChange={(event) => update({ address: event.target.value })}
            placeholder={isEn ? 'Address mentioned during the call' : '会話で話された住所だけが入ります'}
            className={INPUT_CLASS}
          />
        </Field>
        {mapsUrl && (
          <div className="space-y-1 text-[13px] leading-relaxed text-ink-2">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <a
                href={mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 max-w-full items-start gap-1.5 py-2.5 font-bold text-voice-strong underline underline-offset-2"
              >
                <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {isEn ? `Search "${place}" on Google Maps` : `Googleマップで「${place}」を検索`}
                </span>
              </a>
              {directionsUrl && (
                <a
                  href={directionsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 max-w-full items-start gap-1.5 py-2.5 font-bold text-voice-strong underline underline-offset-2"
                >
                  <Navigation className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span className="min-w-0">
                    {isEn ? 'Open Directions to This Location' : 'この場所への経路案内を開く'}
                  </span>
                </a>
              )}
            </div>
            <p>
              {isEn
                ? 'Please verify the destination on Google Maps before heading out.'
                : '検索結果が目的の場所か確かめてください。施設や住所は自動では決めません。'}
            </p>
          </div>
        )}
      </div>

      <Field label={isEn ? 'Notes (Items to bring)' : 'メモ（持ち物など）'} fromAi={fromAi('details')} isEn={isEn}>
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
          className={buttonClass('primary', 'lg', 'w-full px-4')}
        >
          <CalendarPlus className="size-5 shrink-0" aria-hidden />
          {isEn ? (
            <span>Add to Google Calendar</span>
          ) : (
            <span className="min-w-0 text-left">
              <span className="whitespace-nowrap">Google カレンダー</span>
              <span className="whitespace-nowrap">に追加</span>
            </span>
          )}
        </button>
        <div id="appointment-calendar-status" className="text-[13px] leading-relaxed text-ink-2">
          {ready ? (
            <p>
              {isEn
                ? 'Opens Google Calendar in a new tab so you can review and save the event.'
                : 'Googleカレンダーの作成画面が開きます。保存はその画面で行います。'}
            </p>
          ) : (
            <>
              <p className="font-bold text-ink">
                {isEn ? 'Please complete the following before adding:' : '追加する前に、次を直してください。'}
              </p>
              <ul className="list-disc space-y-0.5 pl-5">
                {check.blocking.map((problem) => (
                  <li key={`${problem.field}-${problem.code}`}>
                    {isEn ? describeProblemEn(problem) : problem.message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <a
          href={buildCalendarDayUrl(draft.date)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 max-w-full items-start gap-1.5 py-2.5 text-[14px] font-bold text-voice-strong underline underline-offset-2"
        >
          <CalendarDays className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0">
            {isEn
              ? draft.date
                ? 'View this day in Google Calendar'
                : 'Open Google Calendar'
              : draft.date
              ? 'この日の予定をGoogleカレンダーで見る'
              : 'Googleカレンダーで予定を見る'}
          </span>
        </a>
      </div>
    </div>
  );
}
