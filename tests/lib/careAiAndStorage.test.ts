// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CARE_AI_MAX_TIMEOUT_MS,
  createCareAiService,
  parseFollowUpDateFromText,
} from '../../server/careAiService';
import { createGeminiRunnerFromEnv } from '../../server/geminiClient';
import type { GeminiRunner, JsonResult } from '../../server/geminiClient';
import { POST as clinicSearchPost } from '@/app/api/clinic-search/route';
import { POST as consultPost } from '@/app/api/consult/route';
import { POST as polishDraftPost } from '@/app/api/polish-draft/route';
import { POST as sandboxReceptionPost } from '@/app/api/sandbox-reception/route';
import {
  buildCalendarAllDayUrl,
  buildMapsDirectionsUrl,
  buildMapsSearchUrl,
  resolveClinicMapQuery,
} from '@/lib/appointment';
import {
  CONSULTATION_STORAGE_KEY,
  RESERVATION_STORAGE_KEY,
  clearSavedConsultations,
  clearSavedReservations,
  deleteConsultationRecord,
  deleteReservationRecord,
  getSavedConsultationsSnapshot,
  getSavedReservationsSnapshot,
  saveConsultationRecord,
  saveReservationRecord,
} from '@/lib/careStorage';
import { SANDBOX_CLINIC } from '@/lib/careTypes';
import { clearUserLanguage, loadUserLanguage, saveUserLanguage } from '@/lib/userLanguage';

function createOfflineRunner(): GeminiRunner {
  return createGeminiRunnerFromEnv({});
}

