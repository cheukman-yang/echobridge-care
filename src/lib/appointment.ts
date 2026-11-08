import type { AppointmentDraft, AppointmentField } from './callProtocol';

const TIME_ZONE = 'Asia/Tokyo';
const CALENDAR_BASE_URL = 'https://calendar.google.com/calendar/render';
/** Googleカレンダーの画面。本人が自分の予定を見るために開く。予定は読まない。 */
const CALENDAR_HOME_URL = 'https://calendar.google.com/calendar/r';
/** Maps URLs の検索（APIキー不要）。https://developers.google.com/maps/documentation/urls/get-started */
const MAPS_SEARCH_URL = 'https://www.google.com/maps/search/';
/** URLは2,048文字まで。日本語は1文字9バイト分に広がるので、検索語は短く切る。 */
const MAX_MAP_QUERY_LENGTH = 100;
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
  /** 古い応答や、場所を返さない呼び出しでは undefined。 */
  location?: string | null;
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

  const fromAi: Record<AppointmentField, boolean> = {
    title: Boolean(raw.title?.trim()),
    date: date !== null,
    startTime: startTime !== null,
    endTime: endTime !== null,
    location: Boolean(raw.location?.trim()),
    details: Boolean(raw.details?.trim()),
  };

  return {
    title: raw.title?.trim() || defaults.title,
    date,
    startTime,
    endTime,
    location: raw.location?.trim() || defaults.location,
    details: raw.details?.trim() ?? '',
    aiFields: (Object.keys(fromAi) as AppointmentField[]).filter((field) => fromAi[field]),
  };
}

/**
 * 通話から予定が読み取れたか。日付も時刻もなければ、予定の話はなかったものとして扱う。
 * 予定がない通話で、予約が済んだような画面を出さないために使う。
 */
export function hasScheduleHint(draft: AppointmentDraft): boolean {
  return draft.date !== null || draft.startTime !== null;
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

/**
 * Googleマップで場所を検索するURL。検索結果を本人が確かめるためのもので、施設や住所を確定しない。
 * 場所が空なら null。
 */
export function buildMapsSearchUrl(location: string): string | null {
  const query = location.trim().slice(0, MAX_MAP_QUERY_LENGTH);
  if (!query) return null;
  return `${MAPS_SEARCH_URL}?${new URLSearchParams({ api: '1', query }).toString()}`;
}

/** Googleカレンダーを開くURL。日付があればその日の表示にする。本人がGoogleにログインして自分で見る。 */
export function buildCalendarDayUrl(date: string | null): string {
  if (!date || !isValidDate(date)) return CALENDAR_HOME_URL;
  const [year, month, day] = date.split('-').map(Number);
  return `${CALENDAR_HOME_URL}/day/${year}/${month}/${day}`;
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
