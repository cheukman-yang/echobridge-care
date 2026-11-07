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

  it('Geminiの読み取りを下書きにする', async () => {
    const assistant = createAiAssistant(
      createFakeRunner(
        createFakeModels(() =>
          jsonReply({
            title: '内科 初診予約',
            date: '2026-11-08',
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
    });
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

    const { appointment, ai } = await assistant.extractAppointment(input);

    expect(ai).toEqual({ source: 'fallback', reason: 'unavailable' });
    expect(appointment).toEqual({
      title: '内科の初診予約',
      date: null,
      startTime: null,
      endTime: null,
      location: 'ひまわり医院 (受付)',
      details: '',
    });
  });
});
