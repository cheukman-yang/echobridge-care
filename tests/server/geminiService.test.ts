import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFallbackSuggestions, createAiAssistant } from '../../server/geminiService';
import type { ChatTurn } from '@/lib/callProtocol';
import {
  HttpError,
  TEST_MODEL,
  createFakeModels,
  createFakeRunner,
  jsonReply,
  sentContents,
} from '../helpers/fakeGemini';

const NOW = new Date('2026-11-07T01:00:00Z');
const FAILING = () => {
  throw new HttpError(503);
};

const history: ChatTurn[] = [
  { sender: '患者', text: '内科の初診予約をしたいです' },
  { sender: '病院受付', text: 'アレルギーはありますか' },
];

const threeSuggestions = {
  suggestions: [
    { text: 'はい、ございます。', tag: '肯定' },
    { text: 'いいえ、ございません。', tag: '否定' },
    { text: '確認してもよろしいでしょうか。', tag: '確認' },
  ],
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('suggestReplies', () => {
  const input = { intent: '内科の初診予約', history, latestUtterance: 'アレルギーはありますか' };

  it('Geminiの候補を出所つきで返す', async () => {
    const assistant = createAiAssistant(
      createFakeRunner(createFakeModels(() => jsonReply(threeSuggestions))),
    );

    const result = await assistant.suggestReplies(input);

    expect(result.suggestions).toEqual(threeSuggestions.suggestions);
    expect(result.ai).toEqual({ source: 'gemini', model: TEST_MODEL });
  });

  it('用件と通話履歴をGeminiに渡す', async () => {
    const models = createFakeModels(() => jsonReply(threeSuggestions));

    await createAiAssistant(createFakeRunner(models)).suggestReplies(input);

    const contents = sentContents(models.generateContent.mock.calls[0][0]);
    expect(contents).toContain('内科の初診予約');
    expect(contents).toContain('内科の初診予約をしたいです');
    expect(contents).toContain('アレルギーはありますか');
  });

  it('失敗すると定型文を fallback として返す', async () => {
    const assistant = createAiAssistant(createFakeRunner(createFakeModels(FAILING)));

    const result = await assistant.suggestReplies(input);

    expect(result.suggestions).toHaveLength(3);
    expect(result.ai).toEqual({ source: 'fallback', reason: 'unavailable' });
  });

  it('候補が3つでなければ採用しない', async () => {
    const twoOnly = { suggestions: threeSuggestions.suggestions.slice(0, 2) };
    const assistant = createAiAssistant(
      createFakeRunner(createFakeModels(() => jsonReply(twoOnly))),
    );

    const result = await assistant.suggestReplies(input);

    expect(result.ai).toEqual({ source: 'fallback', reason: 'invalid_response' });
    expect(result.suggestions).not.toEqual(twoOnly.suggestions);
  });

  describe('日時や数字を、相手の言い方から変えない', () => {
    const timeInput = {
      intent: '内科の初診予約をしたいです',
      partnerName: 'ひまわり医院',
      history: [
        { sender: '患者' as const, text: '内科の初診予約をしたいです' },
        { sender: '病院受付' as const, text: '明日の午後2時半はいかがですか' },
      ],
      latestUtterance: '明日の午後2時半はいかがですか',
    };
    const reply = (texts: string[]) =>
      jsonReply({ suggestions: texts.map((text, i) => ({ text, tag: `案${i + 1}` })) });

    it('相手の言い方のまま書くよう、指示に入れる', async () => {
      const models = createFakeModels(() => jsonReply(threeSuggestions));

      await createAiAssistant(createFakeRunner(models)).suggestReplies(timeInput);

      expect(String(models.generateContent.mock.calls[0][0].config?.systemInstruction)).toContain('相手の言い方のまま');
    });

    // 実際のGeminiで、相手の「午後2時半」が「午後230」「午後25時半」になった。そのまま読み上げると意味が変わる。
    it('会話に出てこない数字を含む候補は出さない', async () => {
      const assistant = createAiAssistant(
        createFakeRunner(
          createFakeModels(() =>
            reply(['明日の午後230でお願いします。', '明日の午後2時半でお願いします。', '持ち物はありますか。']),
          ),
        ),
      );

      const result = await assistant.suggestReplies(timeInput);

      expect(result.suggestions.map(({ text }) => text)).toEqual(['明日の午後2時半でお願いします。', '持ち物はありますか。']);
      expect(result.ai).toEqual({ source: 'gemini', model: TEST_MODEL });
    });

    it('本人が言っていない日時を作った候補も出さない', async () => {
      const assistant = createAiAssistant(
        createFakeRunner(
          createFakeModels(() => reply(['明後日の10時はいかがでしょうか。', 'はい、お願いします。', '少々お待ちください。'])),
        ),
      );

      const result = await assistant.suggestReplies(timeInput);

      expect(result.suggestions.map(({ text }) => text)).toEqual(['はい、お願いします。', '少々お待ちください。']);
    });

    it('全角の数字も同じ数字として扱い、用件や相手の名前の数字は使ってよい', async () => {
      const assistant = createAiAssistant(
        createFakeRunner(
          createFakeModels(() =>
            reply(['11月12日の午後2時半でお願いします。', '第3診療所でよろしいですか。', 'はい。']),
          ),
        ),
      );

      const result = await assistant.suggestReplies({
        ...timeInput,
        intent: '11月12日の予約を変えたいです',
        partnerName: '第3診療所',
        latestUtterance: '午後２時半はいかがですか',
      });

      expect(result.suggestions).toHaveLength(3);
    });

    it('桁区切りの有無は同じ数字として扱う', async () => {
      const assistant = createAiAssistant(
        createFakeRunner(createFakeModels(() => reply(['1,500円ですね。承知しました。', '1500円で大丈夫です。', 'はい。']))),
      );

      const result = await assistant.suggestReplies({ ...timeInput, latestUtterance: '初診は1500円ほどかかります' });

      expect(result.suggestions).toHaveLength(3);
    });

    it('使える候補が残らなければ、定型文として理由を示す', async () => {
      const assistant = createAiAssistant(
        createFakeRunner(
          createFakeModels(() => reply(['午後230でお願いします。', '2:30でお願いします。', '25時半でお願いします。'])),
        ),
      );

      const result = await assistant.suggestReplies(timeInput);

      expect(result.ai).toEqual({ source: 'fallback', reason: 'invalid_response' });
      expect(result.suggestions.map(({ text }) => text).join('')).not.toMatch(/230|2:30|25時/);
    });
  });
});

describe('buildFallbackSuggestions', () => {
  it.each([
    ['マイナンバーカードはお持ちですか', 'マイナ持参'],
    ['いつがご都合よろしいですか', '明日午前'],
    ['初診でしょうか', '初診予約'],
    ['少々お待ちください', '了解'],
  ])('「%s」の定型候補を選ぶ', (utterance, tag) => {
    expect(buildFallbackSuggestions(utterance)[0].tag).toBe(tag);
  });

  it('保険の候補に従来の保険証を出さない', () => {
    const texts = buildFallbackSuggestions('保険証はありますか').map(({ text }) => text);

    expect(texts.join('')).not.toContain('保険証を');
  });

  it('日常の連絡では医療向けの定型文を使わない', () => {
    const texts = buildFallbackSuggestions('初診でしょうか。マイナンバーカードは', 'general')
      .map(({ text }) => text)
      .join('');

    expect(texts).not.toMatch(/初診|マイナンバー|資格確認書|持参/);
    expect(texts).toContain('お待ちください');
  });
});

describe('通話の目的とAIへの渡し方', () => {
  const generalInput = {
    intent: '土曜の待ち合わせ',
    purpose: 'general' as const,
    partnerName: '佐藤さん',
    history,
    latestUtterance: '何時にしますか',
  };

  it('発言者を「本人」「相手」で渡し、病院の役割名を使わない', async () => {
    const models = createFakeModels(() => jsonReply(threeSuggestions));

    await createAiAssistant(createFakeRunner(models)).suggestReplies(generalInput);

    const params = models.generateContent.mock.calls[0][0];
    const contents = sentContents(params);
    expect(contents).toContain('"話者":"本人"');
    expect(contents).toContain('"話者":"相手"');
    expect(contents).not.toMatch(/患者|病院受付/);
    expect(contents).toContain('佐藤さん');
    expect(String(params.config?.systemInstruction)).not.toContain('病院');
  });

  it('医療機関への連絡だけ、保険と医療の規則を足す', async () => {
    const models = createFakeModels(() => jsonReply(threeSuggestions));
    const assistant = createAiAssistant(createFakeRunner(models));

    await assistant.suggestReplies({ ...generalInput, purpose: 'medical' });
    await assistant.suggestReplies(generalInput);

    const [medical, general] = models.generateContent.mock.calls.map(([params]) =>
      String(params.config?.systemInstruction),
    );
    expect(medical).toContain('マイナンバーカード');
    expect(medical).toContain('医療上の判断');
    expect(general).not.toContain('マイナンバーカード');
  });

  it('日常の連絡でAIが失敗したら、一般向けの定型文を返す', async () => {
    const assistant = createAiAssistant(createFakeRunner(createFakeModels(FAILING)));

    const result = await assistant.suggestReplies({ ...generalInput, latestUtterance: '初診ですか' });

    expect(result.ai.source).toBe('fallback');
    expect(result.suggestions.map(({ text }) => text).join('')).not.toContain('初診');
  });

  it('整形の指示から病院の受付を外し、目的を伝える', async () => {
    const models = createFakeModels(() => jsonReply({ polished: '土曜でお願いします。' }));

    await createAiAssistant(createFakeRunner(models)).polishText({ ...generalInput, text: '土曜' });

    const instruction = String(models.generateContent.mock.calls[0][0].config?.systemInstruction);
    expect(instruction).not.toContain('病院');
    expect(instruction).toContain('日常の連絡');
  });
});

describe('polishText', () => {
  const input = { intent: '内科の初診予約', history };

  it('AIの案と原文の両方を返す', async () => {
    const assistant = createAiAssistant(
      createFakeRunner(createFakeModels(() => jsonReply({ polished: 'いいえ、ございません。' }))),
    );

    const result = await assistant.polishText({ ...input, text: 'いいえ' });

    expect(result).toEqual({
      original: 'いいえ',
      polished: 'いいえ、ございません。',
      ai: { source: 'gemini', model: TEST_MODEL },
    });
  });

  // 以前は辞書で「いいえ」が「都合が合いません」に、「はい？」が同意の文に変わっていた。
  it.each(['いいえ', 'はい', 'はい？', 'ok', 'ない', '大丈夫です', 'ありがとうございました'])(
    '「%s」を辞書で置き換えず、Geminiに判断を任せる',
    async (text) => {
      const models = createFakeModels(() => jsonReply({ polished: text }));

      await createAiAssistant(createFakeRunner(models)).polishText({ ...input, text });

      expect(models.generateContent).toHaveBeenCalledTimes(1);
      expect(sentContents(models.generateContent.mock.calls[0][0])).toContain(JSON.stringify(text));
    },
  );

  it.each(['いいえ', 'はい？', '3時にしてほしい'])(
    'AIが失敗しても「%s」を言い換えない',
    async (text) => {
      const assistant = createAiAssistant(createFakeRunner(createFakeModels(FAILING)));

      const result = await assistant.polishText({ ...input, text });

      expect(result).toEqual({
        original: text,
        polished: null,
        ai: { source: 'fallback', reason: 'unavailable' },
      });
    },
  );

  it('AIが未設定でも原文を変えない', async () => {
    const assistant = createAiAssistant(createFakeRunner(null));

    const result = await assistant.polishText({ ...input, text: 'いいえ' });

    expect(result.polished).toBeNull();
    expect(result.ai).toEqual({ source: 'fallback', reason: 'not_configured' });
  });

  it('空の案は採用しない', async () => {
    const assistant = createAiAssistant(
      createFakeRunner(createFakeModels(() => jsonReply({ polished: '   ' }))),
    );

    const result = await assistant.polishText({ ...input, text: 'はい' });

    expect(result.polished).toBeNull();
    expect(result.ai).toEqual({ source: 'fallback', reason: 'invalid_response' });
  });
});

describe('extractAppointment', () => {
  const input = {
    intent: '内科の初診予約',
    history: [
      ...history,
      { sender: '病院受付' as const, text: '明日の午後2時半でお取りします' },
    ],
  };

  it('Geminiの読み取りを、会話の言葉と照合してから下書きにする', async () => {
    const assistant = createAiAssistant(
      createFakeRunner(
        createFakeModels(() =>
          jsonReply({
            title: '内科 初診予約',
            dateText: '明日',
            date: '2026-11-08',
            timeText: '午後2時半',
            startTime: '14:30',
            endTime: null,
            details: '持ち物: マイナンバーカード',
          }),
        ),
      ),
      () => NOW,
    );

    const result = await assistant.extractAppointment(input);

    expect(result.ai).toEqual({ source: 'gemini', model: TEST_MODEL });
    expect(result.appointment).toMatchObject({
      title: '内科 初診予約',
      date: '2026-11-08',
      startTime: '14:30',
      endTime: null,
      details: '持ち物: マイナンバーカード',
      spoken: { date: '明日', time: '午後2時半' },
      issues: [],
    });
  });

  it('根拠の言葉を値より先に書かせ、住所も求める', async () => {
    const models = createFakeModels(() =>
      jsonReply({ title: null, date: null, startTime: null, endTime: null, details: null }),
    );

    await createAiAssistant(createFakeRunner(models), () => NOW).extractAppointment(input);

    const config = models.generateContent.mock.calls[0][0].config as {
      responseSchema: { propertyOrdering: string[] };
    };
    const order = config.responseSchema.propertyOrdering;
    expect(order.indexOf('dateText')).toBeLessThan(order.indexOf('date'));
    expect(order.indexOf('timeText')).toBeLessThan(order.indexOf('startTime'));
    expect(order).toContain('address');
  });

  it('会話と矛盾する日時は採用せず、理由を返す', async () => {
    const assistant = createAiAssistant(
      createFakeRunner(
        createFakeModels(() =>
          jsonReply({
            title: null,
            dateText: '明日',
            // 「明日」は 2026-11-08。AIが日付を取り違えた想定。
            date: '2026-11-09',
            timeText: '午後2時半',
            startTime: '02:30',
            endTime: null,
            details: null,
          }),
        ),
      ),
      () => NOW,
    );

    const { appointment } = await assistant.extractAppointment(input);

    expect(appointment.date).toBeNull();
    expect(appointment.startTime).toBeNull();
    expect(appointment.issues?.map((item) => item.code)).toEqual(['date_mismatch', 'time_mismatch']);
  });

  it('会話にない日時・場所・住所は、AIが返しても使わない', async () => {
    const assistant = createAiAssistant(
      createFakeRunner(
        createFakeModels(() =>
          jsonReply({
            title: null,
            dateText: '来週の月曜日',
            date: '2026-11-09',
            timeText: '10時',
            startTime: '10:00',
            endTime: null,
            location: 'さくら病院',
            address: '本町1丁目',
            details: null,
          }),
        ),
      ),
      () => NOW,
    );

    const { appointment } = await assistant.extractAppointment({ ...input, partnerName: 'ひまわり医院' });

    expect(appointment).toMatchObject({ date: null, startTime: null, location: 'ひまわり医院', address: '' });
    expect(appointment.aiFields).toEqual([]);
  });

  it('日本時間の現在日時をGeminiに渡す', async () => {
    const models = createFakeModels(() =>
      jsonReply({ title: null, date: null, startTime: null, endTime: null, details: null }),
    );

    await createAiAssistant(createFakeRunner(models), () => NOW).extractAppointment(input);

    expect(sentContents(models.generateContent.mock.calls[0][0])).toContain(
      '2026-11-07(土) 10:00 Asia/Tokyo',
    );
  });

  it('Geminiが分からないと答えた項目は空のまま返す', async () => {
    const assistant = createAiAssistant(
      createFakeRunner(
        createFakeModels(() =>
          jsonReply({ title: null, date: null, startTime: null, endTime: null, details: null }),
        ),
      ),
      () => NOW,
    );

    const { appointment, ai } = await assistant.extractAppointment(input);

    expect(ai.source).toBe('gemini');
    expect(appointment).toMatchObject({ title: '内科の初診予約', date: null, startTime: null });
  });

  it('AIが失敗しても会話から日時を推測しない', async () => {
    const assistant = createAiAssistant(createFakeRunner(createFakeModels(FAILING)), () => NOW);

    const { appointment, ai } = await assistant.extractAppointment({
      ...input,
      partnerName: 'ひまわり医院',
    });

    expect(ai).toEqual({ source: 'fallback', reason: 'unavailable' });
    expect(appointment).toEqual({
      title: '内科の初診予約',
      date: null,
      startTime: null,
      endTime: null,
      location: 'ひまわり医院',
      address: '',
      details: '',
      aiFields: [],
    });
  });

  it('場所と住所は会話で話されたものを使い、場所がなければ医療機関の名前にする', async () => {
    const reply = (location: string | null, address: string | null) =>
      createAiAssistant(
        createFakeRunner(
          createFakeModels(() =>
            jsonReply({ title: null, date: null, startTime: null, endTime: null, location, address, details: null }),
          ),
        ),
        () => NOW,
      );
    const withPlace = {
      ...input,
      partnerName: 'ひまわり医院',
      history: [...input.history, { sender: '病院受付' as const, text: '本院ではなく駅前分院です。住所は本町2丁目3番4号です。' }],
    };

    const spoken = await reply('駅前分院', '本町2丁目3番4号').extractAppointment(withPlace);
    const unspoken = await reply(null, null).extractAppointment(withPlace);

    expect(spoken.appointment).toMatchObject({ location: '駅前分院', address: '本町2丁目3番4号' });
    expect(unspoken.appointment).toMatchObject({ location: 'ひまわり医院', address: '' });
  });

  it('日常の連絡では、相手の名前を場所にしない', async () => {
    const assistant = createAiAssistant(createFakeRunner(createFakeModels(FAILING)), () => NOW);

    const { appointment } = await assistant.extractAppointment({
      intent: '',
      purpose: 'general',
      partnerName: '母',
      history,
    });

    expect(appointment.location).toBe('');
    expect(appointment.title).toBe('予定');
  });
});
