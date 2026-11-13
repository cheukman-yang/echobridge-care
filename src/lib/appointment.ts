import type {
  AppointmentDraft,
  AppointmentField,
  AppointmentIssue,
  AppointmentIssueCode,
} from './callProtocol';

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
const WEEKDAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'] as const;

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

/** 日本時間の今の時刻（HH:mm）。 */
export function tokyoTimeNow(now: Date): string {
  return TOKYO_TIME.format(now);
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

/** 日付の曜日（0が日曜）。日付は YYYY-MM-DD。 */
export function weekdayOf(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** 画面に出す日付。「11月12日（木）」。 */
export function formatDateJa(date: string): string {
  const [, month, day] = date.split('-').map(Number);
  return `${month}月${day}日（${WEEKDAY_NAMES[weekdayOf(date)]}）`;
}

// ---------------------------------------------------------------------------
// 会話の言葉との照合
//
// Geminiには、日時の値と一緒に「根拠になった会話の言葉」をそのまま抜き出してもらう。
// その言葉が本当に会話の中にあるか、値と言葉が矛盾しないか（曜日、「明日」、午前・午後など）を
// ここで機械的に確かめ、合わない値は採用しない。AIが会話にない日時や場所を補わないようにするため。
// ---------------------------------------------------------------------------

/** 照合のための表記ゆれの吸収。全角の英数字を半角にし、空白と記号を除く。 */
function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\s、。,.!?「」『』()［］[\]【】・:〜~\-ー]/g, '');
}

/** 抜き出した言葉が、元の文のどれかにそのまま含まれるか。 */
export function isQuotedFrom(quote: string, sources: readonly string[]): boolean {
  const target = normalizeForMatch(quote);
  if (!target) return false;
  return sources.some((source) => normalizeForMatch(source).includes(target));
}

