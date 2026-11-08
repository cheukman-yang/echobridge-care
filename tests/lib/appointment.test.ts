import { describe, expect, it } from 'vitest';
import {
  buildCalendarDayUrl,
  buildCalendarUrl,
  buildMapsSearchUrl,
  checkSchedule,
  describeIssue,
  formatDateJa,
  formatTokyoNow,
  hasPlaceHint,
  hasScheduleHint,
  isQuotedFrom,
  isReadyForCalendar,
  joinPlace,
  sanitizeAppointment,
  tokyoToday,
} from '@/lib/appointment';
import type { RawAppointment } from '@/lib/appointment';
import type { AppointmentDraft } from '@/lib/callProtocol';

const DEFAULTS = { title: '内科の予約', location: 'ひまわり医院 (受付)' };
// 2026-11-07 は土曜日。11-08 日、11-09 月、11-10 火、11-11 水、11-12 木、11-13 金。
const TODAY = '2026-11-07';

const CONVERSATION = ['11月12日の14時半から15時まででいかがですか。', 'はい、お願いします。'];

const raw: RawAppointment = {
  title: '内科 初診予約',
  dateText: '11月12日',
  date: '2026-11-12',
  timeText: '14時半から15時まで',
  startTime: '14:30',
  endTime: '15:00',
  details: '持ち物: お薬手帳',
};

function sanitize(patch: Partial<RawAppointment> = {}, conversation = CONVERSATION, userInputs: string[] = []) {
  return sanitizeAppointment({ ...raw, ...patch }, DEFAULTS, TODAY, { conversation, userInputs });
}

describe('日本時間の扱い', () => {
  it('UTCの夜でも日本の日付を返す', () => {
    expect(tokyoToday(new Date('2026-11-07T15:30:00Z'))).toBe('2026-11-08');
  });

  it('現在日時に曜日とタイムゾーンを含める', () => {
    expect(formatTokyoNow(new Date('2026-11-07T01:00:00Z'))).toBe('2026-11-07(土) 10:00 Asia/Tokyo');
  });

  it('画面の日付に曜日を付ける', () => {
    expect(formatDateJa('2026-11-12')).toBe('11月12日（木）');
  });
});

describe('sanitizeAppointment', () => {
  it('会話と合う値はそのまま使い、根拠の言葉を残す', () => {
    expect(sanitize()).toEqual({
      title: '内科 初診予約',
      date: '2026-11-12',
      startTime: '14:30',
      endTime: '15:00',
      location: 'ひまわり医院 (受付)',
      address: '',
      details: '持ち物: お薬手帳',
      // 場所はAIが返していないので、AIの項目に含めない。
      aiFields: ['title', 'date', 'startTime', 'endTime', 'details'],
      spoken: { date: '11月12日', time: '14時半から15時まで' },
      issues: [],
    });
  });

  it('AIが返さず既定値で埋めた項目と、形式が不正で捨てた項目は、AIの項目に含めない', () => {
    const result = sanitize({ title: null, startTime: '25:00', location: '受付' }, [
      ...CONVERSATION,
      '受付でお名前をお伝えください。',
    ]);

    expect(result.title).toBe(DEFAULTS.title);
    expect(result.aiFields).toEqual(['date', 'location', 'details']);
  });

  it('当日の予定は有効', () => {
    const result = sanitize({ dateText: '今日', date: TODAY }, ['今日の14時半から15時までなら空いています。']);
    expect(result.date).toBe(TODAY);
  });

  it.each([
    ['存在しない日付', '2026-02-30'],
    ['形式違い', '11月12日'],
  ])('%sは要確認にする', (_, date) => {
    expect(sanitize({ date }).date).toBeNull();
  });

  it('過去の日付は採用せず、理由を残す', () => {
    const result = sanitize({ date: '2026-11-06' });

    expect(result.date).toBeNull();
    expect(result.issues).toEqual([
      { field: 'date', code: 'past_date', said: '11月12日', value: '2026-11-06' },
    ]);
  });

  it('不正な時刻は要確認にする', () => {
    const result = sanitize({ startTime: '25:00' });

    expect(result.startTime).toBeNull();
    expect(result.endTime).toBeNull();
  });

  it('開始より前の終了時刻は採用せず、理由を残す', () => {
    const result = sanitize({ endTime: '14:00' });

    expect(result.endTime).toBeNull();
    expect(result.issues).toEqual([
      { field: 'endTime', code: 'end_before_start', said: '14時半から15時まで', value: '14:00' },
    ]);
  });

  it('名前がなければ用件を使い、メモは空にする', () => {
    const result = sanitize({ title: null, details: null });

    expect(result.title).toBe('内科の予約');
    expect(result.details).toBe('');
  });
});

