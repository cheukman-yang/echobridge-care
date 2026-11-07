import type { AppointmentDraft } from './callProtocol';

const TIME_ZONE = 'Asia/Tokyo';
const CALENDAR_BASE_URL = 'https://calendar.google.com/calendar/render';
const DEFAULT_DURATION_MINUTES = 60;
const LAST_MINUTE_OF_DAY = 23 * 60 + 59;

const TOKYO_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const TOKYO_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const TOKYO_WEEKDAY = new Intl.DateTimeFormat('ja-JP', { timeZone: TIME_ZONE, weekday: 'short' });

/** Cloud RunはUTCで動くので、「今日」は実行環境ではなく日本時間で決める。 */
export function tokyoToday(now: Date): string {
  return TOKYO_DATE.format(now);
}

/** Geminiに渡す現在日時の表記。 */
export function formatTokyoNow(now: Date): string {
  return `${tokyoToday(now)}(${TOKYO_WEEKDAY.format(now)}) ${TOKYO_TIME.format(now)} ${TIME_ZONE}`;
}

export function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function fromMinutes(total: number): string {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export interface RawAppointment {
  title: string | null;
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  details: string | null;
}

/**
 * Geminiの出力を画面に出せる値へ絞る。
 * 形式が不正な値や過去の日付は、誤った確定情報に見せないよう「要確認」(null) に落とす。
 */
export function sanitizeAppointment(
  raw: RawAppointment,
  defaults: { title: string; location: string },
  today: string,
): AppointmentDraft {
  const date = raw.date && isValidDate(raw.date) && raw.date >= today ? raw.date : null;
  const startTime = raw.startTime && isValidTime(raw.startTime) ? raw.startTime : null;
  const endCandidate = raw.endTime && isValidTime(raw.endTime) ? raw.endTime : null;
  const endTime =
    startTime && endCandidate && toMinutes(endCandidate) > toMinutes(startTime) ? endCandidate : null;

  return {
    title: raw.title?.trim() || defaults.title,
    date,
    startTime,
    endTime,
    location: defaults.location,
    details: raw.details?.trim() ?? '',
  };
}

export interface ConfirmedAppointment extends AppointmentDraft {
  date: string;
  startTime: string;
}

export function isReadyForCalendar(draft: AppointmentDraft): draft is ConfirmedAppointment {
  return (
    draft.date !== null &&
    isValidDate(draft.date) &&
    draft.startTime !== null &&
    isValidTime(draft.startTime)
  );
}

function resolveEndTime(startTime: string, endTime: string | null): string {
  const start = toMinutes(startTime);
  if (endTime && isValidTime(endTime) && toMinutes(endTime) > start) return endTime;
  return fromMinutes(Math.min(start + DEFAULT_DURATION_MINUTES, LAST_MINUTE_OF_DAY));
}

function toCalendarStamp(date: string, time: string): string {
  return `${date.replaceAll('-', '')}T${time.replace(':', '')}00`;
}

/** Googleカレンダーの作成画面を開くURL。最後に保存するのは本人。 */
export function buildCalendarUrl(appointment: ConfirmedAppointment): string {
  const { date, startTime, endTime, title, location, details } = appointment;
  const start = toCalendarStamp(date, startTime);
  const end = toCalendarStamp(date, resolveEndTime(startTime, endTime));
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${start}/${end}`,
    ctz: TIME_ZONE,
    location,
    details,
  });
  return `${CALENDAR_BASE_URL}?${params.toString()}`;
}
