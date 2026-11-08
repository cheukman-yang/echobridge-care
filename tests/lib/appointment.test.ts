import { describe, expect, it } from 'vitest';
import {
  buildCalendarDayUrl,
  buildCalendarUrl,
  buildMapsSearchUrl,
  formatTokyoNow,
  hasScheduleHint,
  isReadyForCalendar,
  sanitizeAppointment,
  tokyoToday,
} from '@/lib/appointment';
import type { AppointmentDraft } from '@/lib/callProtocol';

const DEFAULTS = { title: '内科の予約', location: 'ひまわり医院 (受付)' };
const TODAY = '2026-11-07';

const raw = {
  title: '内科 初診予約',
  date: '2026-11-12',
  startTime: '14:30',
  endTime: '15:00',
  details: '持ち物: お薬手帳',
};

describe('日本時間の扱い', () => {
  it('UTCの夜でも日本の日付を返す', () => {
    expect(tokyoToday(new Date('2026-11-07T15:30:00Z'))).toBe('2026-11-08');
  });

  it('現在日時に曜日とタイムゾーンを含める', () => {
    expect(formatTokyoNow(new Date('2026-11-07T01:00:00Z'))).toBe('2026-11-07(土) 10:00 Asia/Tokyo');
  });
});

describe('sanitizeAppointment', () => {
  it('正しい値はそのまま使う', () => {
    expect(sanitizeAppointment(raw, DEFAULTS, TODAY)).toEqual({
      title: '内科 初診予約',
      date: '2026-11-12',
      startTime: '14:30',
      endTime: '15:00',
      location: 'ひまわり医院 (受付)',
      details: '持ち物: お薬手帳',
      // 場所はAIが返していないので、AIの項目に含めない。
      aiFields: ['title', 'date', 'startTime', 'endTime', 'details'],
    });
  });

  it('AIが返さず既定値で埋めた項目と、形式が不正で捨てた項目は、AIの項目に含めない', () => {
    const result = sanitizeAppointment(
      { ...raw, title: null, startTime: '25:00', location: ' 2階 ' },
      DEFAULTS,
      TODAY,
    );

    expect(result.title).toBe(DEFAULTS.title);
    expect(result.aiFields).toEqual(['date', 'location', 'details']);
  });

  it('当日の予定は有効', () => {
    expect(sanitizeAppointment({ ...raw, date: TODAY }, DEFAULTS, TODAY).date).toBe(TODAY);
  });

  it.each([
    ['存在しない日付', '2026-02-30'],
    ['過去の日付', '2026-11-06'],
    ['形式違い', '11月12日'],
  ])('%sは要確認にする', (_, date) => {
    expect(sanitizeAppointment({ ...raw, date }, DEFAULTS, TODAY).date).toBeNull();
  });

  it('不正な時刻は要確認にする', () => {
    const result = sanitizeAppointment({ ...raw, startTime: '25:00' }, DEFAULTS, TODAY);

    expect(result.startTime).toBeNull();
    expect(result.endTime).toBeNull();
  });

  it('開始より前の終了時刻は採用しない', () => {
    expect(sanitizeAppointment({ ...raw, endTime: '14:00' }, DEFAULTS, TODAY).endTime).toBeNull();
  });

  it('名前がなければ用件を使い、メモは空にする', () => {
    const result = sanitizeAppointment({ ...raw, title: null, details: null }, DEFAULTS, TODAY);

    expect(result.title).toBe('内科の予約');
    expect(result.details).toBe('');
  });
});

describe('Googleカレンダーへの受け渡し', () => {
  const draft: AppointmentDraft = {
    title: '内科 初診予約',
    date: '2026-11-12',
    startTime: '14:30',
    endTime: null,
    location: 'ひまわり医院 (受付)',
    details: '持ち物: お薬手帳',
  };

  it('日付か開始時刻がなければ進めない', () => {
    expect(isReadyForCalendar({ ...draft, date: null })).toBe(false);
    expect(isReadyForCalendar({ ...draft, startTime: null })).toBe(false);
    expect(isReadyForCalendar(draft)).toBe(true);
  });

  function paramsFor(appointment: AppointmentDraft) {
    if (!isReadyForCalendar(appointment)) throw new Error('not ready');
    return new URL(buildCalendarUrl(appointment)).searchParams;
  }

  it('日本時間を明示し、日本語を崩さない', () => {
    const params = paramsFor(draft);

    expect(params.get('ctz')).toBe('Asia/Tokyo');
    expect(params.get('text')).toBe('内科 初診予約');
    expect(params.get('details')).toBe('持ち物: お薬手帳');
  });

  it('終了時刻が不明なら開始の1時間後にする', () => {
    expect(paramsFor(draft).get('dates')).toBe('20261112T143000/20261112T153000');
  });

  it('本人が入れた終了時刻を使う', () => {
    expect(paramsFor({ ...draft, endTime: '14:45' }).get('dates')).toBe(
      '20261112T143000/20261112T144500',
    );
  });

  it('日付をまたがない', () => {
    expect(paramsFor({ ...draft, startTime: '23:30' }).get('dates')).toBe(
      '20261112T233000/20261112T235900',
    );
  });
});

describe('場所と予定の有無', () => {
  it('会話で決まった場所があれば既定の場所より優先する', () => {
    expect(sanitizeAppointment({ ...raw, location: ' 2階の受付 ' }, DEFAULTS, TODAY).location).toBe(
      '2階の受付',
    );
    expect(sanitizeAppointment({ ...raw, location: null }, DEFAULTS, TODAY).location).toBe(
      DEFAULTS.location,
    );
  });

  it('日付も時刻もなければ、予定の話はなかったと判断する', () => {
    const empty = sanitizeAppointment(
      { title: null, date: null, startTime: null, endTime: null, details: null },
      DEFAULTS,
      TODAY,
    );

    expect(hasScheduleHint(empty)).toBe(false);
    expect(hasScheduleHint({ ...empty, date: '2026-11-12' })).toBe(true);
    expect(hasScheduleHint({ ...empty, startTime: '10:00' })).toBe(true);
  });
});

describe('Googleマップの検索URL', () => {
  it('公式のMaps URLsの形で、場所の名前をそのまま検索語にする', () => {
    const url = new URL(buildMapsSearchUrl('  ひまわり医院 本町2丁目  ') ?? '');
    expect(`${url.origin}${url.pathname}`).toBe('https://www.google.com/maps/search/');
    expect(url.searchParams.get('api')).toBe('1');
    expect(url.searchParams.get('query')).toBe('ひまわり医院 本町2丁目');
  });

  it('場所が空なら作らない', () => {
    expect(buildMapsSearchUrl('   ')).toBeNull();
  });

  it('長い場所は切り詰め、URLの上限（2,048文字）を超えない', () => {
    const url = buildMapsSearchUrl('長'.repeat(500)) ?? '';
    expect(url.length).toBeLessThanOrEqual(2048);
    expect(new URL(url).searchParams.get('query')).toHaveLength(100);
  });
});

describe('Googleカレンダーを開くURL', () => {
  it('日付があればその日の表示にする', () => {
    expect(buildCalendarDayUrl('2026-11-09')).toBe('https://calendar.google.com/calendar/r/day/2026/11/9');
  });

  it('日付がないか不正なら、カレンダーの画面を開く', () => {
    expect(buildCalendarDayUrl(null)).toBe('https://calendar.google.com/calendar/r');
    expect(buildCalendarDayUrl('2026-02-30')).toBe('https://calendar.google.com/calendar/r');
  });
});
