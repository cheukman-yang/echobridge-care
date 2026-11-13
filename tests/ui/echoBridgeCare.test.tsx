// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FaceToFaceConsultPage from '@/app/consult/page';
import JoinCallPage from '@/app/join/page';
import EchoBridgeCareHomePage from '@/app/page';
import { SandboxCallView } from '@/components/SandboxCallView';
import { resetCareSpeechCache } from '@/lib/careSpeech';
import {
  CONSULTATION_STORAGE_KEY,
  RESERVATION_STORAGE_KEY,
  clearSavedConsultations,
  clearSavedReservations,
  getSavedReservationsSnapshot,
  saveConsultationRecord,
  saveReservationRecord,
} from '@/lib/careStorage';
import { SANDBOX_CLINIC } from '@/lib/careTypes';
import {
  DEFAULT_CARE_CUSTOM_PHRASE_TEXT,
  clearCustomPhrases,
  saveCustomPhrases,
} from '@/lib/customPhrases';
import { HOME_HUB_RESET_HREF, resetHomeHubStoreForTests } from '@/lib/homeReset';
import { clearUserLanguage, saveUserLanguage } from '@/lib/userLanguage';
import { FakeWebSocket } from '../helpers/fakeWebSocket';

describe('EchoBridge Care 全フェーズ統合UI・双方向言語モード・審査員ワンタップ進行検証', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    window.history.replaceState(null, '', '/');
    window.sessionStorage.clear();
    window.localStorage.clear();
    resetHomeHubStoreForTests();
    resetCareSpeechCache();
    clearSavedConsultations();
    clearSavedReservations();
    clearCustomPhrases();
    clearUserLanguage();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('トップ画面（/）は言語切替スイッチと2つの大きなモード選択カードのみを表示し、不要なWebSocket接続を一切行わない', () => {
    render(<EchoBridgeCareHomePage />);

    // WebSocket接続がゼロ件であること（npm run dev 単体起動時のコンソール赤エラーゼロ）
    expect(FakeWebSocket.instances).toHaveLength(0);

    expect(screen.getByText('EchoBridge Care')).toBeTruthy();
    expect(screen.getByText('あなたの言語 / Select Your Language')).toBeTruthy();
    expect(screen.getByRole('button', { name: '🇯🇵 日本語' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '🇺🇸 English' })).toBeTruthy();

    // 2つの大きなモード選択カードのみ（今押すべき1箇所 hub-card-booking のみに animate-action-cue が付与されていること）
    const bookingCard = screen.getByTestId('hub-card-booking');
    expect(bookingCard.textContent).toContain('🏥 病院を探す・AIで予約電話する');
    expect(bookingCard.className).toContain('animate-action-cue');
    const consultCard = screen.getByTestId('hub-card-consult') as HTMLAnchorElement;
    expect(consultCard.textContent).toContain('🩺 診察室で使う（対面診察・上下反転モード）');
    expect(consultCard.getAttribute('href')).toBe('/consult');
    expect(consultCard.className).not.toContain('animate-action-cue');

    // 不要な日常連絡や招待参加リンクが存在しないこと
    expect(screen.queryByText('通話の目的')).toBeNull();
    expect(screen.queryByText('日常の連絡')).toBeNull();
    expect(screen.queryByText('招待を受け取った方')).toBeNull();

    // 🇺🇸 English 選択時にハブ画面全体が自然な英語へ切り替わること
    fireEvent.click(screen.getByRole('button', { name: '🇺🇸 English' }));
    expect(screen.getByTestId('hub-card-booking').textContent).toContain(
      '🏥 Find a Clinic & Book by AI Call',
    );
    expect(screen.getByTestId('hub-card-consult').textContent).toContain(
      '🩺 Use in Exam Room (Face-to-Face 180° Mode)',
    );
  });

  it('/join で明示的にWebSocket接続を試行し失敗した場合でも、無限リトライせず静かに終了する', async () => {
    vi.useFakeTimers();
    render(<JoinCallPage />);

    expect(FakeWebSocket.instances).toHaveLength(1);
    // サーバー未起動でハンドシェイク自体が失敗（openする前にonclose発火）したケースを再現
    act(() => {
      FakeWebSocket.instances[0]?.drop(1006);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    // 再接続ループが発生せず1回きりで停止していること
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('4ステップ電話予約ウィザード（Step 1〜4）：任意出発地のMaps反映・即答フレーズ＆登録済み文バー・完了後の対話ログ表示・動作モードバッジが動作する', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string };
      if (url.includes('/api/clinic-search')) {
        return new Response(
          JSON.stringify({
            organizedSymptoms: '昨夜からの38℃発熱・咽頭痛',
            organizedSymptomsEn: '38°C fever and sore throat since last night',
            recommendedDepartments: ['Internal Medicine', 'ENT'],
            urgencyNote: 'Seek immediate care if you have difficulty breathing.',
            suggestedIntent:
              'I would like to book an Internal Medicine appointment for 38°C fever and sore throat.',
            clinics: [SANDBOX_CLINIC],
            ai: { source: 'fallback', reason: 'not_configured' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/sandbox-reception') && body.action === 'turn') {
        return new Response(
          JSON.stringify({
            receptionistJa:
              'EchoBridge Care 模擬クリニックでございます。明日の午前10時半はいかがですか？',
            receptionistEn:
              'Thank you for calling EchoBridge Care Mock Clinic. How about tomorrow at 10:30 AM?',
            isReservationConfirmed: true,
            suggestions: [
              {
                text: '明日の午前10時半でお願いします。',
                displayText: 'Tomorrow at 10:30 AM works for me, please.',
                tag: '10:30 AM',
              },
              {
                text: '午後の枠は空いていますか？',
                displayText: 'Do you have afternoon slots?',
                tag: 'Afternoon',
              },
              {
                text: '持ち物を教えてください。',
                displayText: 'What should I bring?',
                tag: 'Items',
              },
            ],
            ai: { source: 'fallback', reason: 'not_configured' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/sandbox-reception') && body.action === 'polish') {
        return new Response(
          JSON.stringify({
            japaneseMedicalText: 'AI音声アシスタントを使用して通話しております。',
            englishText: 'I am using an AI voice assistant.',
            ai: { source: 'fallback', reason: 'not_configured' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/care/tts')) {
        return new Response(JSON.stringify({ available: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          appointment: {
            title: 'First Visit (EchoBridge Care Mock Clinic)',
            date: '2026-11-15',
            startTime: '10:30',
            endTime: '11:00',
            location: SANDBOX_CLINIC.name,
            address: SANDBOX_CLINIC.address,
            details: 'Health insurance card / ID',
            aiFields: ['title', 'date', 'startTime', 'location', 'address', 'details'],
          },
          ai: { source: 'fallback', reason: 'not_configured' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<EchoBridgeCareHomePage />);

    // 英語に切り替えて予約ウィザードへ進む
    fireEvent.click(screen.getByRole('button', { name: '🇺🇸 English' }));
    fireEvent.click(screen.getByTestId('hub-card-booking'));

    // ========== Step 1/4 ==========
    expect(screen.getByTestId('wizard-step-indicator').textContent).toBe('Step 1/4');
    expect(screen.getByTestId('wizard-step-1')).toBeTruthy();

    // 未入力時は [Fill Example] のみが閃光＋マイクロ振動（animate-action-cue）し、次へボタンは静止していること
    expect(screen.getByTestId('clinic-fill-example-button').className).toContain(
      'animate-action-cue',
    );
    expect(screen.getByTestId('wizard-step1-next').className).not.toContain('animate-action-cue');

    // [Fill Example] ワンクリックで主訴・希望日時3候補に加えて「希望エリア」と「出発地・スタート地点」も同時に自動入力されること
    fireEvent.click(screen.getByTestId('clinic-fill-example-button'));
    expect(
      (screen.getByLabelText('1. Symptoms & Specific Request') as HTMLTextAreaElement).value,
    ).toContain('38°C fever and sore throat');
    // 入力完了後は [Fill Example] の誘導が消え、[Analyze Symptoms & Find Clinics (Step 2)] に誘導が移ること
    expect(screen.getByTestId('clinic-fill-example-button').className).not.toContain(
      'animate-action-cue',
    );
    expect(screen.getByTestId('wizard-step1-next').className).toContain('animate-action-cue');

    expect((screen.getByTestId('preferred-slot-0') as HTMLInputElement).value).toBe(
      'Today PM (14:00–17:00)',
    );
    expect(
      (screen.getByLabelText('4. Preferred Area') as HTMLInputElement).value,
    ).toBe('Around Shinjuku Station');
    expect((screen.getByTestId('wizard-origin-input') as HTMLInputElement).value).toBe(
      'Shinjuku Station',
    );

    // 診療科チップ選択（ENT）も切り替えられること
    fireEvent.click(screen.getByTestId('dept-chip-ent'));
    expect(screen.getByTestId('dept-chip-ent').getAttribute('aria-checked')).toBe('true');

    // Step 2 へ進む
    fireEvent.click(screen.getByTestId('wizard-step1-next'));

    // ========== Step 2/4 ==========
    await waitFor(() => {
      expect(screen.getByTestId('wizard-step-indicator').textContent).toBe('Step 2/4');
      expect(screen.getByTestId('wizard-step-2')).toBeTruthy();
    });

    // 上部ステータス付近に動作モードバッジ（Local Demo Mode）が表示されていること
    expect(screen.getAllByTestId('care-ai-mode-badge')[0]?.textContent).toContain(
      'Local Demo Mode (No API Key)',
    );

    // 最上部に [審査・検証用] 模擬クリニックがピン留め表示され、選択ボタンに閃光誘導が付いていること
    expect(screen.getByTestId('sandbox-clinic-card').textContent).toContain(
      '[For Review/Testing] EchoBridge Care Mock Clinic',
    );
    expect(screen.getByTestId('select-sandbox-clinic-button').className).toContain(
      'animate-action-cue',
    );
    fireEvent.click(screen.getByTestId('select-sandbox-clinic-button'));

    // ========== Step 3/4 ==========
    expect(screen.getByTestId('wizard-step-indicator').textContent).toBe('Step 3/4');
    expect(screen.getByTestId('wizard-step-3')).toBeTruthy();

    // Step 1・2から自動生成された最初の用件（主訴＋希望日時3候補）が入っており、通話開始ボタンのみが閃光誘導されていること
    const intentBox = screen.getByLabelText('Opening Message') as HTMLTextAreaElement;
    expect(intentBox.value).toContain('38°C fever and sore throat');
    expect(intentBox.value).toContain('#1 Today PM');
    expect(screen.getByTestId('setup-fill-example-button').className).not.toContain(
      'animate-action-cue',
    );
    expect(screen.getByTestId('wizard-step3-start-call').className).toContain(
      'animate-action-cue',
    );

    // 折りたたみ式の「よく使う文の登録（任意）」を開いて例文挿入・目立つ確定ボタンで保存できること
    fireEvent.click(screen.getByText('Saved Quick Phrases (Optional)'));
    fireEvent.click(screen.getByTestId('insert-example-phrase-button'));
    expect((screen.getByLabelText('Add a Quick Phrase') as HTMLTextAreaElement).value).toContain(
      'I am using an AI voice assistant',
    );
    const confirmAddBtn = screen.getByTestId('confirm-add-custom-phrase-button');
    expect(confirmAddBtn.textContent).toContain('[✅ Confirm & Save Phrase to List]');
    fireEvent.click(confirmAddBtn);

    // Step 4 通話開始
    fireEvent.click(screen.getByTestId('wizard-step3-start-call'));

    // ========== Step 4/4 ==========
    await waitFor(() => {
      expect(screen.getByTestId('wizard-step-indicator').textContent).toBe('Step 4/4');
      expect(screen.getByTestId('sandbox-call-view')).toBeTruthy();
      expect(screen.getByText(/How about tomorrow at 10:30 AM/)).toBeTruthy();
    });

    // 通話中の自由入力欄の左横に音声入力（マイク）ボタンが表示されていること
    expect(screen.getByTestId('sandbox-voice-input-button')).toBeTruthy();

    // AI3択回答候補はデフォルトでコンパクトな1行バーに格納され、会話ログを塞がないこと
    const sandboxToggleSuggestions = screen.getByTestId('sandbox-toggle-suggestions-button');
    expect(sandboxToggleSuggestions.getAttribute('aria-expanded')).toBe('false');
    expect(sandboxToggleSuggestions.textContent).toContain('💡 Open AI 3-Choice Replies (3) ▲');
    expect(screen.queryByTestId('sandbox-suggestions')).toBeNull();

    // 常時表示バーには標準即答フレーズのみが表示され、長い登録文は「📌 Saved Phrases (1)」トグルボタンで分離されていること
    const quickBar = screen.getByTestId('sandbox-quick-phrases-bar');
    expect(quickBar.textContent).not.toContain('I am using an AI voice assistant');
    expect(quickBar.textContent).toContain('Yes, please');
    expect(quickBar.textContent).toContain('One moment, please');
    expect(quickBar.textContent).toContain('Could you repeat that slowly?');
    expect(quickBar.textContent).toContain('Using text-to-speech voice');
    expect(screen.queryByTestId('sandbox-saved-phrases-panel')).toBeNull();

    const toggleSavedBtn = screen.getByTestId('sandbox-toggle-saved-phrases-button');
    expect(toggleSavedBtn.textContent).toContain('📌 Saved Phrases (2)');
    fireEvent.click(toggleSavedBtn);
    const savedPanel = screen.getByTestId('sandbox-saved-phrases-panel');
    expect(savedPanel.textContent).toContain(DEFAULT_CARE_CUSTOM_PHRASE_TEXT.en);
    expect(savedPanel.textContent).toContain('I am using an AI voice assistant');

    // 標準即答フレーズをワンタップ送信できること
    fireEvent.click(screen.getByRole('button', { name: 'Yes, please' }));
    await waitFor(() => {
      expect(screen.getByText('はい、お願いいたします。')).toBeTruthy();
    });

    // 通話終了 → 完了ページ1（病院への経路案内）➔ 完了ページ2（Google Calendar 予約登録 ＆ 対話ログ）の2ステップ分割
    fireEvent.click(screen.getByRole('button', { name: /End Call & Review/ }));

    await waitFor(() => {
      expect(screen.getByTestId('sandbox-call-completed')).toBeTruthy();
      expect(screen.getByTestId('sandbox-completed-page-1')).toBeTruthy();
      expect(screen.queryByTestId('sandbox-completed-page-2')).toBeNull();
      expect(screen.getByTestId('reservation-saved-banner')).toBeTruthy();
      expect(screen.getByTestId('directions-origin-label').textContent).toContain(
        'Shinjuku Station',
      );

      const directionsLink = screen.getByTestId('maps-directions-link') as HTMLAnchorElement;
      expect(directionsLink.href).toContain('https://www.google.com/maps/dir/');
      const parsedDirUrl = new URL(directionsLink.href);
      expect(parsedDirUrl.searchParams.get('origin')).toBe('Shinjuku Station');
    });

    // [次へ：Google Calendar 予約登録へ進む →] ボタンで完了ページ2へ進む
    fireEvent.click(screen.getByTestId('sandbox-completed-next-button'));

    await waitFor(() => {
      expect(screen.getByTestId('sandbox-completed-page-2')).toBeTruthy();
      expect(screen.queryByTestId('sandbox-completed-page-1')).toBeNull();
      expect(screen.getByText(/Google Calendar Preview/)).toBeTruthy();

      // 予約通話の対話ログアコーディオンが表示され、会話履歴を確認できること
      const transcriptDetails = screen.getByTestId('sandbox-call-transcript-details');
      expect(transcriptDetails.textContent).toContain(
        'View Booking Call Transcript (Saved Locally)',
      );
      expect(transcriptDetails.textContent).toContain('はい、お願いいたします。');

      const handoffLink = screen.getByTestId('handoff-to-consult-link') as HTMLAnchorElement;
      expect(handoffLink.getAttribute('href')).toBe('/consult');
      expect(handoffLink.className).toContain('animate-action-cue');
      expect(handoffLink.textContent).toContain(
        '🩺 Arrived at the Clinic: Open Face-to-Face Mode (Carry Over Booking Info)',
      );
    });

    // 「経路案内に戻る」で完了ページ1に戻れること
    fireEvent.click(screen.getByTestId('sandbox-completed-back-button'));
    expect(screen.getByTestId('sandbox-completed-page-1')).toBeTruthy();

    // localStorage に予約情報（出発地・対話ログ含む）が確実に保存されていること
    expect(window.localStorage.getItem(RESERVATION_STORAGE_KEY)).toBeTruthy();
    expect(getSavedReservationsSnapshot()).toHaveLength(1);
    expect(getSavedReservationsSnapshot()[0].clinicName).toBe(SANDBOX_CLINIC.name);
    expect(getSavedReservationsSnapshot()[0].originLocation).toBe('Shinjuku Station');
    expect(getSavedReservationsSnapshot()[0].turns?.length).toBeGreaterThanOrEqual(2);

    // 全ステップを通じて WebSocket 接続は一切作られていないこと
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('対面診察モード（/consult）国内フロー：予約引き継ぎ・開始直後の自動初回問診・ワンタップ質問進行ボタン・即答フレーズバー・再診日の自動展開が動作する', async () => {
    window.localStorage.setItem(
      RESERVATION_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'rsv-demo-1',
          createdAt: '2026-11-13T01:00:00Z',
          clinicName: '[審査・検証用] EchoBridge Care 模擬クリニック',
          clinicNameEn: '[Review Sandbox] EchoBridge Care Mock Clinic',
          address: SANDBOX_CLINIC.address,
          date: '2026-11-15',
          startTime: '10:30',
          symptomsMemo: '昨日の夜から38度の熱と喉の痛みがあります。',
          preferredSlots: ['今日の午後（14:00〜17:00）'],
          departmentLabel: '内科',
          userLanguage: 'ja',
        },
      ]),
    );

    let simCount = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/care/tts')) {
        return new Response(JSON.stringify({ available: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string; text?: string };
      if (body.action === 'patient_polish') {
        return new Response(
          JSON.stringify({
            japaneseMedicalText: body.text ?? '昨日の夜から38度の熱と喉の痛みがあります。',
            englishText: '38°C fever and sore throat since last night.',
            ai: { source: 'fallback', reason: 'not_configured' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (body.action === 'simulate_doctor') {
        simCount += 1;
        if (simCount === 1) {
          return new Response(
            JSON.stringify({
              doctorJa: '本日はどのような症状でしょうか？いつ頃から痛みますか？',
              doctorEn: 'What brings you in today? When did the pain start?',
              suggestions: [
                {
                  text: '昨日の夜から喉の痛みがあり、今朝は38.0度の熱がありました。',
                  displayText: '昨日の夜から喉の痛みがあり、今朝は38.0度の熱がありました。',
                  tag: '昨夜から',
                },
                {
                  text: '3日前からです。',
                  displayText: '3日前からです。',
                  tag: '3日前から',
                },
                {
                  text: '今朝からです。',
                  displayText: '今朝からです。',
                  tag: '今朝から',
                },
              ],
              ai: { source: 'fallback', reason: 'not_configured' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            doctorJa: '現在飲んでいるお薬やアレルギーはありますか？',
            doctorEn: 'Are you taking any medications or do you have any allergies?',
            suggestions: [
              {
                text: '現在飲んでいる薬はなく、アレルギーもありません。',
                displayText: '現在飲んでいる薬はなく、アレルギーもありません。',
                tag: '薬・アレルギーなし',
              },
              {
                text: '市販薬を飲みました。',
                displayText: '市販薬を飲みました。',
                tag: '市販薬',
              },
              {
                text: 'アレルギーがあります。',
                displayText: 'アレルギーがあります。',
                tag: 'アレルギーあり',
              },
            ],
            ai: { source: 'fallback', reason: 'not_configured' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          chiefComplaint: '昨夜からの咽頭痛と38.0度の発熱',
          chiefComplaintEn: 'Sore throat and 38.0°C fever since last night',
          diagnosticPoints: ['咽頭の発赤を確認'],
          diagnosticPointsEn: ['Mild throat inflammation confirmed'],
          prescriptionsAndInstructions: ['解熱鎮痛薬を5日分処方、安静と水分補給'],
          prescriptionsAndInstructionsEn: ['Fever reducer prescribed for 5 days; rest and hydrate'],
          followUp: {
            spokenText: '2週間後に再受診',
            recommendedDate: '2026-11-26',
            recommendedStartTime: '10:00',
            title: '再診予定（EchoBridge Care 模擬クリニック）',
            details: '主訴: 昨夜からの咽頭痛と38.0度の発熱',
          },
          ai: { source: 'fallback', reason: 'not_configured' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    // 事前に登録文を1件保存しておく（Step 2 での即答フレーズとの分離を検証）
    saveCustomPhrases([{ id: 'cp-1', text: '筆談とテキスト読み上げで受診しています。' }]);

    render(<FaceToFaceConsultPage />);

    // WebSocket自動接続ゼロ件
    expect(FakeWebSocket.instances).toHaveLength(0);

    // ========== 準備 Step 1/2: 対話言語ペア ＆ 予約記録の選択 ==========
    expect(screen.getByTestId('consult-step-indicator').textContent).toBe('準備 Step 1/2');
    expect(screen.getByTestId('consult-setup-step-1')).toBeTruthy();
    expect(screen.queryByTestId('consult-setup-step-2')).toBeNull();

    // 対話言語ペアの3択セレクターが表示されていること
    expect(screen.getByTestId('lang-pair-ja_ja').textContent).toContain(
      '🇯🇵 患者: 日本語 ⇄ 医師: 日本語',
    );
    expect(screen.getByTestId('lang-pair-en_ja').textContent).toContain(
      '🇺🇸 患者: English ⇄ 医師: 日本語',
    );
    expect(screen.getByTestId('lang-pair-ja_en').textContent).toContain(
      '✈️ 患者: 日本語 ⇄ 医師: English',
    );

    // 予約記録がある未読み込み状態では「予約情報を読み込む」ボタンのみが閃光誘導され、「次へ進む」へ切り替わること
    expect(screen.getByTestId('apply-reservation-handoff-button').className).toContain(
      'animate-action-cue',
    );
    expect(screen.getByTestId('consult-setup-next-button').className).not.toContain(
      'animate-action-cue',
    );
    fireEvent.click(screen.getByTestId('apply-reservation-handoff-button'));
    expect(screen.getByTestId('apply-reservation-handoff-button').className).not.toContain(
      'animate-action-cue',
    );
    expect(screen.getByTestId('consult-setup-next-button').className).toContain(
      'animate-action-cue',
    );
    fireEvent.click(screen.getByTestId('consult-setup-next-button'));

    // ========== 準備 Step 2/2: 症状・アレルギーメモ ＆ 登録文確認 ==========
    expect(screen.getByTestId('consult-step-indicator').textContent).toBe('準備 Step 2/2');
    expect(screen.getByTestId('consult-setup-step-2')).toBeTruthy();
    expect(screen.queryByTestId('consult-setup-step-1')).toBeNull();
    expect(
      (screen.getByLabelText('最初に医師へ見せる主訴メモ（任意）') as HTMLTextAreaElement).value,
    ).toBe('昨日の夜から38度の熱と喉の痛みがあります。');

    // 「戻る」で準備 Step 1/2 に戻り、再度 Step 2/2 に進めること
    fireEvent.click(screen.getByTestId('consult-setup-back-button'));
    expect(screen.getByTestId('consult-setup-step-1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('consult-setup-next-button'));
    expect(screen.getByTestId('consult-setup-step-2')).toBeTruthy();

    // アレルギーメモを入力して [診察を開始する（机上平置きUIへ）] で診察画面へ
    fireEvent.change(screen.getByTestId('consult-allergy-input'), {
      target: { value: 'ペニシリン系アレルギーなし' },
    });
    const startConsultBtn = screen.getByTestId('start-consult-button');
    expect(startConsultBtn.className).toContain('animate-action-cue');
    expect(startConsultBtn.textContent).toContain('[診察を開始する（机上平置きUIへ）]');
    fireEvent.click(startConsultBtn);

    // ========== 診察中（ワイド化された吹き出しタイムライン ＋ デフォルト格納3択バー ＋ 1行中央アクションバー） ==========
    await waitFor(() => {
      expect(screen.getByTestId('consult-step-2')).toBeTruthy();
      expect(screen.queryByTestId('consult-setup-step-2')).toBeNull();
    });

    // ページ最上部ヘッダー右上の重複した「診察終了」ボタンが削除されていること（中央バーの「✅ 診察終了・要約へ」のみ）
    expect(screen.queryByRole('button', { name: '診察終了' })).toBeNull();

    // 中央アクションバーが横並び1行（grid-cols-2 gap-2）に圧縮されていること
    const centralBar = screen.getByTestId('consult-central-action-bar');
    expect(centralBar.className).toContain('grid-cols-2');
    expect(centralBar.className).toContain('gap-2');
    expect(screen.getByTestId('simulate-doctor-button').textContent).toBe('🤖 次の質問(デモ用)');
    expect(screen.getByTestId('end-consult-bar-button').textContent).toBe('✅ 診察終了・要約へ');

    // 上部ステータスに動作モードバッジ「ローカルデモ応答（APIキー不要）」が表示されていること
    expect(screen.getByTestId('care-ai-mode-badge').textContent).toContain(
      'ローカルデモ応答（APIキー不要）',
    );

    const doctorArea = screen.getByTestId('doctor-rotated-area');
    expect(doctorArea.style.transform).toBe('rotate(180deg)');
    expect(screen.getByTestId('doctor-patient-message').textContent).toContain(
      '昨日の夜から38度の熱と喉の痛みがあります',
    );

    // 会話ログが LINE/WhatsApp 風の吹き出しタイムライン（医師＝左寄せ items-start、患者＝右寄せ items-end）になっていること
    const timelineLog = screen.getByTestId('consult-timeline-log');
    expect(timelineLog.getAttribute('role')).toBe('log');
    const initialPatientBubbles = timelineLog.querySelectorAll('[data-testid^="timeline-turn-patient-"]');
    const initialDoctorBubbles = timelineLog.querySelectorAll('[data-testid^="timeline-turn-doctor-"]');
    expect(initialPatientBubbles.length).toBe(1);
    expect(initialPatientBubbles[0]?.className).toContain('items-end');
    expect(initialDoctorBubbles.length).toBe(1);
    expect(initialDoctorBubbles[0]?.className).toContain('items-start');

    expect(screen.getByTestId('patient-doctor-box-header').textContent).toBe(
      '🩺 医師からの質問・説明（患者用・翻訳表示）',
    );
    const doctorTranscriptBox = screen.getByTestId('patient-doctor-transcript');
    expect(doctorTranscriptBox.textContent).toContain(
      '本日はどのような症状でしょうか？いつ頃から痛みますか？',
    );

    // 医師発言到着直後は、タイムラインを隠さないよう AI3択回答候補はデフォルトで閉じた1行バーになり、閃光＋マイクロ振動（animate-action-cue）で誘導されること！
    const drawerToggleBtn = screen.getByTestId('toggle-suggestions-drawer-button');
    expect(drawerToggleBtn.getAttribute('aria-expanded')).toBe('false');
    expect(drawerToggleBtn.className).toContain('animate-action-cue');
    expect(screen.getByTestId('suggestions-drawer-title').textContent).toBe(
      '💡 AI3択回答候補を開く（3件） ▲',
    );
    expect(screen.queryByTestId('consult-suggestions')).toBeNull();

    // 3択バーが誘導中の間、中央バーの「🤖 次の質問(デモ用)」は非ハイライト状態（誘導は1箇所のみ）であること
    const nextQuestionBtn = screen.getByTestId('simulate-doctor-button');
    expect(nextQuestionBtn.getAttribute('data-highlighted')).toBe('false');
    expect(nextQuestionBtn.className).not.toContain('animate-action-cue');

    // ユーザーが「💡 AI3択回答候補を開く（3件） ▲」をタップしたときだけ3択が展開されること
    fireEvent.click(drawerToggleBtn);
    expect(drawerToggleBtn.getAttribute('aria-expanded')).toBe('true');
    expect(drawerToggleBtn.className).not.toContain('animate-action-cue');
    expect(screen.getByTestId('suggestions-drawer-title').textContent).toBe(
      '💡 AI3択回答候補を閉じる（3件） ▼',
    );
    expect(screen.getByTestId('consult-suggestions')).toBeTruthy();

    // 3択回答ボタンをタップして医師側画面を更新 → 即座に1行バーへ自動格納され、タイムラインに右寄せ吹き出しが追加されること
    fireEvent.click(
      screen.getByRole('button', {
        name: /昨日の夜から喉の痛みがあり、今朝は38.0度の熱がありました/,
      }),
    );
    expect(screen.getByTestId('doctor-patient-message').textContent).toBe(
      '昨日の夜から喉の痛みがあり、今朝は38.0度の熱がありました。',
    );
    expect(drawerToggleBtn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('consult-suggestions')).toBeNull();
    expect(timelineLog.textContent).toContain(
      '昨日の夜から喉の痛みがあり、今朝は38.0度の熱がありました。',
    );

    // 患者が回答送信した直後は「🤖 次の質問(デモ用)」ボタンのみが閃光＋マイクロ振動（animate-action-cue）で誘導されること！
    expect(nextQuestionBtn.getAttribute('data-highlighted')).toBe('true');
    expect(nextQuestionBtn.className).toContain('animate-action-cue');
    expect(drawerToggleBtn.className).not.toContain('animate-action-cue');

    // 「🤖 次の質問(デモ用)」を押すと次の医師発言がタイムラインに追加され、再び閉じた1行3択バーに閃光誘導が移ること
    fireEvent.click(nextQuestionBtn);

    await waitFor(() => {
      expect(screen.getByTestId('patient-doctor-transcript').textContent).toContain(
        '現在飲んでいるお薬やアレルギーはありますか？',
      );
      expect(drawerToggleBtn.getAttribute('aria-expanded')).toBe('false');
      expect(drawerToggleBtn.className).toContain('animate-action-cue');
      expect(screen.getByTestId('suggestions-drawer-title').textContent).toBe(
        '💡 AI3択回答候補を開く（3件） ▲',
      );
      expect(nextQuestionBtn.getAttribute('data-highlighted')).toBe('false');
      expect(nextQuestionBtn.className).not.toContain('animate-action-cue');
    });
    // これまでの医師・患者の複数往復吹き出しがすべてタイムライン内に保持されていること
    expect(timelineLog.textContent).toContain('本日はどのような症状でしょうか？いつ頃から痛みますか？');
    expect(timelineLog.textContent).toContain('現在飲んでいるお薬やアレルギーはありますか？');

    // 診察画面の即答フレーズバー：常時表示バーには即答フレーズのみが表示され、登録文は「📌 登録文（1件）」トグルで展開されること
    const consultQuickBar = screen.getByTestId('consult-quick-phrases-bar');
    expect(consultQuickBar.textContent).not.toContain('筆談とテキスト読み上げで受診しています。');
    expect(consultQuickBar.textContent).toContain('はい');
    expect(consultQuickBar.textContent).toContain('いいえ');
    expect(consultQuickBar.textContent).toContain('少しゆっくり話してください');
    expect(consultQuickBar.textContent).toContain('薬のアレルギーがあります');
    expect(screen.queryByTestId('consult-saved-phrases-panel')).toBeNull();

    const consultSavedToggle = screen.getByTestId('consult-toggle-saved-phrases-button');
    expect(consultSavedToggle.textContent).toContain('📌 登録文（1件）');
    fireEvent.click(consultSavedToggle);
    expect(screen.getByTestId('consult-saved-phrases-panel').textContent).toContain(
      '筆談とテキスト読み上げで受診しています。',
    );

    fireEvent.click(screen.getByRole('button', { name: '少しゆっくり話してください' }));
    expect(screen.getByTestId('doctor-patient-message').textContent).toContain(
      '少しゆっくりお話しいただけますでしょうか',
    );
    // 即答フレーズ送信直後も3択ドロワーが格納状態のままで、ワンタップ進行ボタンが閃光誘導されること
    expect(drawerToggleBtn.getAttribute('aria-expanded')).toBe('false');
    expect(nextQuestionBtn.getAttribute('data-highlighted')).toBe('true');
    expect(nextQuestionBtn.className).toContain('animate-action-cue');

    // 中央バーの「✅ 診察終了・要約へ」をクリックして要約画面へ
    fireEvent.click(screen.getByTestId('end-consult-bar-button'));

    // ========== 診察後サマリー: 再診指示がある場合はカレンダー登録フォームが自動展開されること ==========
    await waitFor(() => {
      expect(screen.getByTestId('consult-step-3')).toBeTruthy();
      expect(screen.getByTestId('consult-step-indicator').textContent).toBe('診察要約・再診登録');
      expect(screen.getByTestId('consultation-summary-card')).toBeTruthy();
      expect(screen.getByText(/会話からの抽出：「2週間後に再受診」/)).toBeTruthy();
      const calendarLink = screen.getByTestId('followup-calendar-link') as HTMLAnchorElement;
      expect(calendarLink.href).toContain('calendar.google.com');
      expect(calendarLink.href).toContain('20261126T100000');

      const backHomeLink = screen.getByTestId('consult-back-to-top-link') as HTMLAnchorElement;
      expect(backHomeLink.getAttribute('href')).toBe(HOME_HUB_RESET_HREF);
      expect(backHomeLink.textContent).toContain('トップへ戻る');
    });

    expect(window.localStorage.getItem(CONSULTATION_STORAGE_KEY)).toBeTruthy();
  });

  it('海外受診モード（✈️ 患者: 日本語 ⇄ 医師: English）の双方向通訳表示と、再診指示なし時の手動カレンダー折りたたみUIが動作する', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/care/tts')) {
        return new Response(JSON.stringify({ available: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        action?: string;
        doctorLanguage?: string;
      };
      if (body.action === 'simulate_doctor') {
        expect(body.doctorLanguage).toBe('en');
        return new Response(
          JSON.stringify({
            doctorJa: '本日はどのような症状でしょうか？いつ頃から始まりましたか？',
            doctorEn: 'What brings you in today? When did your symptoms start?',
            suggestions: [
              {
                text: 'My throat has hurt since last night, and I had a 38.0°C fever this morning.',
                displayText: '昨日の夜から喉の痛みがあり、今朝は38.0度の熱がありました。',
                tag: '昨夜・発熱あり',
              },
              {
                text: 'My symptoms started 2 days ago.',
                displayText: '2日前から症状があります。',
                tag: '2日前',
              },
              {
                text: 'It started this morning.',
                displayText: '今朝から始まりました。',
                tag: '今朝',
              },
            ],
            ai: { source: 'gemini', model: 'gemini-2.5-flash' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // 再診時期の言及がない診察サマリー
      return new Response(
        JSON.stringify({
          chiefComplaint: '昨夜からの喉の痛みと発熱',
          chiefComplaintEn: 'Sore throat and fever since last night',
          diagnosticPoints: ['軽度の咽頭炎の所見'],
          diagnosticPointsEn: ['Mild pharyngitis observed'],
          prescriptionsAndInstructions: ['水分補給と安静を継続'],
          prescriptionsAndInstructionsEn: ['Continue hydration and rest'],
          followUp: {
            spokenText: null,
            recommendedDate: null,
            recommendedStartTime: '10:00',
            title: '再診予定（Overseas Clinic）',
            details: '',
          },
          ai: { source: 'gemini', model: 'gemini-2.5-flash' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<FaceToFaceConsultPage />);

    // 準備 Step 1 で「✈️ 患者: 日本語 ⇄ 医師: English」を選択し、準備 Step 2 へ進んで開始
    fireEvent.click(screen.getByTestId('lang-pair-ja_en'));
    expect(screen.getByTestId('lang-pair-ja_en').getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByTestId('consult-setup-next-button'));
    fireEvent.click(screen.getByTestId('start-consult-button'));

    await waitFor(() => {
      expect(screen.getByTestId('consult-step-2')).toBeTruthy();
    });

    // Gemini 応答時は「Gemini AI 応答中」バッジが表示されること
    expect(screen.getByTestId('care-ai-mode-badge').textContent).toContain('Gemini AI 応答中');

    // 下部（患者側）タイムライン吹き出しに医師の英語発言と日本語訳の両方が表示されること
    expect(screen.getByTestId('patient-doctor-english').textContent).toContain(
      'What brings you in today?',
    );
    expect(screen.getByTestId('patient-doctor-japanese').textContent).toContain(
      '本日はどのような症状でしょうか？',
    );

    // デフォルト格納の1行バー「💡 AI3択回答候補を開く（3件） ▲」を開き、日本語の3択回答をタップすると上部180度回転の医師側画面には「英語医療表現」が大きく表示されること
    fireEvent.click(screen.getByTestId('toggle-suggestions-drawer-button'));
    fireEvent.click(
      screen.getByRole('button', {
        name: /昨日の夜から喉の痛みがあり、今朝は38.0度の熱がありました/,
      }),
    );
    expect(screen.getByTestId('doctor-patient-message').textContent).toBe(
      'My throat has hurt since last night, and I had a 38.0°C fever this morning.',
    );

    // 診察終了 → 再診指示がない場合はカレンダーフォームが初期折りたたみ状態であること
    fireEvent.click(screen.getByTestId('end-consult-bar-button'));

    await waitFor(() => {
      expect(screen.getByTestId('consultation-summary-card')).toBeTruthy();
    });

    expect(screen.queryByTestId('followup-calendar-link')).toBeNull();
    const expandBtn = screen.getByTestId('expand-manual-followup-button');
    expect(expandBtn.textContent).toContain('＋ 必要に応じて次回の受診予定を手動で登録する');

    // ボタンを押すと手動登録フォームと Google Calendar ボタンが展開されること
    fireEvent.click(expandBtn);
    expect(screen.getByTestId('followup-calendar-link')).toBeTruthy();
  });

  it('React Strict Mode（開発環境800ms呼び出し演出）かつAPI通信失敗時でも「発信・接続中…」で停止せず、確実にローカルフォールバックで会話を開始する', async () => {
    vi.useFakeTimers();
    vi.stubEnv('NODE_ENV', 'development');

    // /api/sandbox-reception を意図的にネットワーク例外にしてフォールバックも同時検証
    const failingFetch = vi.fn(async (url: string) => {
      if (url.includes('/api/care/tts')) {
        return new Response(JSON.stringify({ available: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error('network_down');
    });
    vi.stubGlobal('fetch', failingFetch);

    render(
      <StrictMode>
        <SandboxCallView
          intent="昨日の夜から喉の痛みと38度の熱があり、初診予約をお願いします"
          voice="female"
          onExit={() => {}}
          clinic={SANDBOX_CLINIC}
        />
      </StrictMode>,
    );

    // 開始直後は800ms呼び出しインジケーターが表示される
    expect(screen.getByTestId('sandbox-dialing-indicator')).toBeTruthy();

    // 800ms経過後、Strict Mode のクリーンアップに握りつぶされることなくローカルフォールバック応答へ進むこと
    await act(async () => {
      await vi.advanceTimersByTimeAsync(850);
    });

    expect(screen.queryByTestId('sandbox-dialing-indicator')).toBeNull();
    expect(
      screen.getByText(/お電話ありがとうございます。EchoBridge Care 模擬クリニックでございます/),
    ).toBeTruthy();

    // 初回受付発言の直後は「💡 AI3択回答候補を開く（3件） ▲」バーが閃光＋マイクロ振動（animate-action-cue）で誘導され、タップで展開できること
    const sandboxToggleBtn = screen.getByTestId('sandbox-toggle-suggestions-button');
    expect(sandboxToggleBtn.getAttribute('aria-expanded')).toBe('false');
    expect(sandboxToggleBtn.className).toContain('animate-action-cue');
    expect(sandboxToggleBtn.textContent).toContain('💡 AI3択回答候補を開く（3件） ▲');

    fireEvent.click(sandboxToggleBtn);
    expect(sandboxToggleBtn.getAttribute('aria-expanded')).toBe('true');
    expect(
      screen.getByRole('button', { name: /明日の午前10時30分でお願いいたします/ }),
    ).toBeTruthy();
  });

  it('英語モード時の対面診察画面（/consult）で医師発言ボックスのヘッダーが Doctor’s Question (Translated for Patient) になる', async () => {
    saveUserLanguage('en');
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/care/tts')) {
        return new Response(JSON.stringify({ available: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error('offline_fallback');
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<FaceToFaceConsultPage />);
    fireEvent.click(screen.getByTestId('consult-setup-next-button'));
    fireEvent.click(screen.getByTestId('start-consult-button'));

    await waitFor(() => {
      expect(screen.getByTestId('consult-step-2')).toBeTruthy();
    });

    expect(screen.getByTestId('patient-doctor-box-header').textContent).toBe(
      "🩺 Doctor's Question (Translated for Patient)",
    );
  });

  it('日本語モード Step 1 の「例を入力」で希望エリア（新宿駅周辺）と出発地（新宿駅）も同時自動入力され、診察後「トップへ戻る」で初期2択ハブ画面に確実にリセットされる', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/care/tts')) {
        return new Response(JSON.stringify({ available: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          chiefComplaint: '咽頭痛・発熱',
          chiefComplaintEn: 'Sore throat and fever',
          diagnosticPoints: ['咽頭炎の所見'],
          diagnosticPointsEn: ['Pharyngitis'],
          prescriptionsAndInstructions: ['安静と水分補給'],
          prescriptionsAndInstructionsEn: ['Rest and hydrate'],
          followUp: {
            spokenText: null,
            recommendedDate: null,
            recommendedStartTime: '10:00',
            title: '再診予定',
            details: '',
          },
          ai: { source: 'fallback', reason: 'not_configured' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    // Next.js ルートキャッシュと同様に EchoBridgeCareHomePage が予約ウィザード途中の状態で保持されているケースを再現
    const homeView = render(<EchoBridgeCareHomePage />);
    fireEvent.click(screen.getByTestId('hub-card-booking'));
    expect(screen.getByTestId('wizard-step-1')).toBeTruthy();

    // 日本語モードで「例を入力」を押すと、希望エリア＝新宿駅周辺・出発地＝新宿駅まで同時入力されること
    fireEvent.click(screen.getByTestId('clinic-fill-example-button'));
    expect(
      (screen.getByLabelText('4. 希望エリア') as HTMLInputElement).value,
    ).toBe('新宿駅周辺');
    expect((screen.getByTestId('wizard-origin-input') as HTMLInputElement).value).toBe('新宿駅');

    // 別ルート（/consult）で診察を完了して「トップへ戻る」をクリックした際、キャッシュされたウィザード画面ではなく初期2択ハブ画面（home-hub）へ確実にリセットされること
    const consultView = render(<FaceToFaceConsultPage />);
    fireEvent.click(screen.getByTestId('consult-setup-next-button'));
    fireEvent.click(screen.getByTestId('start-consult-button'));
    await waitFor(() => {
      expect(screen.getByTestId('consult-step-2')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('end-consult-bar-button'));
    await waitFor(() => {
      expect(screen.getByTestId('consult-back-to-top-link')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('consult-back-to-top-link'));
    consultView.unmount();

    expect(screen.getByTestId('home-hub')).toBeTruthy();
    expect(screen.queryByTestId('wizard-step-1')).toBeNull();
    expect(screen.getByTestId('hub-card-booking')).toBeTruthy();
    expect(screen.getByTestId('hub-card-consult')).toBeTruthy();

    // さらに /?reset=1 クエリパラメータ経由の直接遷移でもハブへリセットされ、URLクエリがクリーン化されること
    fireEvent.click(screen.getByTestId('hub-card-booking'));
    expect(screen.getByTestId('wizard-step-1')).toBeTruthy();
    homeView.unmount();

    window.history.replaceState(null, '', '/?reset=1');
    render(<EchoBridgeCareHomePage />);
    await waitFor(() => {
      expect(screen.getByTestId('home-hub')).toBeTruthy();
      expect(window.location.search).toBe('');
    });
  });

  it('3箇所の「✨ AIブラッシュアップ」ボタン（予約Step1・予約Step3・対面診察準備Step2）：空欄時無効化・医療表現への整形・整形後の自由編集が動作する', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/polish-draft')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          text?: string;
          field?: string;
        };
        if (body.field === 'symptoms') {
          return new Response(
            JSON.stringify({
              polishedText:
                '昨日の夜から38度の発熱と咽頭痛がございます。本日の初診受診を希望しております。',
              ai: { source: 'fallback', reason: 'not_configured' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (body.field === 'intent') {
          return new Response(
            JSON.stringify({
              polishedText:
                '昨日の夜から発熱と咽頭痛があるため、初診の予約をお願いしたくご連絡いたしました。',
              ai: { source: 'fallback', reason: 'not_configured' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            polishedText: '昨夜からの咽頭痛と発熱があり受診いたしました。薬物アレルギーはございません。',
            ai: { source: 'fallback', reason: 'not_configured' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/clinic-search')) {
        return new Response(
          JSON.stringify({
            organizedSymptoms: '発熱・咽頭痛',
            organizedSymptomsEn: 'Fever and sore throat',
            recommendedDepartments: ['内科'],
            urgencyNote: '',
            suggestedIntent: 'きのうから熱とのどが痛いので予約したいです',
            clinics: [SANDBOX_CLINIC],
            ai: { source: 'fallback', reason: 'not_configured' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ available: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    // 1. 予約ウィザード Step 1 & Step 3
    const homeView = render(<EchoBridgeCareHomePage />);
    fireEvent.click(screen.getByTestId('hub-card-booking'));

    const step1PolishBtn = screen.getByTestId('step1-ai-polish-button') as HTMLButtonElement;
    expect(step1PolishBtn.disabled).toBe(true);

    const symptomsTextarea = screen.getByLabelText('1. 主訴・具体的な要件') as HTMLTextAreaElement;
    fireEvent.change(symptomsTextarea, {
      target: { value: 'きのうの夜から38度の熱とのどが痛い。今日みたい' },
    });
    expect(step1PolishBtn.disabled).toBe(false);

    fireEvent.click(step1PolishBtn);
    await waitFor(() => {
      expect(symptomsTextarea.value).toBe(
        '昨日の夜から38度の発熱と咽頭痛がございます。本日の初診受診を希望しております。',
      );
    });
    // 整形後もユーザーが自由に追記・編集できること
    fireEvent.change(symptomsTextarea, {
      target: { value: `${symptomsTextarea.value}（咳も少しあります）` },
    });
    expect(symptomsTextarea.value).toContain('（咳も少しあります）');

    // Step 2 -> Step 3 へ進む
    fireEvent.click(screen.getByTestId('wizard-step1-next'));
    await waitFor(() => {
      expect(screen.getByTestId('select-sandbox-clinic-button')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('select-sandbox-clinic-button'));

    const step3PolishBtn = screen.getByTestId('step3-ai-polish-button') as HTMLButtonElement;
    const intentTextarea = screen.getByLabelText('最初に伝える用件') as HTMLTextAreaElement;
    fireEvent.change(intentTextarea, { target: { value: '' } });
    expect(step3PolishBtn.disabled).toBe(true);

    fireEvent.change(intentTextarea, {
      target: { value: 'きのうから熱とのどが痛いので初診予約したい' },
    });
    expect(step3PolishBtn.disabled).toBe(false);
    fireEvent.click(step3PolishBtn);
    await waitFor(() => {
      expect(intentTextarea.value).toBe(
        '昨日の夜から発熱と咽頭痛があるため、初診の予約をお願いしたくご連絡いたしました。',
      );
    });
    fireEvent.change(intentTextarea, {
      target: { value: `${intentTextarea.value} 午後希望です。` },
    });
    expect(intentTextarea.value).toContain('午後希望です。');
    homeView.unmount();

    // 2. 対面診察 準備 Step 2
    render(<FaceToFaceConsultPage />);
    fireEvent.click(screen.getByTestId('consult-setup-next-button'));

    const consultPolishBtn = screen.getByTestId('consult-ai-polish-button') as HTMLButtonElement;
    expect(consultPolishBtn.disabled).toBe(true);

    const consultTextarea = screen.getByLabelText(
      '最初に医師へ見せる主訴メモ（任意）',
    ) as HTMLTextAreaElement;
    fireEvent.change(consultTextarea, {
      target: { value: 'きのうの夜からのどが痛くて熱がある。アレルギーなし' },
    });
    expect(consultPolishBtn.disabled).toBe(false);
    fireEvent.click(consultPolishBtn);
    await waitFor(() => {
      expect(consultTextarea.value).toBe(
        '昨夜からの咽頭痛と発熱があり受診いたしました。薬物アレルギーはございません。',
      );
    });
    fireEvent.change(consultTextarea, {
      target: { value: `${consultTextarea.value} 解熱剤を希望します。` },
    });
    expect(consultTextarea.value).toContain('解熱剤を希望します。');
  });

  it('Google Maps 経路案内と周辺地図の一致・即答フレーズバーの右スワイプUI・再診時刻未指定時の終日カレンダーURLが正しく動作する', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/care/tts')) {
        return new Response(JSON.stringify({ available: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string };
      if (url.includes('/api/sandbox-reception') && body.action === 'summary') {
        return new Response(
          JSON.stringify({
            appointment: {
              title: '初診予約（EchoBridge Care 模擬クリニック）',
              date: '2026-11-15',
              startTime: '10:30',
              endTime: '11:00',
              location: SANDBOX_CLINIC.name,
              address: SANDBOX_CLINIC.address,
              details: '保険証持参',
              aiFields: ['title', 'date', 'startTime', 'location', 'address'],
            },
            ai: { source: 'fallback', reason: 'not_configured' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/sandbox-reception')) {
        return new Response(
          JSON.stringify({
            receptionistJa: '明日の午前10時30分でご予約を承りました。',
            receptionistEn: 'Your appointment is booked for tomorrow at 10:30 AM.',
            isReservationConfirmed: true,
            suggestions: [
              { text: 'ありがとうございます。', displayText: 'ありがとうございます。', tag: 'お礼' },
              { text: '持ち物はありますか？', displayText: '持ち物はありますか？', tag: '持ち物' },
              { text: '場所はどこですか？', displayText: '場所はどこですか？', tag: '場所' },
            ],
            ai: { source: 'fallback', reason: 'not_configured' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (body.action === 'simulate_doctor') {
        return new Response(
          JSON.stringify({
            doctorJa: 'お薬を出しますので、2週間後に再受診してください。',
            doctorEn: 'Please return in 2 weeks.',
            suggestions: [
              { text: 'わかりました。', displayText: 'わかりました。', tag: '了解' },
              { text: '気をつけることはありますか？', displayText: '気をつけることはありますか？', tag: '注意点' },
              { text: 'ありがとうございます。', displayText: 'ありがとうございます。', tag: 'お礼' },
            ],
            ai: { source: 'fallback', reason: 'not_configured' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // 時刻言及なしの診察後サマリー（recommendedStartTime: ""）
      return new Response(
        JSON.stringify({
          chiefComplaint: '咽頭痛',
          chiefComplaintEn: 'Sore throat',
          diagnosticPoints: ['軽度の咽頭炎'],
          diagnosticPointsEn: ['Mild pharyngitis'],
          prescriptionsAndInstructions: ['解熱鎮痛薬を処方'],
          prescriptionsAndInstructionsEn: ['Analgesic prescribed'],
          followUp: {
            spokenText: '2週間後に再受診',
            recommendedDate: '2026-11-26',
            recommendedStartTime: '',
            title: '再診予定（EchoBridge Care 模擬クリニック）',
            details: '主訴: 咽頭痛',
          },
          ai: { source: 'fallback', reason: 'not_configured' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    // 1. SandboxCallView: 即答フレーズの横スワイプUI ＆ 完了画面のGoogle Maps目的地完全一致
    const sandboxView = render(
      <SandboxCallView
        intent="初診予約をお願いします"
        voice="female"
        onExit={() => {}}
        clinic={SANDBOX_CLINIC}
        originLocation="新宿駅"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('sandbox-quick-phrases-scroll-container')).toBeTruthy();
      expect(
        screen.getByRole('button', { name: /通話を終了して予約・経路を確認/ }),
      ).toBeTruthy();
    });

    const sandboxScroll = screen.getByTestId('sandbox-quick-phrases-scroll-container');
    expect(sandboxScroll.className).toContain('overflow-x-auto');
    expect(sandboxScroll.className).toContain('touch-pan-x');
    expect(sandboxScroll.className).toContain('scroll-smooth');
    expect(screen.getByTestId('sandbox-quick-phrases-right-fade')).toBeTruthy();
    const sandboxRightBtn = screen.getByTestId('sandbox-quick-phrases-scroll-right');
    fireEvent.click(sandboxRightBtn);

    fireEvent.click(screen.getByRole('button', { name: /通話を終了して予約・経路を確認/ }));

    await waitFor(() => {
      expect(screen.getByTestId('sandbox-call-completed')).toBeTruthy();
    });

    // 画面上の表示名はそのまま維持しつつ、Google Maps URL には架空施設名・架空ビル名を含めず同一住所を渡していること
    expect(screen.getByTestId('sandbox-call-completed').textContent).toContain(
      '[審査・検証用] EchoBridge Care 模擬クリニック',
    );
    const dirLink = screen.getByTestId('maps-directions-link') as HTMLAnchorElement;
    const areaLink = screen.getByTestId('maps-area-search-link') as HTMLAnchorElement;
    const dirDestination = new URL(dirLink.href).searchParams.get('destination');
    const areaQuery = new URL(areaLink.href).searchParams.get('query');
    expect(dirDestination).toBe('東京都千代田区丸の内1-9-1');
    expect(areaQuery).toBe('東京都千代田区丸の内1-9-1');
    expect(dirDestination).toBe(areaQuery);
    sandboxView.unmount();

    // 2. 対面診察モード: 即答フレーズの横スワイプUI ＆ 再診時刻未指定時の終日予定URL（勝手な 10:00 補完なし）
    render(<FaceToFaceConsultPage />);
    fireEvent.click(screen.getByTestId('consult-setup-next-button'));
    fireEvent.click(screen.getByTestId('start-consult-button'));

    await waitFor(() => {
      expect(screen.getByTestId('consult-quick-phrases-scroll-container')).toBeTruthy();
    });
    const consultScroll = screen.getByTestId('consult-quick-phrases-scroll-container');
    expect(consultScroll.className).toContain('overflow-x-auto');
    expect(consultScroll.className).toContain('touch-pan-x');
    expect(consultScroll.className).toContain('scroll-smooth');
    expect(screen.getByTestId('consult-quick-phrases-right-fade')).toBeTruthy();
    fireEvent.click(screen.getByTestId('consult-quick-phrases-scroll-right'));

    fireEvent.click(screen.getByTestId('end-consult-bar-button'));

    await waitFor(() => {
      expect(screen.getByTestId('consultation-summary-card')).toBeTruthy();
    });

    // 時刻言及なし時は開始時刻が空欄のままで、終日予定（All-Day Event: 20261126/20261127）として Google Calendar URL が生成されること
    const timeInput = screen.getByLabelText('開始時刻') as HTMLInputElement;
    expect(timeInput.value).toBe('');
    expect(screen.getByTestId('followup-allday-hint')).toBeTruthy();

    const calLink = screen.getByTestId('followup-calendar-link') as HTMLAnchorElement;
    expect(new URL(calLink.href).searchParams.get('dates')).toBe('20261126/20261127');
    expect(calLink.href).not.toContain('T100000');

    // ユーザーが後から時刻（例: 14:30）を入力した場合は時刻付きURLへ切り替わること
    fireEvent.change(timeInput, { target: { value: '14:30' } });
    expect(new URL(calLink.href).searchParams.get('dates')).toBe(
      '20261126T143000/20261126T153000',
    );
  });

  it('第7フェーズ検証①：通話中（SandboxCallView）の音声入力ボタン（非対応案内 ＆ Web Speech API 認識入力）と未確定登録文の自動追加が動作する', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/care/tts')) {
        return new Response(JSON.stringify({ available: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/clinic-search')) {
        return new Response(
          JSON.stringify({
            organizedSymptoms: '発熱・咽頭痛',
            organizedSymptomsEn: 'Fever and sore throat',
            recommendedDepartments: ['内科'],
            urgencyNote: '',
            suggestedIntent: '初診予約をお願いします',
            clinics: [SANDBOX_CLINIC],
            ai: { source: 'fallback', reason: 'not_configured' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string };
      if (url.includes('/api/sandbox-reception') && body.action !== 'summary') {
        return new Response(
          JSON.stringify({
            receptionistJa: 'お電話ありがとうございます。ご希望の日時はございますか？',
            receptionistEn: 'Thank you for calling. When would you like to come in?',
            isReservationConfirmed: false,
            suggestions: [
              { text: '明日の午前でお願いします', displayText: '明日の午前でお願いします', tag: '明日午前' },
              { text: '今日の午後でお願いします', displayText: '今日の午後でお願いします', tag: '今日午後' },
              { text: 'いつでも大丈夫です', displayText: 'いつでも大丈夫です', tag: '随時' },
            ],
            ai: { source: 'fallback', reason: 'not_configured' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ available: false }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Step 1 -> Step 2 -> Step 3 で確定ボタンを押さずに登録文を入力したまま「通話開始」を押す
    const homeView = render(<EchoBridgeCareHomePage />);
    fireEvent.click(screen.getByTestId('hub-card-booking'));
    fireEvent.click(screen.getByTestId('clinic-fill-example-button'));
    fireEvent.click(screen.getByTestId('wizard-step1-next'));

    await waitFor(() => {
      expect(screen.getByTestId('select-sandbox-clinic-button')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('select-sandbox-clinic-button'));

    // 目立つ確定ボタンが表示されていること、かつ確定ボタンを押さずに「通話開始」しても未確定ドラフトが自動保存されること
    expect(screen.getByTestId('confirm-add-custom-phrase-button').textContent).toContain(
      '[✅ 登録文を確定してリストに追加]',
    );
    fireEvent.change(screen.getByLabelText('新しい文を登録'), {
      target: { value: '保険証と医療証を持参します。' },
    });
    fireEvent.click(screen.getByTestId('wizard-step3-start-call'));

    await waitFor(() => {
      expect(screen.getByTestId('sandbox-toggle-saved-phrases-button').textContent).toContain(
        '📌 登録文（2件）',
      );
    });
    fireEvent.click(screen.getByTestId('sandbox-toggle-saved-phrases-button'));
    expect(screen.getByTestId('sandbox-saved-phrases-panel').textContent).toContain(
      DEFAULT_CARE_CUSTOM_PHRASE_TEXT.ja,
    );
    expect(screen.getByTestId('sandbox-saved-phrases-panel').textContent).toContain(
      '保険証と医療証を持参します。',
    );

    // 1. SpeechRecognition 非対応環境では音声入力ボタンを押すと案内バナーが表示されること
    const micBtn = screen.getByTestId('sandbox-voice-input-button');
    fireEvent.click(micBtn);
    expect(screen.getByTestId('sandbox-voice-unsupported-notice')).toBeTruthy();

    // 2. SpeechRecognition 対応環境（モック）では音声認識結果が自由入力欄へ反映されること
    resetCareSpeechCache();
    class FakeSpeechRecognition {
      lang = 'ja-JP';
      interimResults = true;
      continuous = false;
      onresult: ((ev: unknown) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        this.onresult?.({
          resultIndex: 0,
          results: [
            {
              0: { transcript: '明日の午前11時にお願いします' },
              isFinal: true,
              length: 1,
            },
          ],
        });
        this.onend?.();
      }
      stop() {
        this.onend?.();
      }
    }
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition =
      FakeSpeechRecognition;

    fireEvent.click(micBtn);
    const freeInput = document.getElementById('sandbox-free-input') as HTMLInputElement;
    expect(freeInput.value).toContain('明日の午前11時にお願いします');

    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    homeView.unmount();
  });

  it('第7フェーズ検証②：診察中の「✨ AI整形」と「📤 医師へ表示」の分離・再診カレンダーの医療機関住所反映・診察後トップ復帰時のステート完全リセットが動作する', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/care/tts')) {
        return new Response(JSON.stringify({ available: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/polish-draft')) {
        return new Response(
          JSON.stringify({
            polishedText: '昨夜から咽頭痛と38度の発熱がございます。',
            ai: { source: 'fallback', reason: 'not_configured' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string };
      if (body.action === 'simulate_doctor') {
        return new Response(
          JSON.stringify({
            doctorJa: '本日はどのような症状でしょうか？',
            doctorEn: 'What brings you in today?',
            suggestions: [
              { text: '喉が痛いです。', displayText: '喉が痛いです。', tag: '喉の痛み' },
              { text: '熱があります。', displayText: '熱があります。', tag: '発熱' },
              { text: '咳が出ます。', displayText: '咳が出ます。', tag: '咳' },
            ],
            ai: { source: 'fallback', reason: 'not_configured' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          chiefComplaint: '咽頭痛および発熱',
          chiefComplaintEn: 'Sore throat and fever',
          diagnosticPoints: ['所見：軽度の咽頭発赤あり'],
          diagnosticPointsEn: ['Finding: Mild throat redness'],
          prescriptionsAndInstructions: ['処方：解熱鎮痛薬（5日分）', '次回受診：2週間後に再受診'],
          prescriptionsAndInstructionsEn: ['Rx: Analgesic (5 days)', 'Follow-up: Return in 2 weeks'],
          followUp: {
            spokenText: '2週間後の午前10時に再受診',
            recommendedDate: '2026-11-26',
            recommendedStartTime: '10:00',
            title: '再診予定（EchoBridge Care 模擬クリニック）',
            details: '主訴: 咽頭痛および発熱',
          },
          ai: { source: 'fallback', reason: 'not_configured' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    // Next.js 16 のルートキャッシュ（<Activity>）を模して Home と Consult の両方をマウント保持
    render(
      <>
        <EchoBridgeCareHomePage />
        <FaceToFaceConsultPage />
      </>,
    );

    fireEvent.click(screen.getByTestId('consult-setup-next-button'));

    // 準備 Step 2 でも未確定の登録文を入力したまま「診察開始」を押すと自動登録されること
    fireEvent.change(screen.getByLabelText('新しい文を登録'), {
      target: { value: 'ペニシリン系で発疹が出たことがあります。' },
    });
    fireEvent.click(screen.getByTestId('start-consult-button'));

    await waitFor(() => {
      expect(screen.getByTestId('consult-step-2')).toBeTruthy();
    });
    expect(screen.getByTestId('consult-toggle-saved-phrases-button').textContent).toContain(
      '📌 登録文（2件）',
    );

    // 診察中下部バー：「✨ AI整形」と「📤 医師へ表示」が独立した2ボタンになっていること
    const polishBtn = screen.getByTestId('consult-active-polish-button') as HTMLButtonElement;
    const sendBtn = screen.getByTestId('consult-send-to-doctor-button') as HTMLButtonElement;
    expect(polishBtn.disabled).toBe(true);
    expect(sendBtn.disabled).toBe(true);

    const activeInput = screen.getByLabelText('医師に伝える内容') as HTMLInputElement;
    fireEvent.change(activeInput, { target: { value: 'きのうからのどが痛くて38度ある' } });
    expect(polishBtn.disabled).toBe(false);
    expect(sendBtn.disabled).toBe(false);

    // [✨ AI整形] を押すと、まだ医師側には送信されず入力欄のテキストだけが丁寧な医療表現へ書き換わること
    fireEvent.click(polishBtn);
    await waitFor(() => {
      expect(activeInput.value).toBe('昨夜から咽頭痛と38度の発熱がございます。');
    });
    expect(screen.queryByTestId('doctor-patient-message')).toBeNull();

    // 整形後の文面をユーザーが微調整してから [📤 医師へ表示] を押すと、微調整後の文面がそのまま医師側180度画面に表示されること
    fireEvent.change(activeInput, {
      target: { value: '昨夜から咽頭痛と38度の発熱がございます。市販薬はまだ飲んでいません。' },
    });
    fireEvent.click(sendBtn);

    await waitFor(() => {
      expect(screen.getByTestId('doctor-patient-message').textContent).toBe(
        '昨夜から咽頭痛と38度の発熱がございます。市販薬はまだ飲んでいません。',
      );
    });
    expect(activeInput.value).toBe('');

    // 診察終了 -> サマリー画面へ
    fireEvent.click(screen.getByTestId('end-consult-bar-button'));
    await waitFor(() => {
      expect(screen.getByTestId('consult-step-3')).toBeTruthy();
    });

    // 再診 Google Calendar フォームに医療機関の住所欄があり、URL の location パラメータに病院名＋住所が含まれること
    const addressInput = screen.getByTestId('followup-clinic-address-input') as HTMLInputElement;
    expect(addressInput.value).toBe(SANDBOX_CLINIC.address);

    const calLink = screen.getByTestId('followup-calendar-link') as HTMLAnchorElement;
    expect(new URL(calLink.href).searchParams.get('location')).toContain(SANDBOX_CLINIC.address);

    fireEvent.change(addressInput, { target: { value: '東京都新宿区西新宿2-8-1' } });
    expect(new URL(calLink.href).searchParams.get('location')).toContain('東京都新宿区西新宿2-8-1');

    // ステート残留バグ検証：「トップへ戻る」を押すと、アンマウントされずキャッシュ保持されたままでも即座に準備 Step 1/2 へ完全リセットされること！
    fireEvent.click(screen.getByTestId('consult-back-to-top-link'));
    await waitFor(() => {
      expect(screen.queryByTestId('consult-step-3')).toBeNull();
      expect(screen.getByTestId('consult-setup-step-1')).toBeTruthy();
      expect(screen.getByTestId('consult-step-indicator').textContent).toBe('準備 Step 1/2');
    });

    // さらにトップハブの「🩺 診察室で使う」カード押下でも確実に初期状態（準備 Step 1/2）になること
    fireEvent.click(screen.getByTestId('consult-setup-next-button'));
    expect(screen.getByTestId('consult-setup-step-2')).toBeTruthy();
    fireEvent.click(screen.getByTestId('hub-card-consult'));
    await waitFor(() => {
      expect(screen.getByTestId('consult-setup-step-1')).toBeTruthy();
    });
  });

  it('第7フェーズ検証③：トップハブ画面下部の「📋 過去の予約・受診記録」セクションから履歴確認・再予約引き継ぎ・対面診察引き継ぎが動作する', async () => {
    saveReservationRecord({
      id: 'res-hist-1',
      createdAt: '2026-11-12T09:00:00.000Z',
      clinicName: '新宿駅前クリニック',
      departmentLabel: '内科',
      address: '東京都新宿区新宿3-38-1',
      originLocation: '新宿駅',
      date: '2026-11-14',
      startTime: '10:30',
      symptomsMemo: '3日前からの咳と微熱',
      userLanguage: 'ja',
    });
    saveConsultationRecord({
      id: 'con-hist-1',
      createdAt: '2026-11-13T02:00:00.000Z',
      clinicName: '丸の内総合内科',
      clinicAddress: '東京都千代田区丸の内1-9-1',
      userLanguage: 'ja',
      turns: [],
      summary: {
        chiefComplaint: '昨夜からの咽頭痛と38度の発熱',
        chiefComplaintEn: 'Sore throat and 38C fever since last night',
        diagnosticPoints: ['所見：咽頭の発赤あり', '既往・アレルギー：特記事項なし'],
        prescriptionsAndInstructions: ['処方：解熱鎮痛薬（5日分）', '療養指示：安静と水分補給'],
        followUp: {
          spokenText: '2週間後に再受診',
          recommendedDate: '2026-11-27',
          recommendedStartTime: '10:00',
          title: '再診予定（丸の内総合内科）',
          details: '主訴: 昨夜からの咽頭痛と38度の発熱',
        },
        ai: { source: 'fallback', reason: 'not_configured' },
      },
    });

    render(
      <>
        <EchoBridgeCareHomePage />
        <FaceToFaceConsultPage />
      </>,
    );

    const historySection = screen.getByTestId('hub-history-section');
    expect(historySection).toBeTruthy();
    expect(screen.getByTestId('hub-history-counts').textContent).toBe('予約 1件・受診 1件');
    expect(screen.getByTestId('hub-history-latest-preview').textContent).toContain(
      '丸の内総合内科',
    );
    expect(screen.queryByTestId('hub-history-list-panel')).toBeNull();

    // クリックで履歴一覧パネルを展開し、構造化要約（所見・処方）を確認
    fireEvent.click(screen.getByTestId('hub-history-toggle-button'));
    const listPanel = screen.getByTestId('hub-history-list-panel');
    expect(listPanel.textContent).toContain('所見：咽頭の発赤あり');
    expect(listPanel.textContent).toContain('処方：解熱鎮痛薬（5日分）');
    expect(listPanel.textContent).toContain('新宿駅前クリニック');

    // 1. 受診履歴から「対面診察へ」を押すと、対面診察モードが準備 Step 2/2（病院名・主訴セット済み）へ引き継がれること
    fireEvent.click(screen.getByTestId('history-handoff-consult-con-hist-1'));
    await waitFor(() => {
      expect(screen.getByTestId('consult-setup-step-2')).toBeTruthy();
      expect(
        (screen.getByLabelText('最初に医師へ見せる主訴メモ（任意）') as HTMLTextAreaElement).value,
      ).toBe('昨夜からの咽頭痛と38度の発熱');
    });

    // 2. 予約履歴から「再予約へ」を押すと、電話予約ウィザード Step 1 に症状・出発地が自動引き継ぎされること
    fireEvent.click(screen.getByTestId('history-rebook-reservation-res-hist-1'));
    await waitFor(() => {
      expect(screen.getByTestId('wizard-step-1')).toBeTruthy();
      expect(
        (screen.getByLabelText('1. 主訴・具体的な要件') as HTMLTextAreaElement).value,
      ).toBe('3日前からの咳と微熱');
      expect((screen.getByTestId('wizard-origin-input') as HTMLInputElement).value).toBe('新宿駅');
    });
  });

  it('最終ピンポイント修正検証：英語UIを含む自由入力欄の2段ワイド化（上段w-full入力＋下段3ボタン）と、初回localStorage未設定時のデフォルト登録文1件プリセット（削除時は0件尊重）が動作する', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/care/tts')) {
        return new Response(JSON.stringify({ available: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/polish-draft')) {
        return new Response(
          JSON.stringify({
            polishedText: 'I would like to book an appointment for tomorrow morning at 10:30 AM.',
            ai: { source: 'fallback', reason: 'not_configured' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string };
      if (url.includes('/api/sandbox-reception') && body.action === 'polish') {
        return new Response(
          JSON.stringify({
            japaneseMedicalText: '明日の午前10時30分で予約をお願いいたします。',
            englishText: 'I would like to book an appointment for tomorrow morning at 10:30 AM.',
            ai: { source: 'fallback', reason: 'not_configured' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/sandbox-reception')) {
        return new Response(
          JSON.stringify({
            receptionistJa: 'お電話ありがとうございます。ご希望の日時はございますか？',
            receptionistEn: 'Thank you for calling. When would you like to come in?',
            isReservationConfirmed: false,
            suggestions: [],
            ai: { source: 'fallback', reason: 'not_configured' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (body.action === 'simulate_doctor') {
        return new Response(
          JSON.stringify({
            doctorJa: '本日はどのような症状でしょうか？',
            doctorEn: 'What brings you in today?',
            suggestions: [],
            ai: { source: 'fallback', reason: 'not_configured' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ available: false }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    // 1. 初回アクセス（localStorage === null）時：日本語デフォルト登録文1件がプリセットされていること
    expect(window.localStorage.getItem('echobridge.customPhrases.v1')).toBeNull();
    const consultView = render(<FaceToFaceConsultPage />);

    // 準備 Step 1 -> 準備 Step 2 で既に1件プリセットされていること
    fireEvent.click(screen.getByTestId('consult-setup-next-button'));
    expect(screen.getByText(DEFAULT_CARE_CUSTOM_PHRASE_TEXT.ja)).toBeTruthy();

    // 診察開始すると最初から「📌 登録文（1件）」が利用できること
    fireEvent.click(screen.getByTestId('start-consult-button'));
    await waitFor(() => {
      expect(screen.getByTestId('consult-step-2')).toBeTruthy();
    });
    expect(screen.getByTestId('consult-toggle-saved-phrases-button').textContent).toContain(
      '📌 登録文（1件）',
    );
    consultView.unmount();

    // 2. 英語UIに切り替え：英語デフォルト登録文1件がプリセットされ、診察中・通話中の両方で「上段w-full入力欄 ＋ 下段3ボタン」の2段ワイドレイアウトになっていること
    saveUserLanguage('en');

    const enConsultView = render(<FaceToFaceConsultPage />);
    fireEvent.click(screen.getByTestId('consult-setup-next-button'));
    expect(screen.getByText(DEFAULT_CARE_CUSTOM_PHRASE_TEXT.en)).toBeTruthy();

    fireEvent.click(screen.getByTestId('start-consult-button'));
    await waitFor(() => {
      expect(screen.getByTestId('consult-step-2')).toBeTruthy();
    });
    expect(screen.getByTestId('consult-toggle-saved-phrases-button').textContent).toContain(
      '📌 Saved Phrases (1)',
    );

    const consultInputContainer = screen.getByTestId('consult-active-input-container');
    const consultInput = screen.getByLabelText('Message for the doctor') as HTMLInputElement;
    const consultActionRow = screen.getByTestId('consult-active-action-row');
    expect(consultInput.className).toContain('w-full');
    expect(consultInputContainer.firstElementChild).toBe(consultInput);
    expect(consultInputContainer.lastElementChild).toBe(consultActionRow);
    expect(consultActionRow.children).toHaveLength(3);
    expect(consultActionRow.children[0]?.textContent).toContain('🎤 Voice');
    expect(consultActionRow.children[1]?.textContent).toContain('✨ AI Polish');
    expect(consultActionRow.children[2]?.textContent).toContain('📤 Show to Doctor');

    // ユーザーが準備画面に戻ってプリセット登録文を削除（個別「削除」または「すべて削除」）した場合は 0件 が維持され復活しないこと
    enConsultView.unmount();
    saveUserLanguage('ja');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const deleteTestView = render(<FaceToFaceConsultPage />);
    fireEvent.click(screen.getByTestId('consult-setup-next-button'));
    fireEvent.click(screen.getByRole('button', { name: 'すべて削除' }));
    expect(window.localStorage.getItem('echobridge.customPhrases.v1')).toBe('[]');

    fireEvent.click(screen.getByTestId('start-consult-button'));
    await waitFor(() => {
      expect(screen.getByTestId('consult-step-2')).toBeTruthy();
    });
    expect(screen.getByTestId('consult-toggle-saved-phrases-button').textContent).toContain(
      '📌 登録文（0件）',
    );
    deleteTestView.unmount();

    // 3. 通話画面（SandboxCallView）でも英語UI時に2段ワイドレイアウト（上段w-full入力欄 ＋ 下段 [🎤 Voice, ✨ AI Polish, 📤 Send]）とAI整形編集→送信が動作すること
    clearCustomPhrases();
    saveUserLanguage('en');

    render(
      <SandboxCallView
        intent="First visit request"
        voice="female"
        clinic={SANDBOX_CLINIC}
        onExit={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/When would you like to come in/)).toBeTruthy();
    });

    expect(screen.getByTestId('sandbox-toggle-saved-phrases-button').textContent).toContain(
      '📌 Saved Phrases (1)',
    );

    const sandboxContainer = screen.getByTestId('sandbox-active-input-container');
    const sandboxInput = document.getElementById('sandbox-free-input') as HTMLInputElement;
    const sandboxActionRow = screen.getByTestId('sandbox-active-action-row');
    expect(sandboxInput.className).toContain('w-full');
    expect(sandboxContainer.firstElementChild).toBe(sandboxInput);
    expect(sandboxContainer.lastElementChild).toBe(sandboxActionRow);
    expect(sandboxActionRow.children).toHaveLength(3);
    expect(sandboxActionRow.children[0]?.textContent).toContain('🎤 Voice');
    expect(sandboxActionRow.children[1]?.textContent).toContain('✨ AI Polish');
    expect(sandboxActionRow.children[2]?.textContent).toContain('📤 Send');

    fireEvent.change(sandboxInput, { target: { value: 'tomorrow 10:30 am please' } });
    fireEvent.click(screen.getByTestId('sandbox-active-polish-button'));
    await waitFor(() => {
      expect(sandboxInput.value).toBe(
        'I would like to book an appointment for tomorrow morning at 10:30 AM.',
      );
    });

    fireEvent.click(screen.getByTestId('sandbox-send-button'));
    await waitFor(() => {
      expect(screen.getByText('明日の午前10時30分で予約をお願いいたします。')).toBeTruthy();
    });
  });
});