describe('EchoBridge Care サービス・スタンドアロン即時フォールバック・4秒タイムアウト・ローカル保存', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearSavedConsultations();
    clearSavedReservations();
    clearUserLanguage();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
    clearSavedConsultations();
    clearSavedReservations();
    clearUserLanguage();
  });

  it('使用者言語（ja / en）を localStorage に保持・切り替えできる', () => {
    expect(loadUserLanguage()).toBe('ja');
    saveUserLanguage('en');
    expect(loadUserLanguage()).toBe('en');
  });

  it('Google Maps の経路案内 Directions URL を正しく生成する（任意の出発地 origin 対応）', () => {
    const defaultUrl = buildMapsDirectionsUrl(SANDBOX_CLINIC.address);
    expect(defaultUrl).toBeTruthy();
    const parsedDefault = new URL(defaultUrl as string);
    expect(parsedDefault.origin + parsedDefault.pathname).toBe('https://www.google.com/maps/dir/');
    expect(parsedDefault.searchParams.get('api')).toBe('1');
    expect(parsedDefault.searchParams.get('destination')).toBe(SANDBOX_CLINIC.address);
    expect(parsedDefault.searchParams.get('origin')).toBeNull();
    expect(parsedDefault.searchParams.get('travelmode')).toBe('transit');

    const withOriginUrl = buildMapsDirectionsUrl(SANDBOX_CLINIC.address, '新宿駅');
    const parsedOrigin = new URL(withOriginUrl as string);
    expect(parsedOrigin.searchParams.get('origin')).toBe('新宿駅');
    expect(parsedOrigin.searchParams.get('destination')).toBe(SANDBOX_CLINIC.address);
  });

  it('APIキー未設定時、外部APIを叩かず即座にローカル解析・模擬クリニック最上部固定で応答する', async () => {
    const start = performance.now();
    const service = createCareAiService(createOfflineRunner());
    const result = await service.searchClinics({
      symptoms: '昨日から耳の痛みとめまいがあります',
      area: '新宿駅周辺',
      preferredDepartment: 'ent',
      preferredSlots: ['今日の午後', '明日の午前', '明日の午後'],
      userLanguage: 'ja',
    });
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(500);
    expect(result.ai).toEqual({ source: 'fallback', reason: 'not_configured' });
    expect(result.clinics.length).toBeGreaterThanOrEqual(2);
    expect(result.clinics[0].id).toBe(SANDBOX_CLINIC.id);
    expect(result.clinics[0].name).toBe('[審査・検証用] EchoBridge Care 模擬クリニック');
    expect(result.clinics[0].isSandbox).toBe(true);
    expect(result.recommendedDepartments[0]).toBe('耳鼻咽喉科');
    expect(result.suggestedIntent).toContain('第1希望が今日の午後');
  });

  it('APIキー設定時でも応答が遅延した場合は最大4秒（4000ms）でタイムアウトしてローカルフォールバックへ切り替わる', async () => {
    vi.useFakeTimers();

    const hangingRunner: GeminiRunner = {
      config: {
        backend: 'api_key',
        model: 'gemini-2.5-flash',
        timeoutMs: 15_000,
        extractionTimeoutMs: 20_000,
      },
      status: {
        configured: true,
        backend: 'api_key',
        model: 'gemini-2.5-flash',
      },
      generateJson: <T,>() => new Promise<JsonResult<T>>(() => {}),
    };

    const service = createCareAiService(hangingRunner);
    const pending = service.searchClinics({
      symptoms: '発熱と喉の痛み',
      area: '東京駅周辺',
      userLanguage: 'en',
    });

    await vi.advanceTimersByTimeAsync(CARE_AI_MAX_TIMEOUT_MS + 10);
    const result = await pending;

    expect(CARE_AI_MAX_TIMEOUT_MS).toBe(4_000);
    expect(result.ai).toEqual({ source: 'fallback', reason: 'timeout' });
    expect(result.clinics[0].isSandbox).toBe(true);
    expect(result.recommendedDepartments).toContain('Internal Medicine');
  });

  it('/api/clinic-search・/api/sandbox-reception・/api/consult ルートが APIキーなしでも高速に 200 OK を返す', async () => {
    const prevKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const searchRes = await clinicSearchPost(
        new Request('http://localhost:3000/api/clinic-search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symptoms: 'Fever and sore throat',
            area: 'Shinjuku Station',
            preferredDepartment: 'internal',
            preferredSlots: ['Today PM', 'Tomorrow AM'],
            userLanguage: 'en',
          }),
        }),
      );
      expect(searchRes.status).toBe(200);
      const searchJson = (await searchRes.json()) as { clinics: Array<{ isSandbox: boolean }> };
      expect(searchJson.clinics[0]?.isSandbox).toBe(true);

      const receptionRes = await sandboxReceptionPost(
        new Request('http://localhost:3000/api/sandbox-reception', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'turn',
            intent: '初診予約をお願いします',
            history: [{ id: '1', sender: 'patient', textJa: '初診予約をお願いします' }],
            userLanguage: 'ja',
          }),
        }),
      );
      expect(receptionRes.status).toBe(200);
      const receptionJson = (await receptionRes.json()) as { suggestions: unknown[] };
      expect(receptionJson.suggestions).toHaveLength(3);

      const consultRes = await consultPost(
        new Request('http://localhost:3000/api/consult', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'simulate_doctor',
            chiefComplaint: '喉の痛み',
            history: [],
            userLanguage: 'en',
          }),
        }),
      );
      expect(consultRes.status).toBe(200);
      const consultJson = (await consultRes.json()) as {
        doctorJa: string;
        doctorEn: string;
        suggestions: unknown[];
      };
      expect(consultJson.doctorJa).toBeTruthy();
      expect(consultJson.doctorEn).toBeTruthy();
      expect(consultJson.suggestions).toHaveLength(3);
    } finally {
      if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
    }
  });

  it('再診時期の表現（例：2週間後に再受診）から YYYY-MM-DD を自動抽出する', () => {
    const extracted = parseFollowUpDateFromText(
      ['お薬を5日分出します。経過を確認したいので、2週間後に再受診してください。'],
      '2026-11-12',
    );
    expect(extracted.spokenText).toContain('2週間後に再受診');
    expect(extracted.date).toBe('2026-11-26');
  });

  it('予約記録（SavedReservationRecord）と診察要約（SavedConsultationRecord）を localStorage に保存・引き継ぎ・削除できる', async () => {
    saveReservationRecord({
      id: 'rsv-1',
      createdAt: '2026-11-12T02:00:00Z',
      clinicName: SANDBOX_CLINIC.name,
      clinicNameEn: SANDBOX_CLINIC.nameEn,
      address: SANDBOX_CLINIC.address,
      date: '2026-11-13',
      startTime: '10:30',
      symptomsMemo: '昨日の夜から38度の熱と喉の痛みがあります。',
      preferredSlots: ['今日の午後', '明日の午前'],
      departmentLabel: '内科',
      userLanguage: 'ja',
    });

    expect(window.localStorage.getItem(RESERVATION_STORAGE_KEY)).toBeTruthy();
    expect(getSavedReservationsSnapshot()).toHaveLength(1);
    expect(getSavedReservationsSnapshot()[0].clinicName).toBe(SANDBOX_CLINIC.name);

    deleteReservationRecord('rsv-1');
    expect(getSavedReservationsSnapshot()).toHaveLength(0);

    const fixedNow = () => new Date('2026-11-12T03:00:00Z');
    const service = createCareAiService(createOfflineRunner(), fixedNow);
    const turns = [
      {
        id: '1',
        speaker: 'patient' as const,
        japaneseText: '昨日の夜から喉の痛みと38.0度の発熱があります。',
        englishText: 'Sore throat and 38.0°C fever since last night.',
        timestamp: '2026-11-12T03:00:00Z',
      },
      {
        id: '2',
        speaker: 'doctor' as const,
        japaneseText: '解熱鎮痛薬を5日分処方します。2週間後に再受診してください。',
        englishText: 'Prescribing fever reducer for 5 days. Please return in 2 weeks.',
        timestamp: '2026-11-12T03:02:00Z',
      },
    ];

    const summary = await service.summarizeConsultation({
      turns,
      chiefComplaint: '喉の痛みと発熱',
      clinicName: SANDBOX_CLINIC.name,
      userLanguage: 'en',
    });

    expect(summary.followUp.recommendedDate).toBe('2026-11-26');

    saveConsultationRecord({
      id: 'rec-1',
      createdAt: '2026-11-12T03:05:00Z',
      clinicName: SANDBOX_CLINIC.name,
      userLanguage: 'en',
      turns,
      summary,
    });

    expect(window.localStorage.getItem(CONSULTATION_STORAGE_KEY)).toBeTruthy();
    expect(getSavedConsultationsSnapshot()).toHaveLength(1);
    expect(getSavedConsultationsSnapshot()[0].summary.chiefComplaint).toBe('喉の痛みと発熱');

    deleteConsultationRecord('rec-1');
    expect(getSavedConsultationsSnapshot()).toHaveLength(0);
  });

  it('海外受診モード（患者: 日本語 ⇄ 医師: English, doctorLanguage="en"）で英語医師発言＋日本語訳＋日本語表示/英語伝達3択候補を返す', async () => {
    const service = createCareAiService(createOfflineRunner());
    const sim = await service.simulateDoctorTurn({
      chiefComplaint: '昨日の夜から喉の痛みと38.0度の熱があります',
      history: [],
      userLanguage: 'ja',
      doctorLanguage: 'en',
    });

    expect(sim.doctorEn).toContain('What brings you in today?');
    expect(sim.doctorJa).toContain('本日はどのような症状でしょうか');
    expect(sim.suggestions).toHaveLength(3);
    // displayText は日本人患者向けの日本語、text は医師側180度画面向けの英語医療表現
    expect(sim.suggestions[0]?.displayText).toContain('昨日の夜から喉の痛み');
    expect(sim.suggestions[0]?.text).toContain('My throat has hurt since last night');

    const polished = await service.polishPatientConsultInput({
      text: '昨日の夜から喉の痛みがあり、38.0度の熱があります。アレルギーなし',
      userLanguage: 'ja',
      doctorLanguage: 'en',
      history: [],
    });
    expect(polished.englishText).toContain('sore throat');
    expect(polished.englishText).toContain('38.0°C fever');
    expect(polished.englishText).toContain('no drug or food allergies');

    const enFollowUp = parseFollowUpDateFromText(
      ['Please return for a follow-up visit in 2 weeks.'],
      '2026-11-12',
    );
    expect(enFollowUp.date).toBe('2026-11-26');
    expect(enFollowUp.time).toBe('');
  });

  it('✨ AIブラッシュアップ（polishDraftField・/api/polish-draft）：粗い入力メモを日英の丁寧な医療表現へ整形する', async () => {
    const service = createCareAiService(createOfflineRunner());

    const jaSymptoms = await service.polishDraftField({
      text: 'きのうの夜から38度の熱とのどが痛い。今日みてもらいたい',
      field: 'symptoms',
      userLanguage: 'ja',
    });
    expect(jaSymptoms.polishedText).toContain('発熱');
    expect(jaSymptoms.polishedText).toContain('咽頭痛');

    const enConsultMemo = await service.polishDraftField({
      text: 'throat hurts since last night and 38C fever, no allergies',
      field: 'consult_memo',
      userLanguage: 'en',
    });
    expect(enConsultMemo.polishedText).toContain('sore throat');
    expect(enConsultMemo.polishedText).toContain('38');

    const prevKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const res = await polishDraftPost(
        new Request('http://localhost:3000/api/polish-draft', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: 'きのうから熱とのどの痛み。初診予約したい',
            field: 'intent',
            userLanguage: 'ja',
          }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { polishedText: string };
      expect(json.polishedText).toContain('初診の予約をお願いしたくご連絡いたしました');
    } finally {
      if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
    }
  });

  it('Google Maps の経路案内（Directions）と周辺地図（Search）に同一の実在住所クエリを渡し、架空施設名・架空ビル名を混入させない', async () => {
    const mapQuery = resolveClinicMapQuery(SANDBOX_CLINIC, SANDBOX_CLINIC.address);
    expect(mapQuery).toBe('東京都千代田区丸の内1-9-1');
    expect(mapQuery).not.toContain('模擬クリニック');
    expect(mapQuery).not.toContain('丸の内メディカルプラザ');

    const dirUrl = new URL(buildMapsDirectionsUrl(mapQuery, '新宿駅') as string);
    const areaUrl = new URL(buildMapsSearchUrl(mapQuery) as string);
    expect(dirUrl.searchParams.get('destination')).toBe(areaUrl.searchParams.get('query'));
    expect(dirUrl.searchParams.get('destination')).toBe('東京都千代田区丸の内1-9-1');

    // 候補クリニック検索結果でも架空ビル名（メディカルビル 2階等）が除去されること
    const service = createCareAiService(createOfflineRunner());
    const searchResult = await service.searchClinics({
      symptoms: '喉の痛み',
      area: '新宿駅周辺',
      userLanguage: 'ja',
    });
    for (const clinic of searchResult.clinics) {
      const resolved = resolveClinicMapQuery(clinic, clinic.address);
      expect(resolved).toBeTruthy();
      expect(resolved).not.toContain('模擬クリニック');
      expect(resolved).not.toContain('メディカルプラザ');
      expect(resolved).not.toContain('メディカルビル');
      expect(resolved).not.toContain('セントラルタワー');
    }
  });

  it('再診時刻抽出の厳密化：時刻言及なし時は空文字（終日予定URL）、時刻言及あり時（デモ最終ターン含む）はその時刻を抽出する', async () => {
    const fixedNow = () => new Date('2026-11-12T03:00:00Z');
    const service = createCareAiService(createOfflineRunner(), fixedNow);

    // 1. 患者が発症時刻「昨夜10時」を話していても、医師が「2週間後に再受診」としか言わなければ時刻は ""（空文字）
    const noTimeSummary = await service.summarizeConsultation({
      turns: [
        {
          id: '1',
          speaker: 'patient',
          japaneseText: '昨日の夜10時から喉が痛いです。',
          englishText: 'My throat has hurt since 10:00 PM last night.',
          timestamp: '2026-11-12T03:00:00Z',
        },
        {
          id: '2',
          speaker: 'doctor',
          japaneseText: 'お薬を出します。2週間後に再受診してください。',
          englishText: 'I will prescribe medication. Please come back in 2 weeks.',
          timestamp: '2026-11-12T03:02:00Z',
        },
      ],
      chiefComplaint: '喉の痛み',
      clinicName: SANDBOX_CLINIC.name,
      userLanguage: 'ja',
    });
    expect(noTimeSummary.followUp.recommendedDate).toBe('2026-11-26');
    expect(noTimeSummary.followUp.recommendedStartTime).toBe('');

    const allDayUrl = new URL(
      buildCalendarAllDayUrl({
        title: noTimeSummary.followUp.title,
        date: '2026-11-26',
        location: SANDBOX_CLINIC.name,
        address: SANDBOX_CLINIC.address,
        details: noTimeSummary.followUp.details,
      }),
    );
    expect(allDayUrl.searchParams.get('dates')).toBe('20261126/20261127');

    // 2. デモ医師発話の第3ターン（doctorTurnCount >= 2）は具体的な時刻「午前10時 / 10:00 AM」を含み、そのまま "10:00" が抽出されること
    const thirdTurnSim = await service.simulateDoctorTurn({
      chiefComplaint: '喉の痛み',
      history: [
        { id: 'd1', speaker: 'doctor', japaneseText: 'どうされましたか？', englishText: 'What brings you in?', timestamp: 't1' },
        { id: 'p1', speaker: 'patient', japaneseText: '喉が痛いです', englishText: 'Sore throat', timestamp: 't2' },
        { id: 'd2', speaker: 'doctor', japaneseText: 'アレルギーはありますか？', englishText: 'Any allergies?', timestamp: 't3' },
        { id: 'p2', speaker: 'patient', japaneseText: 'ありません', englishText: 'None', timestamp: 't4' },
      ],
      userLanguage: 'ja',
      doctorLanguage: 'ja',
    });
    expect(thirdTurnSim.doctorJa).toContain('2週間後の午前10時に再受診');
    expect(thirdTurnSim.doctorEn).toContain('in 2 weeks at 10:00 AM');

    const withTimeSummary = await service.summarizeConsultation({
      turns: [
        {
          id: 'd3',
          speaker: 'doctor',
          japaneseText: thirdTurnSim.doctorJa,
          englishText: thirdTurnSim.doctorEn,
          timestamp: '2026-11-12T03:05:00Z',
        },
      ],
      chiefComplaint: '喉の痛み',
      clinicName: SANDBOX_CLINIC.name,
      userLanguage: 'ja',
    });
    expect(withTimeSummary.followUp.recommendedDate).toBe('2026-11-26');
    expect(withTimeSummary.followUp.recommendedStartTime).toBe('10:00');
  });

  it('診察後サマリーの構造化要約化：医師の単なる質問文を除外し、主訴・所見・既往/アレルギー・処方・療養指示・次回受診の構造化箇条書きを生成する', async () => {
    const fixedNow = () => new Date('2026-11-12T03:00:00Z');
    const service = createCareAiService(createOfflineRunner(), fixedNow);

    const turns = [
      {
        id: 'p1',
        speaker: 'patient' as const,
        japaneseText: '昨晩からの喉の痛みと発熱（38.0℃）があります。',
        englishText: 'Sore throat and fever (38.0°C) since last night.',
        timestamp: '2026-11-12T03:00:00Z',
      },
      {
        id: 'd1',
        speaker: 'doctor' as const,
        japaneseText: '本日はどのような症状でしょうか？いつ頃から始まり、熱は測りましたか？',
        englishText: 'What brings you in today? When did your symptoms start?',
        timestamp: '2026-11-12T03:01:00Z',
      },
      {
        id: 'd2',
        speaker: 'doctor' as const,
        japaneseText: '現在飲んでいるお薬や、薬・食べ物のアレルギーはありますか？',
        englishText: 'Are you taking any medications or do you have any allergies?',
        timestamp: '2026-11-12T03:02:00Z',
      },
      {
        id: 'p2',
        speaker: 'patient' as const,
        japaneseText: '現在飲んでいる薬はなく、薬や食べ物のアレルギーもありません。',
        englishText: 'No current medications and no drug or food allergies.',
        timestamp: '2026-11-12T03:03:00Z',
      },
      {
        id: 'd3',
        speaker: 'doctor' as const,
        japaneseText:
          '喉の奥が少し赤くなっていますね。炎症を抑えるお薬と解熱鎮痛薬を5日分処方します。水分をしっかり摂って安静にし、経過確認のため2週間後の午前10時に再受診してください。',
        englishText:
          'Your throat looks mildly inflamed. I will prescribe anti-inflammatory and fever-reducing medicine for 5 days. Stay hydrated and rest, and please return in 2 weeks at 10:00 AM.',
        timestamp: '2026-11-12T03:04:00Z',
      },
    ];

    const summary = await service.summarizeConsultation({
      turns,
      chiefComplaint: '昨晩からの喉の痛みと発熱（38.0℃）',
      clinicName: SANDBOX_CLINIC.name,
      userLanguage: 'ja',
    });

    const allBullets = [...summary.diagnosticPoints, ...summary.prescriptionsAndInstructions];
    for (const bullet of allBullets) {
      expect(bullet).not.toContain('本日はどのような症状でしょうか');
      expect(bullet).not.toContain('アレルギーはありますか');
      expect(bullet.endsWith('？')).toBe(false);
    }

    expect(summary.diagnosticPoints.some((s) => s.startsWith('主訴：'))).toBe(true);
    expect(summary.diagnosticPoints.some((s) => s.includes('所見：咽頭の発赤あり'))).toBe(true);
    expect(
      summary.diagnosticPoints.some((s) => s.includes('既往・アレルギー：常用薬・アレルギーなし')),
    ).toBe(true);

    expect(
      summary.prescriptionsAndInstructions.some((s) =>
        s.includes('処方：抗炎症薬および解熱鎮痛薬（5日分）'),
      ),
    ).toBe(true);
    expect(
      summary.prescriptionsAndInstructions.some((s) =>
        s.includes('療養指示：十分な水分補給と安静'),
      ),
    ).toBe(true);
    expect(
      summary.prescriptionsAndInstructions.some((s) =>
        s.includes('次回受診：2週間後の午前10時に再受診'),
      ),
    ).toBe(true);
  });
});