describe('日時の矛盾', () => {
  it('会話の日付と曜日が合わなければ、日付を採用しない', () => {
    const result = sanitize({ dateText: '11月12日（火）' }, ['11月12日（火）の14時半から15時まででいかがですか。']);

    expect(result.date).toBeNull();
    expect(result.aiFields).not.toContain('date');
    expect(result.issues).toEqual([
      { field: 'date', code: 'weekday_mismatch', said: '11月12日（火）', value: '2026-11-12' },
    ]);
    // 時刻は会話と合っているので使う。
    expect(result.startTime).toBe('14:30');
  });

  it('根拠の言葉に曜日がなくても、会話の中の日と曜日の食い違いを見つける', () => {
    const result = sanitize({ dateText: '12日' }, ['12日の火曜日、14時半から15時まではいかがですか。']);

    expect(result.date).toBeNull();
    expect(result.issues?.[0]).toMatchObject({ code: 'weekday_mismatch', said: '12日の火曜日' });
  });

  it('曜日が合っていれば採用する', () => {
    const result = sanitize({ dateText: '11月12日の木曜日' }, ['11月12日の木曜日、14時半から15時まででどうですか。']);
    expect(result.date).toBe('2026-11-12');
  });

  it('「明日」と合わない日付は採用しない', () => {
    const result = sanitize({ dateText: '明日', date: '2026-11-09' }, ['明日の14時半から15時までで。']);

    expect(result.date).toBeNull();
    expect(result.issues?.[0]).toMatchObject({ field: 'date', code: 'date_mismatch', said: '明日' });
  });

  it('「明日」は通話の日の翌日として採用する', () => {
    const result = sanitize({ dateText: '明日', date: '2026-11-08' }, ['明日の14時半から15時までで。']);
    expect(result.date).toBe('2026-11-08');
  });

  it('日にちが合わない日付は採用しない', () => {
    const result = sanitize({ dateText: '11月13日' }, ['11月13日の14時半から15時まで。']);
    expect(result.issues?.[0]).toMatchObject({ code: 'date_mismatch', said: '11月13日' });
  });

  it('漢数字や全角の数字でも照合する', () => {
    const kanji = sanitize({ dateText: '十一月十二日（木）', timeText: '午後二時半から三時まで' }, [
      '十一月十二日（木）の午後二時半から三時までです。',
    ]);
    const fullWidth = sanitize({ dateText: '１１月１２日' }, ['１１月１２日の14時半から15時まで。']);

    expect(kanji).toMatchObject({ date: '2026-11-12', startTime: '14:30', endTime: '15:00' });
    expect(fullWidth.date).toBe('2026-11-12');
  });

  it('根拠の言葉が会話にない日付と時刻は採用しない', () => {
    const invented = sanitize({}, ['では、よろしくお願いします。']);
    const missing = sanitize({ dateText: null, timeText: null });

    for (const result of [invented, missing]) {
      expect(result.date).toBeNull();
      expect(result.startTime).toBeNull();
      expect(result.issues?.map((item) => item.code)).toEqual(['not_in_conversation', 'not_in_conversation']);
      expect(result.spoken).toEqual({});
    }
  });

  it('「午後」と言ったのに午前の時刻なら採用しない', () => {
    const result = sanitize({ timeText: '午後2時半', startTime: '02:30', endTime: null }, ['明日の午後2時半です。'], []);
    expect(result.startTime).toBeNull();
    expect(result.issues).toContainEqual({
      field: 'startTime',
      code: 'time_mismatch',
      said: '午後2時半',
      value: '02:30',
    });
  });

  it('午前・午後を言っていなければ、どちらの時刻も認める', () => {
    const result = sanitize({ timeText: '2時半', startTime: '14:30', endTime: null }, ['11月12日の2時半でどうですか。']);
    expect(result.startTime).toBe('14:30');
  });

  it('「お昼ごろ」のように時刻が決まっていない言葉からは、時刻を作らない', () => {
    const result = sanitize({ timeText: 'お昼ごろ', startTime: '12:00', endTime: null }, [
      '11月12日のお昼ごろに伺います。',
    ]);

    expect(result.startTime).toBeNull();
    expect(result.issues).toContainEqual({ field: 'startTime', code: 'unclear_time', said: 'お昼ごろ', value: '12:00' });
  });

  it('会話にない終了時刻は空欄にする。「1時間ほど」は時刻として読まない', () => {
    const result = sanitize({ timeText: '14時半から1時間ほど', endTime: '15:30' }, [
      '11月12日の14時半から1時間ほどです。',
    ]);

    expect(result.startTime).toBe('14:30');
    expect(result.endTime).toBeNull();
    expect(result.issues).toEqual([]);
  });
});