const KANJI_DIGITS: Record<string, number> = {
  〇: 0,
  零: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 「十二」「二十三」のような100未満の漢数字を算用数字にする。読めない並びはそのまま残す。 */
function kanjiNumeralsToDigits(text: string): string {
  return text.replace(/[〇零一二三四五六七八九十]+/g, (run) => {
    const parts = run.split('十');
    if (parts.length === 1) return [...run].map((char) => KANJI_DIGITS[char]).join('');
    if (parts.length > 2 || parts[0].length > 1 || parts[1].length > 1) return run;
    const tens = parts[0] === '' ? 1 : KANJI_DIGITS[parts[0]];
    const ones = parts[1] === '' ? 0 : KANJI_DIGITS[parts[1]];
    return String(tens * 10 + ones);
  });
}

function prepareForParsing(text: string): string {
  return kanjiNumeralsToDigits(text.normalize('NFKC'));
}

interface DateFacts {
  month?: number;
  day?: number;
  weekday?: number;
  daysFromToday?: number;
}

const RELATIVE_DAYS: ReadonlyArray<readonly [RegExp, number]> = [
  [/明明後日|しあさって/, 3],
  [/明後日|あさって/, 2],
  [/明日|あした|あす/, 1],
  [/今日|本日|きょう/, 0],
];

/** 日付の言い方から、確かめられる事実（月、日、曜日、「明日」など）を読む。 */
function readDateFacts(text: string): DateFacts {
  const prepared = prepareForParsing(text);
  const facts: DateFacts = {};
  // 「3日後」「2日間」は日付ではないので読まない。
  const monthDay = /(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*日(?![後間以])/.exec(prepared);
  const slashed = /(\d{1,2})\s*\/\s*(\d{1,2})/.exec(prepared);
  if (monthDay) {
    if (monthDay[1]) facts.month = Number(monthDay[1]);
    facts.day = Number(monthDay[2]);
  } else if (slashed) {
    facts.month = Number(slashed[1]);
    facts.day = Number(slashed[2]);
  }
  const weekday = /([日月火水木金土])\s*曜/.exec(prepared) ?? /\(\s*([日月火水木金土])\s*\)/.exec(prepared);
  if (weekday) facts.weekday = WEEKDAY_NAMES.indexOf(weekday[1] as (typeof WEEKDAY_NAMES)[number]);
  const relative = RELATIVE_DAYS.find(([pattern]) => pattern.test(prepared));
  if (relative) facts.daysFromToday = relative[1];
  return facts;
}

type DateMismatch = 'weekday_mismatch' | 'date_mismatch';

/**
 * 日付が会話の言い方と合わない理由。合っていれば null。
 * 「明日」などの相対の言い方は、通話の日を基準にするので、通話の直後にだけ確かめる。
 */
function dateMismatch(
  date: string,
  facts: DateFacts,
  today: string,
  { relative }: { relative: boolean },
): DateMismatch | null {
  const [, month, day] = date.split('-').map(Number);
  if (relative && facts.daysFromToday !== undefined && date !== addDays(today, facts.daysFromToday)) {
    return 'date_mismatch';
  }
  if (facts.day !== undefined && facts.day !== day) return 'date_mismatch';
  if (facts.month !== undefined && facts.month !== month) return 'date_mismatch';
  if (facts.weekday !== undefined && facts.weekday !== weekdayOf(date)) return 'weekday_mismatch';
  return null;
}

/**
 * 会話の中で、日と曜日を一緒に言った箇所（「12日（火）」「11月12日の火曜日」）のうち、
 * 読み取った日付と同じ日を指すのに曜日が合わないもの。
 * Geminiが根拠に曜日を含めなくても、会話そのものの食い違いを見逃さないために使う。
 */
function findWeekdayConflict(date: string, conversation: readonly string[]): string | null {
  const [, month, day] = date.split('-').map(Number);
  const pattern =
    /(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*日\s*(?:の|、|,)?\s*(?:\(\s*([日月火水木金土])\s*\)|([日月火水木金土])\s*曜日?)/g;
  for (const text of conversation) {
    for (const match of prepareForParsing(text).matchAll(pattern)) {
      if (Number(match[2]) !== day) continue;
      if (match[1] && Number(match[1]) !== month) continue;
      const spokenWeekday = WEEKDAY_NAMES.indexOf((match[3] ?? match[4]) as (typeof WEEKDAY_NAMES)[number]);
      if (spokenWeekday !== weekdayOf(date)) return match[0].trim();
    }
  }
  return null;
}

/** 会話で話された時刻。午前・午後が言われていなければ、どちらの時もありうる。 */
interface SpokenTime {
  hours: number[];
  minute: number;
}

function candidateHours(hour: number, period: string | undefined): number[] {
  if (hour === 0) return [0];
  if (hour > 12) return [hour];
  if (hour === 12) return period === '昼' ? [12] : [12, 0];
  switch (period) {
    case '午前':
    case '朝':
      return [hour];
    case '昼':
      return hour <= 5 ? [hour + 12] : [hour];
    case '午後':
    case '夕方':
    case '夜':
    case '晩':
      return [hour + 12];
    default:
      return [hour, hour + 12];
  }
}

/** 時刻の言い方から、話された順に時刻を読む（「10時から11時半まで」なら2つ）。 */
function readSpokenTimes(text: string): SpokenTime[] {
  // 「1時間ほど」のような長さは時刻ではないので読まない。
  const pattern =
    /正午|(午前|午後|朝|昼|夕方|夜|晩)?\s*(\d{1,2})\s*(?:時(?!間)\s*(?:(半)|(\d{1,2})\s*分)?|:\s*(\d{2}))/g;
  const times: SpokenTime[] = [];
  for (const match of prepareForParsing(text).matchAll(pattern)) {
    if (match[0] === '正午') {
      times.push({ hours: [12], minute: 0 });
      continue;
    }
    const hour = Number(match[2]);
    const minute = match[3] ? 30 : Number(match[4] ?? match[5] ?? 0);
    if (hour > 23 || minute > 59) continue;
    times.push({ hours: candidateHours(hour, match[1]), minute });
  }
  return times;
}

function timeMatches(value: string, spoken: SpokenTime): boolean {
  const [hour, minute] = value.split(':').map(Number);
  return minute === spoken.minute && spoken.hours.includes(hour);
}

export interface RawAppointment {
  title: string | null;
  /** 日付の根拠として抜き出した会話の言葉。古い応答では undefined。 */
  dateText?: string | null;
  date: string | null;
  /** 時刻の根拠として抜き出した会話の言葉。古い応答では undefined。 */
  timeText?: string | null;
  startTime: string | null;
  endTime: string | null;
  /** 古い応答や、場所を返さない呼び出しでは undefined。 */
  location?: string | null;
  address?: string | null;
  details: string | null;
}

/** 読み取りの根拠を探す文。 */
export interface AppointmentSources {
  /** 通話の発言（両者）。日時と場所の根拠を探す。 */
  conversation: readonly string[];
  /** 本人が発信のときに入れた文（相手の名前など）。場所の根拠にだけ使う。 */
  userInputs?: readonly string[];
}

/** 会話にある言葉だけを返す。 */
function quoted(text: string | null | undefined, sources: readonly string[]): string | null {
  const trimmed = text?.trim();
  return trimmed && isQuotedFrom(trimmed, sources) ? trimmed : null;
}

function issue(
  field: AppointmentIssue['field'],
  code: AppointmentIssueCode,
  said: string | null,
  value: string,
): AppointmentIssue {
  return said ? { field, code, said, value } : { field, code, value };
}

/**
 * Geminiの出力を画面に出せる値へ絞る。
 * 形式が不正な値、過去の日付、会話の言葉と合わない日時、会話にない場所は採用しない。
 * 日時を採用しなかったときは理由を issues に入れ、本人に「要確認」として見せる。
 */
export function sanitizeAppointment(
  raw: RawAppointment,
  defaults: { title: string; location: string },
  today: string,
  sources: AppointmentSources,
): AppointmentDraft {
  const { conversation } = sources;
  const placeSources = [...conversation, ...(sources.userInputs ?? [])];
  const issues: AppointmentIssue[] = [];
  const dateText = quoted(raw.dateText, conversation);
  const timeText = quoted(raw.timeText, conversation);

  let date: string | null = null;
  if (raw.date && isValidDate(raw.date)) {
    const facts = dateText ? readDateFacts(dateText) : null;
    const mismatch = facts && dateMismatch(raw.date, facts, today, { relative: true });
    const conflict = findWeekdayConflict(raw.date, conversation);
    if (raw.date < today) issues.push(issue('date', 'past_date', dateText, raw.date));
    else if (!dateText) issues.push(issue('date', 'not_in_conversation', null, raw.date));
    else if (mismatch) issues.push(issue('date', mismatch, dateText, raw.date));
    else if (conflict) issues.push(issue('date', 'weekday_mismatch', conflict, raw.date));
    else date = raw.date;
  }

  let startTime: string | null = null;
  const spokenTimes = timeText ? readSpokenTimes(timeText) : [];
  if (raw.startTime && isValidTime(raw.startTime)) {
    if (!timeText) issues.push(issue('startTime', 'not_in_conversation', null, raw.startTime));
    else if (spokenTimes.length === 0) issues.push(issue('startTime', 'unclear_time', timeText, raw.startTime));
    else if (!timeMatches(raw.startTime, spokenTimes[0])) {
      issues.push(issue('startTime', 'time_mismatch', timeText, raw.startTime));
    } else startTime = raw.startTime;
  }

  let endTime: string | null = null;
  const rawEnd = raw.endTime;
  if (startTime && rawEnd && isValidTime(rawEnd)) {
    if (toMinutes(rawEnd) <= toMinutes(startTime)) {
      issues.push(issue('endTime', 'end_before_start', timeText, rawEnd));
    } else if (spokenTimes.slice(1).some((spoken) => timeMatches(rawEnd, spoken))) {
      endTime = rawEnd;
    }
    // 終了時刻が会話の言葉にない場合は、話されていないものとして空欄にする（終了は任意の項目）。
  }

  const location = quoted(raw.location, placeSources);
  const address = quoted(raw.address, placeSources);

  const fromAi: Record<AppointmentField, boolean> = {
    title: Boolean(raw.title?.trim()),
    date: date !== null,
    startTime: startTime !== null,
    endTime: endTime !== null,
    location: location !== null,
    address: address !== null,
    details: Boolean(raw.details?.trim()),
  };

  const spoken: NonNullable<AppointmentDraft['spoken']> = {};
  if (dateText) spoken.date = dateText;
  if (timeText) spoken.time = timeText;

  return {
    title: raw.title?.trim() || defaults.title,
    date,
    startTime,
    endTime,
    location: location ?? defaults.location,
    address: address ?? '',
    details: raw.details?.trim() ?? '',
    aiFields: (Object.keys(fromAi) as AppointmentField[]).filter((field) => fromAi[field]),
    spoken,
    issues,
  };
}

/**
 * 通話から予定が読み取れたか。日付も時刻もなく、採用しなかった日時もなければ、予定の話はなかったものとして扱う。
 * 予定がない通話で、予約が済んだような画面を出さないために使う。
 */
export function hasScheduleHint(draft: AppointmentDraft): boolean {
  return draft.date !== null || draft.startTime !== null || (draft.issues?.length ?? 0) > 0;
}

/** 会話から場所か住所を読み取れたか。 */
export function hasPlaceHint(draft: AppointmentDraft): boolean {
  return (draft.aiFields ?? []).some((field) => field === 'location' || field === 'address');
}

const DATE_ISSUE_NEXT = '相手に確かめてから、日付を入れてください。';
const TIME_ISSUE_NEXT = '相手に確かめてから、時刻を入れてください。';

/** AIの日時を採用しなかった理由の説明。 */
export function describeIssue(item: AppointmentIssue): string {
  const value = item.value ?? '';
  const shownValue = item.field === 'date' && isValidDate(value) ? formatDateJa(value) : value;
  switch (item.code) {
    case 'weekday_mismatch':
      return `会話の「${item.said}」と、読み取った日付（${shownValue}）の曜日が合いません。${DATE_ISSUE_NEXT}`;
    case 'date_mismatch':
      return `読み取った日付（${shownValue}）が、会話の「${item.said}」と合いません。${DATE_ISSUE_NEXT}`;
    case 'past_date':
      return `読み取った日付（${shownValue}）は今日より前です。${DATE_ISSUE_NEXT}`;
    case 'not_in_conversation':
      return item.field === 'date'
        ? `日付を示す言葉が会話の中に見つからなかったので、空欄にしました。${DATE_ISSUE_NEXT}`
        : `時刻を示す言葉が会話の中に見つからなかったので、空欄にしました。${TIME_ISSUE_NEXT}`;
    case 'unclear_time':
      return `会話の「${item.said}」からは、時刻を決められませんでした。${TIME_ISSUE_NEXT}`;
    case 'time_mismatch':
      return `読み取った時刻（${shownValue}）が、会話の「${item.said}」と合いません。${TIME_ISSUE_NEXT}`;
    case 'end_before_start':
      return `読み取った終了時刻（${shownValue}）が開始より前だったので、空欄にしました。`;
  }
}

export interface ConfirmedAppointment extends AppointmentDraft {
  date: string;
  startTime: string;
}

/** 形式の上でカレンダーに渡せるか。終了時刻は空か、開始より後。 */
export function isReadyForCalendar(draft: AppointmentDraft): draft is ConfirmedAppointment {
  if (draft.date === null || !isValidDate(draft.date)) return false;
  if (draft.startTime === null || !isValidTime(draft.startTime)) return false;
  if (draft.endTime === null) return true;
  return isValidTime(draft.endTime) && toMinutes(draft.endTime) > toMinutes(draft.startTime);
}

export type ScheduleProblemCode =
  | 'missing_date'
  | 'missing_start'
  | 'past_date'
  | 'past_time'
  | 'end_before_start'
  | 'differs_from_conversation';

export interface ScheduleProblem {
  field: 'date' | 'startTime' | 'endTime';
  code: ScheduleProblemCode;
  message: string;
}

export interface ScheduleCheck {
  /** 直すまでカレンダーへ進めない問題。 */
  blocking: ScheduleProblem[];
  /** 進めるが、本人に見てほしいこと。本人が選んだ値なので止めない。 */
  warnings: ScheduleProblem[];
}

/**
 * 本人が確認している予定の日時を確かめる。
 * 日時がそろわない・過ぎている・終了が開始より前、は矛盾した予定なので、カレンダーへ進めない。
 * 会話の言い方と違う値は、本人が直した結果かもしれないので、知らせるだけにする。
 */
export function checkSchedule(draft: AppointmentDraft, now: Date): ScheduleCheck {
  const blocking: ScheduleProblem[] = [];
  const warnings: ScheduleProblem[] = [];
  const today = tokyoToday(now);
  const date = draft.date && isValidDate(draft.date) ? draft.date : null;
  const start = draft.startTime && isValidTime(draft.startTime) ? draft.startTime : null;

  if (!date) {
    blocking.push({ field: 'date', code: 'missing_date', message: '日付を入れてください。' });
  } else if (date < today) {
    blocking.push({
      field: 'date',
      code: 'past_date',
      message: `${formatDateJa(date)}は今日より前の日付です。`,
    });
  }

  if (!start) {
    blocking.push({ field: 'startTime', code: 'missing_start', message: '開始時刻を入れてください。' });
  } else if (date === today && start < tokyoTimeNow(now)) {
    blocking.push({
      field: 'startTime',
      code: 'past_time',
      message: `今日の${start}はもう過ぎています。`,
    });
  }

  if (start && draft.endTime && !(isValidTime(draft.endTime) && toMinutes(draft.endTime) > toMinutes(start))) {
    blocking.push({
      field: 'endTime',
      code: 'end_before_start',
      message: '終了時刻を開始より後にするか、空欄にしてください。',
    });
  }

  const spokenDate = draft.spoken?.date;
  if (date && spokenDate && dateMismatch(date, readDateFacts(spokenDate), today, { relative: false })) {
    warnings.push({
      field: 'date',
      code: 'differs_from_conversation',
      message: `会話の「${spokenDate}」と合いません。${formatDateJa(date)}で正しいか確かめてください。`,
    });
  }

  const spokenTime = draft.spoken?.time;
  const spokenTimes = spokenTime ? readSpokenTimes(spokenTime) : [];
  if (start && spokenTime && spokenTimes.length > 0 && !timeMatches(start, spokenTimes[0])) {
    warnings.push({
      field: 'startTime',
      code: 'differs_from_conversation',
      message: `会話の「${spokenTime}」と合いません。${start}で正しいか確かめてください。`,
    });
  }

  return { blocking, warnings };
}

function resolveEndTime(startTime: string, endTime: string | null): string {
  if (endTime && isValidTime(endTime) && toMinutes(endTime) > toMinutes(startTime)) return endTime;
  return fromMinutes(Math.min(toMinutes(startTime) + DEFAULT_DURATION_MINUTES, LAST_MINUTE_OF_DAY));
}

function toCalendarStamp(date: string, time: string): string {
  return `${date.replaceAll('-', '')}T${time.replace(':', '')}00`;
}

/** 場所の名前と住所を1行にする。地図の検索とカレンダーの場所に使う。 */
export function joinPlace(location: string, address: string): string {
  return [location.trim(), address.trim()].filter(Boolean).join(' ');
}

/**
 * 模擬クリニックや参考候補に含まれる架空の施設名・ビル名・階数タグを除去し、
 * Google Maps の「経路案内（Directions）」と「周辺地図（Search）」の両方で同一の実在地点を指す検索クエリを返す。
 */
export function resolveClinicMapQuery(
  clinic: { isSandbox?: boolean; address?: string; mapQuery?: string },
  fallbackAddress?: string | null,
): string {
  const DEFAULT_REAL_LANDMARK = '東京都千代田区丸の内1-9-1';
  if (clinic.mapQuery?.trim()) {
    return clinic.mapQuery.trim();
  }
  if (clinic.isSandbox) {
    return DEFAULT_REAL_LANDMARK;
  }

  const raw = (fallbackAddress || clinic.address || '').trim();
  if (!raw) return DEFAULT_REAL_LANDMARK;

  const cleaned = raw
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/（[^）]*(?:架空|参考|検証|模擬|手入力)[^）]*）/g, ' ')
    .replace(/\([^)]*(?:Fictional|Sample|Mock|Review|Testing|Manual)[^)]*\)/gi, ' ')
    .replace(/丸の内メディカルプラザ\s*\d*(?:階|F)?/gi, ' ')
    .replace(/メディカルビル\s*\d*(?:階|F)?/gi, ' ')
    .replace(/セントラルタワー\s*\d*(?:階|F)?/gi, ' ')
    .replace(/Medical\s+(?:Plaza|Bldg\.?|Building)\s*\d*F?,?/gi, ' ')
    .replace(/Central\s+Tower\s*\d*F?,?/gi, ' ')
    .replace(/\b(?:1-4-2|2-8-5)\b/g, ' ')
    .replace(/\bAround\s+/gi, '')
    .replace(/駅周辺/g, '駅')
    .replace(/周辺/g, '')
    .replace(/\s*\d+(?:階|F)\b/gi, '')
    .replace(/[、,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || DEFAULT_REAL_LANDMARK;
}

/**
 * Googleマップで場所を検索するURL。検索結果を本人が確かめるためのもので、施設や住所を確定しない。
 * 場所が空なら null。
 */
export function buildMapsSearchUrl(place: string): string | null {
  const query = place.trim().slice(0, MAX_MAP_QUERY_LENGTH);
  if (!query) return null;
  return `${MAPS_SEARCH_URL}?${new URLSearchParams({ api: '1', query }).toString()}`;
}

/**
 * Googleマップで病院・目的地への経路案内（Directions）を開くURL（APIキー不要）。
 * origin が指定されていれば出発地に設定し、空欄・未指定時は Google Maps 側の「現在地」が使われる。
 * 目的地が空なら null。
 */
export function buildMapsDirectionsUrl(destination: string, origin?: string): string | null {
  const query = destination.trim().slice(0, MAX_MAP_QUERY_LENGTH);
  if (!query) return null;
  const trimmedOrigin = origin?.trim().slice(0, MAX_MAP_QUERY_LENGTH);
  const params = new URLSearchParams({
    api: '1',
    ...(trimmedOrigin ? { origin: trimmedOrigin } : {}),
    destination: query,
    travelmode: 'transit',
  });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** Googleカレンダーを開くURL。日付があればその日の表示にする。本人がGoogleにログインして自分で見る。 */
export function buildCalendarDayUrl(date: string | null): string {
  if (!date || !isValidDate(date)) return CALENDAR_HOME_URL;
  const [year, month, day] = date.split('-').map(Number);
  return `${CALENDAR_HOME_URL}/day/${year}/${month}/${day}`;
}

/** Googleカレンダーの作成画面を開くURL（時刻指定あり）。最後に保存するのは本人。 */
export function buildCalendarUrl(appointment: ConfirmedAppointment): string {
  const { date, startTime, endTime, title, location, address, details } = appointment;
  const start = toCalendarStamp(date, startTime);
  const end = toCalendarStamp(date, resolveEndTime(startTime, endTime));
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${start}/${end}`,
    ctz: TIME_ZONE,
    location: joinPlace(location, address ?? ''),
    details,
  });
  return `${CALENDAR_BASE_URL}?${params.toString()}`;
}

/**
 * 時刻が未定・言及なしの再診予定などを「終日イベント（YYYYMMDD/YYYYMMDD+1）」として
 * Googleカレンダーの作成画面で開くURL。
 */
export function buildCalendarAllDayUrl(input: {
  title: string;
  date: string;
  location: string;
  address?: string;
  details: string;
}): string {
  const startDay = input.date.replaceAll('-', '');
  const endDay = addDays(input.date, 1).replaceAll('-', '');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: input.title,
    dates: `${startDay}/${endDay}`,
    ctz: TIME_ZONE,
    location: joinPlace(input.location, input.address ?? ''),
    details: input.details,
  });
  return `${CALENDAR_BASE_URL}?${params.toString()}`;
}
