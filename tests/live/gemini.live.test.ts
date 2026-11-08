/**
 * 実際のGeminiを呼ぶテスト。認証が必要で、課金が発生する。架空のデータだけを使う。
 *
 *   npm run test:live
 *   GEMINI_MODEL=gemini-3.8-flash npm run test:live   # モデルの比較
 *
 * 認証がないときは「確認できていない」ことが分かるよう、スキップではなく失敗にする。
 * Vertex AIは ADC（gcloud auth application-default login 等）で認証する。
 * 必要な環境変数はREADMEを参照。
 */
import 'dotenv/config';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createGeminiModels,
  createGeminiRunner,
  resolveGeminiConfig,
} from '../../server/geminiClient';
import { createAiAssistant } from '../../server/geminiService';
import type { AiAssistant } from '../../server/geminiService';
import type { ChatTurn } from '@/lib/callProtocol';

const NOW = new Date('2026-11-09T01:00:00Z'); // 2026-11-09(月) 10:00 JST
const config = resolveGeminiConfig(process.env);

const history: ChatTurn[] = [
  { sender: '患者', text: '内科の初診予約をしたいです。' },
  { sender: '病院受付', text: '明日の午後2時半はいかがですか。' },
  { sender: '患者', text: 'その時間でお願いします。' },
  {
    sender: '病院受付',
    text: 'かしこまりました。マイナンバーカードかお薬手帳をお持ちください。',
  },
];

async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  const result = await run();
  console.info(`[live] ${config.model} ${label}: ${Math.round(performance.now() - startedAt)}ms`);
  return result;
}

describe('Gemini 実API', () => {
  it('認証が設定されている', () => {
    expect(
      config.backend,
      `実APIは未確認です: ${config.problem}。READMEの環境変数を設定してください`,
    ).not.toBeNull();
  });

  describe.skipIf(!config.backend)('各機能', () => {
    let assistant: AiAssistant;

    beforeAll(() => {
      const runner = createGeminiRunner(config, createGeminiModels(config));
      assistant = createAiAssistant(runner, () => NOW);
    });

    it('返答候補を3つ返す', async () => {
      const result = await timed('suggestions', () =>
        assistant.suggestReplies({
          intent: '内科の初診予約',
          history: history.slice(0, 2),
          latestUtterance: '明日の午後2時半はいかがですか。',
        }),
      );

      console.info(result.suggestions);
      expect(result.ai).toEqual({ source: 'gemini', model: config.model });
      expect(result.suggestions).toHaveLength(3);
    });

    it('否定の意味を変えずに整える', async () => {
      const result = await timed('polish', () =>
        assistant.polishText({
          text: 'アレルギーはないです',
          intent: '内科の初診予約',
          history: [{ sender: '病院受付', text: 'アレルギーはありますか。' }],
        }),
      );

      console.info(result.polished);
      expect(result.ai.source).toBe('gemini');
      expect(result.polished).toMatch(/ません|ない|なく/);
    });

    it('数字を残したまま整える', async () => {
      const result = await timed('polish', () =>
        assistant.polishText({ text: '15時に行けます', intent: '予約の変更', history: [] }),
      );

      console.info(result.polished);
      expect(result.ai.source).toBe('gemini');
      expect(result.polished).toContain('15');
    });

    it('合意した日時と持ち物を読み取る', async () => {
      const result = await timed('appointment', () =>
        assistant.extractAppointment({ intent: '内科の初診予約', history }),
      );

      console.info(result.appointment);
      expect(result.ai.source).toBe('gemini');
      expect(result.appointment).toMatchObject({ date: '2026-11-10', startTime: '14:30' });
      expect(result.appointment.details).toContain('マイナンバーカード');
    });

    it('日付と曜日が合わない会話では日付を確定せず、話された住所は表記のまま読み取る', async () => {
      // NOW は 2026-11-09(月)。11月12日は木曜日。
      const result = await timed('appointment', () =>
        assistant.extractAppointment({
          intent: '再診の予約',
          partnerName: 'ひまわり医院',
          history: [
            { sender: '患者', text: '再診の予約をしたいです。' },
            { sender: '病院受付', text: '11月12日の火曜日、午後3時はいかがですか。' },
            { sender: '患者', text: 'はい、お願いします。' },
            { sender: '病院受付', text: '住所は本町2丁目3番4号です。午後3時にお待ちしております。' },
          ],
        }),
      );

      console.info(result.appointment);
      expect(result.ai.source).toBe('gemini');
      expect(result.appointment.date).toBeNull();
      expect(result.appointment.address).toBe('本町2丁目3番4号');
    });

    it('日時が決まっていなければ空のまま返す', async () => {
      const result = await timed('appointment', () =>
        assistant.extractAppointment({
          intent: '内科の初診予約',
          history: [
            { sender: '患者', text: '予約をしたいです。' },
            { sender: '病院受付', text: '来週のどこかで調整しますので、後ほどお電話します。' },
          ],
        }),
      );

      console.info(result.appointment);
      expect(result.ai.source).toBe('gemini');
      expect(result.appointment.date).toBeNull();
      expect(result.appointment.startTime).toBeNull();
    });
  });
});