describe('場所と住所', () => {
  const placeConversation = [...CONVERSATION, 'ひまわり医院です。住所は本町2丁目3番4号、ひまわりビルの2階です。'];

  it('会話にある場所と住所を採用する', () => {
    const result = sanitize({ location: 'ひまわり医院', address: '本町2丁目3番4号' }, placeConversation);

    expect(result).toMatchObject({ location: 'ひまわり医院', address: '本町2丁目3番4号' });
    expect(result.aiFields).toEqual(expect.arrayContaining(['location', 'address']));
    expect(hasPlaceHint(result)).toBe(true);
  });

  it('会話にない場所や住所は採用しない', () => {
    const result = sanitize({ location: 'さくら病院', address: '東京都千代田区1-1' }, placeConversation);

    expect(result).toMatchObject({ location: DEFAULTS.location, address: '' });
    expect(result.aiFields).not.toContain('location');
    expect(result.aiFields).not.toContain('address');
    expect(hasPlaceHint(result)).toBe(false);
  });

  it('全角の数字や空白の違いは、同じ言葉として扱う', () => {
    const result = sanitize({ address: '本町2丁目 3番4号' }, [...CONVERSATION, '住所は本町２丁目３番４号です。']);
    expect(result.address).toBe('本町2丁目 3番4号');
  });

  it('本人が入れた相手の名前は、場所の根拠になる', () => {
    const result = sanitize({ location: 'ひまわり医院' }, CONVERSATION, ['ひまわり医院']);
    expect(result.location).toBe('ひまわり医院');
  });

  it('会話で決まった場所があれば既定の場所より優先し、なければ既定の場所にする', () => {
    expect(sanitize({ location: ' 駅前の改札 ' }, [...CONVERSATION, '駅前の改札で。']).location).toBe('駅前の改札');
    expect(sanitize({ location: null }).location).toBe(DEFAULTS.location);
  });

  it('照合は抜き出した言葉が会話にそのまま含まれるかで決める', () => {
    expect(isQuotedFrom('明日の午後', ['明日の午後2時半です'])).toBe(true);
    expect(isQuotedFrom('明後日の午後', ['明日の午後2時半です'])).toBe(false);
    expect(isQuotedFrom('   ', ['明日'])).toBe(false);
  });
});

describe('予定の有無', () => {
  it('日付も時刻もなく、採用しなかった日時もなければ、予定の話はなかったと判断する', () => {
    const empty = sanitize({ title: null, dateText: null, date: null, timeText: null, startTime: null, endTime: null, details: null });

    expect(hasScheduleHint(empty)).toBe(false);
    expect(hasScheduleHint({ ...empty, date: '2026-11-12' })).toBe(true);
    expect(hasScheduleHint({ ...empty, startTime: '10:00' })).toBe(true);
  });

  it('日時を採用しなかったときも、予定の話はあったと判断する', () => {
    const conflicted = sanitize({ dateText: '11月12日（火）', timeText: null, startTime: null, endTime: null }, [
      '11月12日（火）でお願いします。',
    ]);

    expect(conflicted.date).toBeNull();
    expect(hasScheduleHint(conflicted)).toBe(true);
  });
});

describe('採用しなかった理由の説明', () => {
  it('会話の言葉と、読み取った日付の曜日を示す', () => {
    const text = describeIssue({ field: 'date', code: 'weekday_mismatch', said: '11月12日（火）', value: '2026-11-12' });

    expect(text).toContain('「11月12日（火）」');
    expect(text).toContain('11月12日（木）');
    expect(text).toContain('相手に確かめて');
  });

  it('時刻が決められないときは、会話の言葉を示す', () => {
    expect(describeIssue({ field: 'startTime', code: 'unclear_time', said: 'お昼ごろ', value: '12:00' })).toContain(
      '「お昼ごろ」',
    );
  });
});

describe('本人が確認している予定の検査', () => {
  // 2026-11-07(土) 10:00 JST
  const NOW = new Date('2026-11-07T01:00:00Z');
  const draft: AppointmentDraft = {
    title: '内科 初診予約',
    date: '2026-11-12',
    startTime: '14:30',
    endTime: null,
    location: 'ひまわり医院',
    address: '',
    details: '',
  };
  const codes = (list: { code: string }[]) => list.map((item) => item.code);

  it('日付と開始時刻がそろい、矛盾がなければ進める', () => {
    expect(checkSchedule(draft, NOW)).toEqual({ blocking: [], warnings: [] });
  });

  it('日付か開始時刻がなければ進めない', () => {
    expect(codes(checkSchedule({ ...draft, date: null, startTime: null }, NOW).blocking)).toEqual([
      'missing_date',
      'missing_start',
    ]);
  });

  it('過去の日付と、今日の過ぎた時刻は進めない', () => {
    expect(codes(checkSchedule({ ...draft, date: '2026-11-06' }, NOW).blocking)).toEqual(['past_date']);
    expect(codes(checkSchedule({ ...draft, date: TODAY, startTime: '09:30' }, NOW).blocking)).toEqual(['past_time']);
    expect(checkSchedule({ ...draft, date: TODAY, startTime: '10:30' }, NOW).blocking).toEqual([]);
  });

  it('終了時刻が開始と同じか前なら進めない。空欄なら進める', () => {
    expect(codes(checkSchedule({ ...draft, endTime: '14:00' }, NOW).blocking)).toEqual(['end_before_start']);
    expect(codes(checkSchedule({ ...draft, endTime: '14:30' }, NOW).blocking)).toEqual(['end_before_start']);
    expect(checkSchedule({ ...draft, endTime: '15:00' }, NOW).blocking).toEqual([]);
  });

  it('会話の言い方と違う日時は、本人が選んだ値かもしれないので、知らせるだけにする', () => {
    const result = checkSchedule(
      { ...draft, date: '2026-11-13', startTime: '15:00', spoken: { date: '11月12日（木）', time: '午後2時半' } },
      NOW,
    );

    expect(result.blocking).toEqual([]);
    expect(codes(result.warnings)).toEqual(['differs_from_conversation', 'differs_from_conversation']);
    expect(result.warnings[0].message).toContain('11月13日（金）');
  });

  it('「明日」のような言い方は、確認する日によって指す日が変わるので比べない', () => {
    expect(checkSchedule({ ...draft, spoken: { date: '明日' } }, NOW).warnings).toEqual([]);
  });
});

describe('Googleカレンダーへの受け渡し', () => {
  const draft: AppointmentDraft = {
    title: '内科 初診予約',
    date: '2026-11-12',
    startTime: '14:30',
    endTime: null,
    location: 'ひまわり医院',
    address: '本町2丁目3番4号',
    details: '持ち物: お薬手帳',
  };

  it('日付か開始時刻がない、終了が開始より前なら進めない', () => {
    expect(isReadyForCalendar({ ...draft, date: null })).toBe(false);
    expect(isReadyForCalendar({ ...draft, startTime: null })).toBe(false);
    expect(isReadyForCalendar({ ...draft, endTime: '14:00' })).toBe(false);
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

  it('場所には施設名と住所を並べて渡す', () => {
    expect(paramsFor(draft).get('location')).toBe('ひまわり医院 本町2丁目3番4号');
    expect(paramsFor({ ...draft, address: '' }).get('location')).toBe('ひまわり医院');
  });

  it('終了時刻が不明なら開始の1時間後にする', () => {
    expect(paramsFor(draft).get('dates')).toBe('20261112T143000/20261112T153000');
  });

  it('本人が入れた終了時刻を使う', () => {
    expect(paramsFor({ ...draft, endTime: '14:45' }).get('dates')).toBe('20261112T143000/20261112T144500');
  });

  it('日付をまたがない', () => {
    expect(paramsFor({ ...draft, startTime: '23:30' }).get('dates')).toBe('20261112T233000/20261112T235900');
  });
});

describe('Googleマップの検索URL', () => {
  it('公式のMaps URLsの形で、場所の名前と住所を検索語にする', () => {
    const url = new URL(buildMapsSearchUrl(joinPlace('  ひまわり医院 ', ' 本町2丁目 ')) ?? '');
    expect(`${url.origin}${url.pathname}`).toBe('https://www.google.com/maps/search/');
    expect(url.searchParams.get('api')).toBe('1');
    expect(url.searchParams.get('query')).toBe('ひまわり医院 本町2丁目');
  });

  it('場所が空なら作らない', () => {
    expect(buildMapsSearchUrl(joinPlace('   ', ''))).toBeNull();
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
