// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PatientApp from '@/app/page';
import type { AiMeta } from '@/lib/aiMeta';
import { CLOSE_CODE_IDLE, buildGreeting } from '@/lib/callProtocol';
import type { AppointmentDraft, ServerMessage } from '@/lib/callProtocol';
import { clearCustomPhrases } from '@/lib/customPhrases';
import { SEAT_TOKEN, callJoined } from '../helpers/callMessages';
import { FakeWebSocket } from '../helpers/fakeWebSocket';

const GEMINI: AiMeta = { source: 'gemini', model: 'test-model' };
const INVITE = { code: 'ABCDE12345', expiresAt: Date.UTC(2026, 10, 7, 6, 30) };

function socket() {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

function receive(message: ServerMessage) {
  act(() => socket().receive(message));
}

function renderConnectedCall() {
  render(<PatientApp />);
  act(() => socket().open());
  receive(callJoined('patient', { phase: 'ringing', invite: INVITE, peerConnected: true }));
  receive({ type: 'answer_call', text: 'お電話しております。', seq: 1 });
}

const confirmedSpeech = () => socket().sentOfType('patient_confirmed_speech');
const sendTypedButton = () => screen.getByRole('button', { name: 'そのまま送る' });
const input = () => screen.getByRole('textbox', { name: '相手に伝える文' }) as HTMLInputElement;

function typeMessage(text: string) {
  fireEvent.change(input(), { target: { value: text } });
}

function requestPolish(text: string) {
  typeMessage(text);
  fireEvent.click(screen.getByRole('button', { name: 'AIで整える' }));
  return String(socket().sentOfType('patient_polish_request').at(-1)?.requestId);
}

function polishResult(
  requestId: string,
  original: string,
  polished: string | null,
  ai: AiMeta = GEMINI,
) {
  receive({ type: 'patient_polish_result', requestId, original, polished, ai });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('発信前の確認', () => {
  it('読み上げる文を発信前に表示し、サーバーと同じ文にする', () => {
    render(<PatientApp />);
    act(() => socket().open());

    fireEvent.change(screen.getByPlaceholderText('例：内科の初診予約をしたいです'), {
      target: { value: '内科の初診予約をしたいです' },
    });

    expect(screen.getByTestId('greeting-preview').textContent).toBe(
      buildGreeting('内科の初診予約をしたいです'),
    );
  });

  it('入力の前に、実在の個人情報を使わないよう伝え、処理する先を示す', () => {
    render(<PatientApp />);
    act(() => socket().open());

    const notice = screen.getByTestId('demo-data-notice');
    expect(notice.textContent).toContain('実在の個人情報は入力しないでください');
    expect(notice.textContent).toContain('架空の内容');
    expect(notice.textContent).toContain('Google Cloud（Speech-to-Text、Gemini）');
  });
});

describe('AIの整形案の確認', () => {
  it('AIの案が届いても、本人が押すまで送らない', () => {
    renderConnectedCall();

    const requestId = requestPolish('あした行けます');
    expect(confirmedSpeech()).toEqual([]);

    polishResult(requestId, 'あした行けます', '明日伺うことができます。');

    expect(screen.getByLabelText(/AIの案/)).toHaveProperty('value', '明日伺うことができます。');
    expect(screen.getByTestId('polish-original').textContent).toBe('あした行けます');
    expect(screen.getByText('まだ相手には届いていません。')).toBeTruthy();
    expect(confirmedSpeech()).toEqual([]);
  });

  it('確認した案を表示どおりに送る', () => {
    renderConnectedCall();
    const requestId = requestPolish('あした行けます');
    polishResult(requestId, 'あした行けます', '明日伺うことができます。');

    fireEvent.click(screen.getByRole('button', { name: 'この文を送る' }));

    expect(confirmedSpeech()).toEqual([
      {
        type: 'patient_confirmed_speech',
        text: '明日伺うことができます。',
        origin: 'ai_reviewed',
      },
    ]);
    expect(screen.queryByRole('region', { name: '送信前の確認' })).toBeNull();
    expect(input().value).toBe('');
  });

  it('本人が直した文を、直したとおりに送る', () => {
    renderConnectedCall();
    const requestId = requestPolish('あした行けます');
    polishResult(requestId, 'あした行けます', '明日伺うことができます。');

    fireEvent.change(screen.getByLabelText(/AIの案/), { target: { value: '明後日伺います。' } });
    fireEvent.click(screen.getByRole('button', { name: 'この文を送る' }));

    expect(confirmedSpeech()).toEqual([
      { type: 'patient_confirmed_speech', text: '明後日伺います。', origin: 'ai_edited' },
    ]);
  });

  it('確認画面から原文を送れる', () => {
    renderConnectedCall();
    const requestId = requestPolish('いいえ');
    polishResult(requestId, 'いいえ', 'いいえ、都合が合いません。');

    fireEvent.click(screen.getByRole('button', { name: '入力した文をそのまま送る' }));

    expect(confirmedSpeech()).toEqual([
      { type: 'patient_confirmed_speech', text: 'いいえ', origin: 'typed' },
    ]);
  });

  it('送らずに戻ると、入力を残して何も送らない', () => {
    renderConnectedCall();
    const requestId = requestPolish('あした行けます');
    polishResult(requestId, 'あした行けます', '明日伺うことができます。');

    fireEvent.click(screen.getByRole('button', { name: '送らずに入力へ戻る' }));

    expect(confirmedSpeech()).toEqual([]);
    expect(input().value).toBe('あした行けます');
  });

  it('案を空にすると送れない', () => {
    renderConnectedCall();
    const requestId = requestPolish('あした行けます');
    polishResult(requestId, 'あした行けます', '明日伺います。');

    fireEvent.change(screen.getByLabelText(/AIの案/), { target: { value: '  ' } });

    expect(screen.getByRole('button', { name: 'この文を送る' })).toHaveProperty('disabled', true);
  });

  it('数字が変わった案には警告を出す', () => {
    renderConnectedCall();
    const requestId = requestPolish('3時に行きます');
    polishResult(requestId, '3時に行きます', '13時に伺います。');

    expect(screen.getByRole('alert').textContent).toContain('数字が原文と違います');
  });

  it('AIが失敗したら理由を示し、原文だけを送れる', () => {
    renderConnectedCall();
    const requestId = requestPolish('いいえ');
    polishResult(requestId, 'いいえ', null, { source: 'fallback', reason: 'timeout' });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('AIで整えられませんでした');
    expect(alert.textContent).toContain('AIの応答が時間内に返りませんでした');
    expect(screen.queryByRole('button', { name: 'この文を送る' })).toBeNull();
    expect(confirmedSpeech()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: '入力した文をそのまま送る' }));

    expect(confirmedSpeech()).toEqual([
      { type: 'patient_confirmed_speech', text: 'いいえ', origin: 'typed' },
    ]);
  });

  it('待っている間に接続が切れたら、失敗を示す', () => {
    renderConnectedCall();
    requestPolish('いいえ');

    act(() => socket().drop());

    expect(screen.getByRole('alert').textContent).toContain('AIに接続できませんでした');
  });

  it('リセット後に届いた結果を表示しない', () => {
    renderConnectedCall();
    const requestId = requestPolish('いいえ');

    receive({ type: 'call_closed', reason: 'abandoned' });
    receive(callJoined('patient', { turns: [{ seq: 1, sender: '患者', text: 'お電話しております。' }] }));
    polishResult(requestId, 'いいえ', '別の文');

    expect(screen.queryByLabelText(/AIの案/)).toBeNull();
  });

  it('作成中にやめると、入力を残して後から届いた結果を無視する', () => {
    renderConnectedCall();
    const requestId = requestPolish('いいえ');

    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    polishResult(requestId, 'いいえ', '別の文');

    expect(screen.queryByLabelText(/AIの案/)).toBeNull();
    expect(input().value).toBe('いいえ');
    expect(input()).toHaveProperty('disabled', false);
    expect(confirmedSpeech()).toEqual([]);
  });

  it('作成中に候補で返答したら、後から届いた案で確認画面を開かない', () => {
    renderConnectedCall();
    receive({
      type: 'suggestions',
      suggestions: [{ text: 'はい、お願いいたします。', tag: '承諾' }],
      ai: GEMINI,
    });
    const requestId = requestPolish('いいえ');

    fireEvent.click(screen.getByRole('button', { name: /はい、お願いいたします。/ }));
    polishResult(requestId, 'いいえ', '別の文');

    expect(screen.queryByLabelText(/AIの案/)).toBeNull();
    expect(confirmedSpeech()).toHaveLength(1);
  });

  it('相手の発話中は確認画面からも送れない', () => {
    renderConnectedCall();
    const requestId = requestPolish('いいえ');
    polishResult(requestId, 'いいえ', 'いいえ、ございません。');

    receive({ type: 'hospital_speaking_start' });

    expect(screen.getByRole('button', { name: 'この文を送る' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '入力した文をそのまま送る' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('手入力', () => {
  it('「そのまま送る」は入力どおりの文を1回だけ送る', () => {
    renderConnectedCall();
    typeMessage('はい？ もう一度お願いします');

    fireEvent.click(screen.getByRole('button', { name: 'そのまま送る' }));

    expect(confirmedSpeech()).toEqual([
      { type: 'patient_confirmed_speech', text: 'はい？ もう一度お願いします', origin: 'typed' },
    ]);
    expect(socket().sentOfType('patient_polish_request')).toEqual([]);
  });

  it('Enterは案を作るだけで、相手には何も送らない', () => {
    renderConnectedCall();
    typeMessage('あした行けます');

    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(socket().sentOfType('patient_polish_request')).toHaveLength(1);
    expect(confirmedSpeech()).toEqual([]);
  });

  it.each([
    ['変換中のEnter', { key: 'Enter', isComposing: true }],
    ['確定直後のEnter', { key: 'Enter', keyCode: 229 }],
  ])('%sには反応しない', (_, init) => {
    renderConnectedCall();
    typeMessage('あした');

    fireEvent.keyDown(input(), init);

    expect(socket().sentOfType('patient_polish_request')).toEqual([]);
    expect(confirmedSpeech()).toEqual([]);
  });

  it('接続が切れていたら送信したふりをせず、入力を残す', () => {
    renderConnectedCall();
    typeMessage('はい');

    act(() => {
      socket().readyState = FakeWebSocket.CLOSED;
    });
    fireEvent.click(screen.getByRole('button', { name: 'そのまま送る' }));

    expect(screen.getByRole('alert').textContent).toContain('送信できませんでした');
    expect(input().value).toBe('はい');
  });
});

describe('3択の返答候補', () => {
  const suggestions = [
    { text: 'はい、お願いいたします。', tag: '承諾' },
    { text: '別の日時でお願いできますか。', tag: '別日程' },
    { text: '持ち物はありますか。', tag: '確認' },
  ];

  it('タップすると表示どおりの文を送る', () => {
    renderConnectedCall();
    receive({ type: 'suggestions', suggestions, ai: GEMINI });

    fireEvent.click(screen.getByRole('button', { name: /別の日時でお願いできますか。/ }));

    expect(confirmedSpeech()).toEqual([
      {
        type: 'patient_confirmed_speech',
        text: '別の日時でお願いできますか。',
        origin: 'suggestion',
      },
    ]);
  });

  it('AIの候補には定型文の表示を出さない', () => {
    renderConnectedCall();
    receive({ type: 'suggestions', suggestions, ai: GEMINI });

    expect(screen.getByText(/AIの返答候補/)).toBeTruthy();
    expect(screen.queryByText(/定型文の候補です/)).toBeNull();
  });

  it('定型文はAIの回答ではないと明示し、経路も区別する', () => {
    renderConnectedCall();
    receive({
      type: 'suggestions',
      suggestions,
      ai: { source: 'fallback', reason: 'not_configured' },
    });

    expect(screen.getByRole('status').textContent).toContain('AIの回答ではありません');
    expect(screen.getByRole('status').textContent).toContain('AIが未設定です');
    expect(screen.queryByText(/AIの返答候補/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /持ち物はありますか。/ }));

    expect(confirmedSpeech()[0]).toMatchObject({ origin: 'fallback_suggestion' });
  });

  it('送信後は候補を片付ける', () => {
    renderConnectedCall();
    receive({ type: 'suggestions', suggestions, ai: GEMINI });

    fireEvent.click(screen.getByRole('button', { name: /はい、お願いいたします。/ }));

    expect(screen.queryByRole('button', { name: /持ち物はありますか。/ })).toBeNull();
  });
});

describe('AIの状態表示', () => {
  const badge = () => screen.getByTestId('ai-status').textContent;

  it('設定がなければ未接続と表示する', () => {
    render(<PatientApp />);
    act(() => socket().open());

    receive({ type: 'ai_status', configured: false, backend: null, model: null });

    expect(badge()).toBe('AI未接続');
  });

  it('設定があるだけではGeminiと表示しない', () => {
    render(<PatientApp />);
    act(() => socket().open());

    receive({ type: 'ai_status', configured: true, backend: 'vertex', model: 'test-model' });

    expect(badge()).toBe('AI未確認');
  });

  it('応答を受け取って初めてGeminiと表示し、失敗すると戻す', () => {
    renderConnectedCall();
    receive({ type: 'ai_status', configured: true, backend: 'vertex', model: 'test-model' });

    receive({ type: 'suggestions', suggestions: [], ai: GEMINI });
    expect(badge()).toBe('Gemini応答');

    receive({ type: 'suggestions', suggestions: [], ai: { source: 'fallback', reason: 'timeout' } });
    expect(badge()).toBe('AI未接続');
  });

  it('接続し直したら前の接続の結果を持ち越さない', () => {
    renderConnectedCall();
    receive({ type: 'suggestions', suggestions: [], ai: { source: 'fallback', reason: 'timeout' } });

    receive({ type: 'ai_status', configured: true, backend: 'vertex', model: 'test-model' });

    expect(badge()).toBe('AI未確認');
  });
});

describe('通話の接続', () => {
  it('入力中の通知が出ても接続を張り直さない', () => {
    vi.useFakeTimers();
    renderConnectedCall();

    receive({ type: 'transcript_final', text: 'アレルギーはありますか', seq: 2 });
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(socket().sentOfType('patient_typing_notice')).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('接続が切れたら張り直す', () => {
    vi.useFakeTimers();
    renderConnectedCall();

    act(() => socket().drop());
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('待機で閉じられたら自動ではつなぎ直さず、操作があったらつなぐ', () => {
    vi.useFakeTimers();
    render(<PatientApp />);
    act(() => socket().open());

    act(() => socket().drop(CLOSE_CODE_IDLE));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => {
      fireEvent.pointerDown(document.body);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('入力中の通知の間に送った文は、通知の後に表示する', () => {
    vi.useFakeTimers();
    renderConnectedCall();
    receive({ type: 'transcript_final', text: '質問です', seq: 2 });
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    receive({ type: 'patient_speech', text: '待たせました', origin: 'typed', seq: 3 });
    expect(screen.queryByText('待たせました')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(230 * 30);
    });

    expect(screen.getByText('待たせました')).toBeTruthy();
  });
});

describe('通話後の予定の確認', () => {
  const unknown: AppointmentDraft = {
    title: '内科の予約',
    date: null,
    startTime: null,
    endTime: null,
    location: 'ひまわり医院 (受付)',
    address: '',
    details: '',
  };

  // 過ぎた日時の判定があるので、今日を固定する。2026-11-09(月) 10:00 JST。タイマーは本物のまま。
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T01:00:00Z'));
  });

  function endCall(appointment: AppointmentDraft, ai: AiMeta) {
    renderConnectedCall();
    receive({ type: 'end_call', appointment, ai });
  }

  const calendarButton = () => screen.getByRole('button', { name: 'Google カレンダーに追加' });

  it('AIが失敗したら理由を示し、手で追加しても日時を埋めない', () => {
    endCall(unknown, { source: 'fallback', reason: 'not_configured' });

    expect(screen.getByRole('status').textContent).toContain('AIで予定を読み取れませんでした');
    expect(screen.getByRole('status').textContent).toContain('AIが未設定です');
    fireEvent.click(screen.getByRole('button', { name: '予定を手で追加' }));

    expect(screen.getByLabelText(/日付/)).toHaveProperty('value', '');
    expect(screen.getAllByText('要確認')).toHaveLength(2);
    expect(calendarButton()).toHaveProperty('disabled', true);
  });

  it('本人が日時を入れるとカレンダーへ進める', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    endCall(unknown, { source: 'fallback', reason: 'not_configured' });
    fireEvent.click(screen.getByRole('button', { name: '予定を手で追加' }));

    fireEvent.change(screen.getByLabelText(/日付/), { target: { value: '2026-11-12' } });
    fireEvent.change(screen.getByLabelText(/開始/), { target: { value: '14:30' } });
    expect(calendarButton()).toHaveProperty('disabled', false);

    fireEvent.click(calendarButton());

    const url = new URL(String(open.mock.calls[0][0]));
    expect(url.searchParams.get('dates')).toBe('20261112T143000/20261112T153000');
  });

  it('Geminiの読み取りは下書きとして表示し、本人が直せる', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    endCall({ ...unknown, date: '2026-11-12', startTime: '14:30' }, GEMINI);

    expect(screen.getByText(/Geminiが通話内容から読み取った下書きです/)).toBeTruthy();
    expect(screen.queryByText('要確認')).toBeNull();

    fireEvent.change(screen.getByLabelText(/開始/), { target: { value: '15:00' } });
    fireEvent.click(calendarButton());

    const url = new URL(String(open.mock.calls[0][0]));
    expect(url.searchParams.get('dates')).toBe('20261112T150000/20261112T160000');
  });

  it('場所はGoogleマップで確かめられ、本人が直した場所で検索し、カレンダーにも同じ場所を渡す', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    endCall({ ...unknown, date: '2026-11-12', startTime: '14:30', location: '駅前の改札' }, GEMINI);

    const mapsLink = () => screen.getByRole('link', { name: /Googleマップで/ }) as HTMLAnchorElement;
    expect(new URL(mapsLink().href).searchParams.get('query')).toBe('駅前の改札');
    expect(mapsLink().target).toBe('_blank');
    expect(mapsLink().rel).toContain('noopener');

    fireEvent.change(screen.getByLabelText(/場所/), { target: { value: '北口の改札' } });
    expect(new URL(mapsLink().href).searchParams.get('query')).toBe('北口の改札');

    fireEvent.click(calendarButton());
    expect(new URL(String(open.mock.calls[0][0])).searchParams.get('location')).toBe('北口の改札');
  });

  it('会話の日付と曜日が合わずAIが日付を空けたら、理由を見せ、本人が日付を入れるまで追加できない', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    endCall(
      {
        ...unknown,
        startTime: '14:30',
        aiFields: ['startTime'],
        spoken: { date: '11月12日（火）', time: '午後2時半' },
        issues: [{ field: 'date', code: 'weekday_mismatch', said: '11月12日（火）', value: '2026-11-12' }],
      },
      GEMINI,
    );

    // 日付の話はあったので、予定なしの画面にしない。
    expect(screen.queryByText('通話の中で、決まった予定は見つかりませんでした。')).toBeNull();
    expect(screen.getByText(/曜日が合いません/).textContent).toContain('11月12日（木）');
    expect(screen.getByText('会話での言い方：「11月12日（火）」')).toBeTruthy();
    expect(calendarButton()).toHaveProperty('disabled', true);
    expect(screen.getByText('日付を入れてください。')).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/日付/), { target: { value: '2026-11-17' } });

    // 本人が選んだ日付は止めないが、会話と違うことは知らせ続ける。
    expect(screen.queryByText(/曜日が合いません/)).toBeNull();
    expect(screen.getByText(/会話の「11月12日（火）」と合いません/).textContent).toContain('11月17日（火）');
    expect(calendarButton()).toHaveProperty('disabled', false);
    fireEvent.click(calendarButton());
    expect(new URL(String(open.mock.calls[0][0])).searchParams.get('dates')).toBe(
      '20261117T143000/20261117T153000',
    );
  });

  it('終了時刻が開始より前なら追加できず、カレンダーへ別の時刻を勝手に入れない', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    endCall({ ...unknown, date: '2026-11-12', startTime: '14:30' }, GEMINI);

    fireEvent.change(screen.getByLabelText(/終了/), { target: { value: '14:00' } });

    expect(calendarButton()).toHaveProperty('disabled', true);
    expect(screen.getAllByText('終了時刻を開始より後にするか、空欄にしてください。').length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/終了/).getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(calendarButton());
    expect(open).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/終了/), { target: { value: '' } });
    expect(calendarButton()).toHaveProperty('disabled', false);
  });

  it('過去の日付と、今日の過ぎた時刻は追加できない', () => {
    endCall({ ...unknown, date: '2026-11-12', startTime: '14:30' }, GEMINI);

    fireEvent.change(screen.getByLabelText(/日付/), { target: { value: '2026-11-08' } });
    expect(calendarButton()).toHaveProperty('disabled', true);
    expect(screen.getAllByText('11月8日（日）は今日より前の日付です。').length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText(/日付/), { target: { value: '2026-11-09' } });
    fireEvent.change(screen.getByLabelText(/開始/), { target: { value: '09:00' } });
    expect(calendarButton()).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText(/開始/), { target: { value: '11:00' } });
    expect(calendarButton()).toHaveProperty('disabled', false);
  });

  it('選んだ日付に曜日を添え、会話での言い方と見比べられる', () => {
    endCall(
      { ...unknown, date: '2026-11-10', startTime: '14:30', spoken: { date: '明日', time: '午後2時半' } },
      GEMINI,
    );

    expect(screen.getByText('11月10日（火）')).toBeTruthy();
    expect(screen.getByText('会話での言い方：「明日」')).toBeTruthy();
    expect(screen.getByText('会話での言い方：「午後2時半」')).toBeTruthy();
  });

  it('会話で話された住所は、地図の検索とカレンダーの場所に施設名と並べて使う', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    endCall(
      {
        ...unknown,
        date: '2026-11-12',
        startTime: '14:30',
        location: 'ひまわり医院',
        address: '本町2丁目3番4号',
        aiFields: ['date', 'startTime', 'location', 'address'],
      },
      GEMINI,
    );

    const mapsLink = () => screen.getByRole('link', { name: /Googleマップで/ }) as HTMLAnchorElement;
    expect(new URL(mapsLink().href).searchParams.get('query')).toBe('ひまわり医院 本町2丁目3番4号');
    expect(screen.getAllByText('AIの読み取り')).toHaveLength(4);

    fireEvent.change(screen.getByLabelText(/住所/), { target: { value: '本町2丁目3番5号' } });
    expect(new URL(mapsLink().href).searchParams.get('query')).toBe('ひまわり医院 本町2丁目3番5号');
    expect(screen.getAllByText('AIの読み取り')).toHaveLength(3);

    fireEvent.click(calendarButton());
    expect(new URL(String(open.mock.calls[0][0])).searchParams.get('location')).toBe(
      'ひまわり医院 本町2丁目3番5号',
    );
  });

  it('場所が空なら地図のリンクを出さない', () => {
    endCall({ ...unknown, date: '2026-11-12', startTime: '14:30', location: '' }, GEMINI);

    expect(screen.queryByRole('link', { name: /Googleマップで/ })).toBeNull();
  });

  it('予定の日のGoogleカレンダーを開ける。予定は読まない', () => {
    endCall({ ...unknown, date: '2026-11-12', startTime: '14:30' }, GEMINI);

    const link = screen.getByRole('link', { name: 'この日の予定をGoogleカレンダーで見る' }) as HTMLAnchorElement;
    expect(link.href).toBe('https://calendar.google.com/calendar/r/day/2026/11/12');
  });

  it('通話の記録を見返せる', () => {
    renderConnectedCall();
    receive({ type: 'transcript_final', text: '水曜の10時です', seq: 2 });
    receive({ type: 'end_call', appointment: unknown, ai: GEMINI });

    const details = screen.getByText('通話の記録を見る').closest('details');

    expect(within(details as HTMLElement).getByText(/水曜の10時です/)).toBeTruthy();
  });
});

describe('音声認識を使えないときの表示', () => {
  const notice = () => screen.queryByText('音声認識を利用できません。相手の発話を文字にできません。');

  it('発信前から本人に知らせる', () => {
    render(<PatientApp />);
    act(() => socket().open());

    receive({ type: 'speech_status', status: 'unavailable' });

    expect(notice()).toBeTruthy();
  });

  it('回復したら表示を消す', () => {
    render(<PatientApp />);
    act(() => socket().open());
    receive({ type: 'speech_status', status: 'unavailable' });

    receive({ type: 'speech_status', status: 'ready' });

    expect(notice()).toBeNull();
  });

  it('確認中は表示しない', () => {
    render(<PatientApp />);
    act(() => socket().open());

    receive({ type: 'speech_status', status: 'checking' });

    expect(notice()).toBeNull();
  });
});

describe('発信と招待', () => {
  const placeCall = () => {
    render(<PatientApp />);
    act(() => socket().open());
    fireEvent.change(screen.getByPlaceholderText('例：内科の初診予約をしたいです'), {
      target: { value: '内科の初診予約' },
    });
    fireEvent.click(screen.getByRole('button', { name: /発信する/ }));
  };

  it('発信すると用件を送り、席が決まるまで招待を出さない', () => {
    placeCall();

    expect(socket().sentOfType('start_call')).toEqual([
      { type: 'start_call', intent: '内科の初診予約', purpose: 'medical', partnerName: '' },
    ]);
    expect(screen.getByText('通話を準備しています...')).toBeTruthy();
    expect(screen.queryByTestId('invite-code')).toBeNull();
  });

  it('招待のコードとリンクを表示する。コードはクエリに載せない', () => {
    placeCall();

    receive(callJoined('patient', { phase: 'ringing', invite: INVITE, peerConnected: false }));

    expect(screen.getByTestId('invite-code').textContent).toBe('ABCDE-12345');
    const link = screen.getByLabelText('招待リンク') as HTMLInputElement;
    expect(link.value).toBe(`${window.location.origin}/join#invite=ABCDE12345`);
    expect(new URL(link.value).search).toBe('');
    expect(screen.getByText('相手の参加を待っています')).toBeTruthy();
  });

  it('病院役が画面を開いたら、応答待ちに変える', () => {
    placeCall();
    receive(callJoined('patient', { phase: 'ringing', invite: INVITE, peerConnected: false }));

    receive({ type: 'peer_status', connected: true });

    expect(screen.getByText('相手が応答するのを待っています')).toBeTruthy();
  });

  it('リンクをコピーできる', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    placeCall();
    receive(callJoined('patient', { phase: 'ringing', invite: INVITE }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'リンクをコピー' }));
    });

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/join#invite=ABCDE12345`);
    expect(screen.getByRole('button', { name: 'コピーしました' })).toBeTruthy();
  });

  it('コピーできなければ手でコピーするよう案内する', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    placeCall();
    receive(callJoined('patient', { phase: 'ringing', invite: INVITE }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'リンクをコピー' }));
    });

    expect(screen.getByRole('alert').textContent).toContain('コピーできませんでした');
  });

  it('発信を取り消すと通話を閉じ、席を忘れて最初の画面に戻る', () => {
    placeCall();
    receive(callJoined('patient', { phase: 'ringing', invite: INVITE }));

    fireEvent.click(screen.getByRole('button', { name: '発信を取り消す' }));

    expect(socket().sentOfType('reset_call')).toHaveLength(1);
    expect(screen.getByPlaceholderText('例：内科の初診予約をしたいです')).toBeTruthy();
    expect(window.sessionStorage.length).toBe(0);
  });

  it('混み合っていたら用件を残して最初の画面に戻す', () => {
    placeCall();

    receive({ type: 'call_error', code: 'server_busy' });

    expect(screen.getByTestId('call-notice').textContent).toContain('混み合っている');
    expect(
      (screen.getByPlaceholderText('例：内科の初診予約をしたいです') as HTMLTextAreaElement).value,
    ).toBe('内科の初診予約');
  });

  it('発信の返事の前に接続が切れたら、発信中のまま止まらない', () => {
    placeCall();

    act(() => socket().drop());

    expect(screen.getByPlaceholderText('例：内科の初診予約をしたいです')).toBeTruthy();
  });

  it('時間内に応答がなければ理由を出して戻す', () => {
    placeCall();
    receive(callJoined('patient', { phase: 'ringing', invite: INVITE }));

    receive({ type: 'call_closed', reason: 'invite_expired' });

    expect(screen.getByTestId('call-notice').textContent).toContain('時間内に応答がなかった');
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe('この通話のリセット', () => {
  it('通話中は確かめてからリセットし、やめれば通話を続ける', () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    renderConnectedCall();

    fireEvent.click(screen.getByRole('button', { name: 'この通話をリセット' }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(socket().sentOfType('reset_call')).toEqual([]);
    expect(input()).toBeTruthy();
  });

  it('発信中のリセットは確かめずに取り消す', () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    render(<PatientApp />);
    act(() => socket().open());
    receive(callJoined('patient', { phase: 'ringing', invite: INVITE, peerConnected: false }));

    fireEvent.click(screen.getByRole('button', { name: 'この通話をリセット' }));

    expect(confirm).not.toHaveBeenCalled();
    expect(socket().sentOfType('reset_call')).toHaveLength(1);
  });

  it('通話がないときはリセットを出さない', () => {
    render(<PatientApp />);
    act(() => socket().open());

    expect(screen.queryByRole('button', { name: 'この通話をリセット' })).toBeNull();
  });

  it('リセットしたら席を忘れ、切断しても前の通話に戻らない', () => {
    vi.useFakeTimers();
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderConnectedCall();

    fireEvent.click(screen.getByRole('button', { name: 'この通話をリセット' }));
    expect(socket().sentOfType('reset_call')).toHaveLength(1);

    act(() => socket().drop());
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    act(() => socket().open());

    expect(socket().sentOfType('join_call')).toEqual([]);
  });

  it('本人のリセットの完了通知では、入力中の用件を消さない', () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderConnectedCall();
    fireEvent.click(screen.getByRole('button', { name: 'この通話をリセット' }));
    fireEvent.change(screen.getByPlaceholderText('例：内科の初診予約をしたいです'), {
      target: { value: '次の用件' },
    });

    receive({ type: 'call_closed', reason: 'reset' });

    expect(
      (screen.getByPlaceholderText('例：内科の初診予約をしたいです') as HTMLTextAreaElement).value,
    ).toBe('次の用件');
    expect(screen.queryByTestId('call-notice')).toBeNull();
  });
});

describe('再接続', () => {
  const turns = [
    { seq: 1, sender: '患者' as const, text: 'お電話しております。', origin: 'greeting' as const },
    { seq: 2, sender: '病院受付' as const, text: '切断中に届いた質問です' },
    { seq: 3, sender: '患者' as const, text: '本人が送った文', origin: 'typed' as const },
  ];

  it('再読み込みの後は保存した席のトークンで通話へ戻る', () => {
    window.sessionStorage.setItem('echobridge.seat.patient', SEAT_TOKEN);
    render(<PatientApp />);

    act(() => socket().open());

    expect(socket().sentOfType('join_call')).toEqual([{ type: 'join_call', seatToken: SEAT_TOKEN }]);
  });

  it('席のトークンがなければ参加を送らない', () => {
    render(<PatientApp />);

    act(() => socket().open());

    expect(socket().sentOfType('join_call')).toEqual([]);
  });

  it('切断するとつなぎ直し、同じ席へ戻る', () => {
    vi.useFakeTimers();
    renderConnectedCall();

    act(() => socket().drop());
    expect(screen.getByTestId('call-notice').textContent).toContain('再接続しています');
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    act(() => socket().open());

    expect(socket().sentOfType('join_call')).toEqual([{ type: 'join_call', seatToken: SEAT_TOKEN }]);
  });

  it('スナップショットで通話の記録を取り戻し、文は打ち直さず全文を出す', () => {
    render(<PatientApp />);
    act(() => socket().open());

    receive(callJoined('patient', { turns }));

    const log = within(screen.getByRole('log'));
    expect(log.getByText('切断中に届いた質問です')).toBeTruthy();
    expect(log.getByText('本人が送った文')).toBeTruthy();
  });

  it('スナップショットで候補と生成中の状態を取り戻す', () => {
    render(<PatientApp />);
    act(() => socket().open());

    receive(
      callJoined('patient', {
        turns,
        suggestions: { suggestions: [{ text: 'はい、お願いします。', tag: '承諾' }], ai: GEMINI },
      }),
    );
    expect(screen.getByRole('button', { name: /はい、お願いします。/ })).toBeTruthy();

    receive(callJoined('patient', { turns, isGeneratingSuggestions: true }));
    expect(screen.getByText('返答候補を準備中...')).toBeTruthy();
  });

  it('相手の発話中に切れても、再接続で送信できる状態に戻す', () => {
    renderConnectedCall();
    typeMessage('準備した返事');
    receive({ type: 'hospital_speaking_start' });
    expect(sendTypedButton()).toHaveProperty('disabled', true);

    receive(callJoined('patient', { turns, isHospitalSpeaking: false }));

    expect(sendTypedButton()).toHaveProperty('disabled', false);
    expect(input().value).toBe('準備した返事');
  });

  it('つなぎ直しても、席に戻るまでは通話のメッセージを送らない', () => {
    vi.useFakeTimers();
    renderConnectedCall();
    act(() => socket().drop());
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    act(() => socket().open());

    typeMessage('まだ送れない文');
    fireEvent.click(screen.getByRole('button', { name: 'そのまま送る' }));

    expect(confirmedSpeech()).toEqual([]);
    expect(screen.getByRole('alert').textContent).toContain('送信できませんでした');
    expect(input().value).toBe('まだ送れない文');
  });

  it('通話が見つからなければ、席を忘れて理由を出す', () => {
    window.sessionStorage.setItem('echobridge.seat.patient', SEAT_TOKEN);
    render(<PatientApp />);
    act(() => socket().open());

    receive({ type: 'call_error', code: 'call_not_found' });

    expect(screen.getByTestId('call-notice').textContent).toContain('通話が見つかりません');
    expect(window.sessionStorage.getItem('echobridge.seat.patient')).toBeNull();
  });

  it('別の画面に席を取られたら、戻ろうとせず理由を出す', () => {
    vi.useFakeTimers();
    renderConnectedCall();

    act(() => socket().drop(4001));
    expect(screen.getByTestId('call-notice').textContent).toContain('別の画面で開かれた');
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    act(() => socket().open());

    expect(socket().sentOfType('join_call')).toEqual([]);
    expect(window.sessionStorage.getItem('echobridge.seat.patient')).toBeNull();
  });

  it('相手が切断したら、戻ると読み上げることを知らせる', () => {
    renderConnectedCall();

    receive({ type: 'peer_status', connected: false });
    expect(screen.getByTestId('call-notice').textContent).toContain('相手の接続が切れています');

    receive({ type: 'peer_status', connected: true });
    expect(screen.queryByTestId('call-notice')).toBeNull();
  });

  it('保存期間が過ぎても、確認中の予定は画面に残す', () => {
    renderConnectedCall();
    receive({
      type: 'end_call',
      appointment: {
        title: '内科',
        date: '2026-11-12',
        startTime: '14:30',
        endTime: null,
        location: 'ひまわり医院 (受付)',
        address: '',
        details: '',
      },
      ai: GEMINI,
    });

    receive({ type: 'call_closed', reason: 'retention_expired' });

    expect(screen.getByLabelText(/日付/)).toHaveProperty('value', '2026-11-12');
    expect(screen.getByTestId('call-notice').textContent).toContain('通話記録を削除しました');
  });

  it('終わった通話の再接続で予定の確認に戻る', () => {
    render(<PatientApp />);
    act(() => socket().open());

    receive(
      callJoined('patient', {
        phase: 'ended',
        turns,
        appointment: {
          appointment: {
            title: '内科',
            date: '2026-11-12',
            startTime: '14:30',
            endTime: null,
            location: 'ひまわり医院 (受付)',
            address: '',
            details: '',
          },
          ai: GEMINI,
        },
      }),
    );

    expect(screen.getByLabelText(/日付/)).toHaveProperty('value', '2026-11-12');
  });
});

describe('通話の目的と相手の名前', () => {
  const intentField = () => screen.getByLabelText('最初に伝える用件');

  it('選んだ目的と相手の名前を発信に含め、あいさつのプレビューも目的に合わせる', () => {
    render(<PatientApp />);
    act(() => socket().open());

    fireEvent.click(screen.getByRole('radio', { name: /日常の連絡/ }));
    fireEvent.change(screen.getByLabelText(/相手の名前/), { target: { value: '佐藤さん' } });
    fireEvent.change(intentField(), { target: { value: '土曜の待ち合わせ' } });

    expect(screen.getByTestId('greeting-preview').textContent).toBe(
      buildGreeting('土曜の待ち合わせ', 'general'),
    );

    fireEvent.click(screen.getByRole('button', { name: /発信する/ }));

    expect(socket().sentOfType('start_call')).toEqual([
      { type: 'start_call', intent: '土曜の待ち合わせ', purpose: 'general', partnerName: '佐藤さん' },
    ]);
  });

  it('相手の名前を、会話の記録の発言者として表示する', () => {
    renderConnectedCall();
    receive(callJoined('patient', { partnerName: 'ひまわり医院', turns: [] }));
    receive({ type: 'transcript_final', text: 'ご用件をどうぞ', seq: 2 });

    const log = within(screen.getByRole('log'));
    expect(log.getByText('ひまわり医院')).toBeTruthy();
    expect(log.getByText('ご用件をどうぞ')).toBeTruthy();
  });
});

describe('即答フレーズ', () => {
  it('押すとボタンの文をそのまま、即答の経路で送る', () => {
    renderConnectedCall();

    fireEvent.click(screen.getByRole('button', { name: '少々お待ちください。' }));

    expect(confirmedSpeech()).toEqual([
      { type: 'patient_confirmed_speech', text: '少々お待ちください。', origin: 'quick_phrase' },
    ]);
  });

  it('相手の発話中は送れない', () => {
    renderConnectedCall();
    receive({ type: 'hospital_speaking_start' });

    const button = screen.getByRole('button', { name: 'はい。' });
    fireEvent.click(button);

    expect(button).toHaveProperty('disabled', true);
    expect(confirmedSpeech()).toEqual([]);
  });

  it('相手の発話中も入力とAIの整形はでき、送信だけを待つ', () => {
    renderConnectedCall();
    receive({ type: 'hospital_speaking_start' });

    typeMessage('あした行けます');
    expect(input()).toHaveProperty('disabled', false);
    expect(sendTypedButton()).toHaveProperty('disabled', true);

    fireEvent.click(screen.getByRole('button', { name: 'AIで整える' }));

    expect(socket().sentOfType('patient_polish_request')).toHaveLength(1);
    expect(confirmedSpeech()).toEqual([]);
  });
});

describe('相手の端末での読み上げの状態', () => {
  function sentLine() {
    renderConnectedCall();
    receive({ type: 'patient_speech', text: '本人の文です', origin: 'typed', seq: 2 });
    return within(screen.getByRole('log'));
  }

  it('送った直後は送信済み、相手の報告で読み上げ中、読み上げ済みに変える', () => {
    const log = sentLine();
    expect(log.getAllByText('送信済み').length).toBeGreaterThan(0);

    receive({ type: 'speech_playback', seq: 2, status: 'started' });
    expect(log.getByText('読み上げ中')).toBeTruthy();

    receive({ type: 'speech_playback', seq: 2, status: 'ended' });
    expect(log.getByText('読み上げ済み')).toBeTruthy();
  });

  it('読み上げられなかったら、本人に知らせる', () => {
    const log = sentLine();

    receive({ type: 'speech_playback', seq: 2, status: 'failed' });

    expect(log.getByText('相手の端末で読み上げられませんでした')).toBeTruthy();
  });

  it('再接続のスナップショットから状態を戻す', () => {
    renderConnectedCall();
    receive(
      callJoined('patient', {
        turns: [{ seq: 1, sender: '患者', text: 'あいさつ', origin: 'greeting', playback: 'ended' }],
      }),
    );

    expect(within(screen.getByRole('log')).getByText('読み上げ済み')).toBeTruthy();
  });
});

describe('予定のない通話の終了画面', () => {
  const noSchedule: AppointmentDraft = {
    title: '土曜の待ち合わせ',
    date: null,
    startTime: null,
    endTime: null,
    location: '',
    address: '',
    details: '',
  };

  it('予定が見つからなければ、予定の入力欄を出さず、手で追加できるようにする', () => {
    renderConnectedCall();
    receive({ type: 'end_call', appointment: noSchedule, ai: GEMINI });

    expect(screen.getByText('通話の中で、決まった予定は見つかりませんでした。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Google カレンダーに追加' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '予定を手で追加' }));

    expect(screen.getByRole('button', { name: 'Google カレンダーに追加' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('予定がなくても会話に場所が出ていれば、地図で確かめられ、手で追加するとその場所を使う', () => {
    renderConnectedCall();
    receive({
      type: 'end_call',
      appointment: {
        ...noSchedule,
        location: '駅前の美容室',
        address: '本町1丁目',
        aiFields: ['location', 'address'],
      },
      ai: GEMINI,
    });

    expect(screen.getByText('通話の中で、決まった予定は見つかりませんでした。')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Googleマップで確かめる' }) as HTMLAnchorElement;
    expect(new URL(link.href).searchParams.get('query')).toBe('駅前の美容室 本町1丁目');

    fireEvent.click(screen.getByRole('button', { name: '予定を手で追加' }));

    expect(screen.getByLabelText(/場所/)).toHaveProperty('value', '駅前の美容室');
    expect(screen.getByLabelText(/住所/)).toHaveProperty('value', '本町1丁目');
    expect(screen.getAllByText('AIの読み取り')).toHaveLength(2);
  });
});

describe('レビュー指摘: 即答フレーズをいつでも使える', () => {
  const suggestions = [
    { text: 'はい、お願いいたします。', tag: '承諾' },
    { text: '別の日時でお願いできますか。', tag: '別日程' },
    { text: '持ち物はありますか。', tag: '確認' },
  ];

  it('AI案の確認中でも即答でき、確認中の案と編集は残る', () => {
    renderConnectedCall();
    const requestId = requestPolish('あした行けます');
    polishResult(requestId, 'あした行けます', '明日伺います。');
    fireEvent.change(screen.getByLabelText(/AIの案/), { target: { value: '明日の朝に伺います。' } });

    fireEvent.click(screen.getByRole('button', { name: '少々お待ちください。' }));

    expect(confirmedSpeech()).toEqual([
      { type: 'patient_confirmed_speech', text: '少々お待ちください。', origin: 'quick_phrase' },
    ]);
    expect(screen.getByRole('region', { name: '送信前の確認' })).toBeTruthy();
    expect(screen.getByLabelText(/AIの案/)).toHaveProperty('value', '明日の朝に伺います。');
  });

  it('AIが案を作っている間に即答しても、届いた案で確認画面を開く', () => {
    renderConnectedCall();
    const requestId = requestPolish('あした行けます');

    fireEvent.click(screen.getByRole('button', { name: 'もう一度お願いします。' }));
    polishResult(requestId, 'あした行けます', '明日伺います。');

    expect(screen.getByLabelText(/AIの案/)).toHaveProperty('value', '明日伺います。');
  });

  it('即答フレーズを送っても、返答候補を残す', () => {
    renderConnectedCall();
    receive({ type: 'suggestions', suggestions, ai: GEMINI });

    fireEvent.click(screen.getByRole('button', { name: '少々お待ちください。' }));

    expect(screen.getByRole('button', { name: /持ち物はありますか。/ })).toBeTruthy();
  });

  it('時間をもらう文と聞き返しを、先頭に並べる', () => {
    renderConnectedCall();

    const phrases = within(screen.getByRole('group', { name: '即答フレーズ' }))
      .getAllByRole('button')
      .map((button) => button.textContent);

    expect(phrases.slice(0, 2)).toEqual(['少々お待ちください。', 'もう一度お願いします。']);
  });
});

describe('レビュー指摘: 終了画面の予定の状態', () => {
  const blank: AppointmentDraft = {
    title: '内科の予約',
    date: null,
    startTime: null,
    endTime: null,
    location: 'ひまわり医院',
    address: '',
    details: '',
  };

  function endCall(appointment: AppointmentDraft, ai: AiMeta) {
    renderConnectedCall();
    receive({ type: 'end_call', appointment, ai });
  }

  it('AIの読み取りに失敗したら、予定があるような入力欄を出さず、手で追加できるようにする', () => {
    endCall(blank, { source: 'fallback', reason: 'timeout' });

    expect(screen.getByText(/AIで予定を読み取れませんでした/)).toBeTruthy();
    expect(screen.queryByLabelText(/日付/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '予定を手で追加' }));

    expect(screen.getByText(/あなたが入力する予定です/)).toBeTruthy();
    expect(screen.getByLabelText(/日付/)).toHaveProperty('value', '');
    expect(screen.queryByText('AIの読み取り')).toBeNull();
  });

  it('AIが読み取った項目に印を付け、本人が直した項目からは外す', () => {
    endCall(
      { ...blank, date: '2026-11-12', startTime: '14:30', aiFields: ['date', 'startTime'] },
      GEMINI,
    );

    expect(screen.getAllByText('AIの読み取り')).toHaveLength(2);

    fireEvent.change(screen.getByLabelText(/開始/), { target: { value: '15:00' } });

    expect(screen.getAllByText('AIの読み取り')).toHaveLength(1);
  });

  it('予定のない通話では、予定を求める画面にしない', () => {
    endCall({ ...blank, aiFields: [] }, GEMINI);

    expect(screen.getByText('通話の中で、決まった予定は見つかりませんでした。')).toBeTruthy();
    expect(screen.queryByText('要確認')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('開発用のモックモード', () => {
  const MOCK: AiMeta = { source: 'gemini', model: 'mock-dev-only' };

  it('モックサーバーにつないだら、帯とバッジでAIではないと示し続ける', () => {
    renderConnectedCall();
    receive({ type: 'ai_status', configured: true, backend: 'mock', model: 'mock-dev-only' });

    expect(screen.getByTestId('mock-mode-notice').textContent).toContain('Gemini と Speech-to-Text は使っていません');
    expect(screen.getByTestId('ai-status').textContent).toBe('モック（開発用）');
  });

  it('モックの候補はAIの返答候補と表示せず、Gemini応答とも表示しない', () => {
    renderConnectedCall();
    receive({ type: 'ai_status', configured: true, backend: 'mock', model: 'mock-dev-only' });
    receive({ type: 'suggestions', suggestions: [{ text: 'はい。', tag: '承諾' }], ai: MOCK });

    expect(screen.getByText(/モックの返答候補です/)).toBeTruthy();
    expect(screen.queryByText(/AIの返答候補（/)).toBeNull();
    expect(screen.getByTestId('ai-status').textContent).toBe('モック（開発用）');
  });

  it('モックの整形案は、AIの案として見出しを出さない', () => {
    renderConnectedCall();
    const requestId = requestPolish('あした行きます');
    polishResult(requestId, 'あした行きます', '恐れ入りますが、あした行きます。', MOCK);

    expect(screen.getByRole('heading', { name: /モックの案を確認してください/ })).toBeTruthy();
  });

  it('本番のサーバーでは帯を出さない', () => {
    renderConnectedCall();
    receive({ type: 'ai_status', configured: true, backend: 'vertex', model: 'gemini-test' });

    expect(screen.queryByTestId('mock-mode-notice')).toBeNull();
  });
});

describe('登録した文（カスタム返答）', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearCustomPhrases();
  });

  const SELF_INTRO = '発話に障害があるため、AIの音声でお話ししています。';

  function registerInCall(text: string) {
    fireEvent.click(screen.getByRole('button', { name: '登録する' }));
    fireEvent.change(screen.getByRole('textbox', { name: '新しい文を登録' }), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: '登録する' }));
    fireEvent.click(screen.getByRole('button', { name: '完了' }));
  }

  it('登録・修正・削除の操作では、相手に何も送らない', () => {
    renderConnectedCall();

    registerInCall(SELF_INTRO);
    fireEvent.click(screen.getByRole('button', { name: '登録した文を編集' }));
    fireEvent.click(screen.getByRole('button', { name: `直す: ${SELF_INTRO}` }));
    fireEvent.change(screen.getByRole('textbox', { name: '登録した文を直す' }), { target: { value: '直した文です。' } });
    fireEvent.click(screen.getByRole('button', { name: '直した文を保存' }));
    fireEvent.click(screen.getByRole('button', { name: '削除: 直した文です。' }));

    expect(confirmedSpeech()).toEqual([]);
  });

  it('全文を表示し、押すと表示どおりの文を、登録した文の経路で送る', () => {
    renderConnectedCall();
    registerInCall(`  ${SELF_INTRO}\n`);

    expect(screen.getByText(SELF_INTRO)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `この文を送る: ${SELF_INTRO}` }));

    expect(confirmedSpeech()).toEqual([{ type: 'patient_confirmed_speech', text: SELF_INTRO, origin: 'custom_phrase' }]);
  });

  it('送っても返答候補を残す', () => {
    renderConnectedCall();
    registerInCall(SELF_INTRO);
    receive({ type: 'suggestions', suggestions: [{ text: 'はい、お願いします。', tag: '承諾' }], ai: GEMINI });

    fireEvent.click(screen.getByRole('button', { name: `この文を送る: ${SELF_INTRO}` }));

    expect(screen.getByRole('button', { name: /はい、お願いします。/ })).toBeTruthy();
  });

  it('相手の発話中は送れない', () => {
    renderConnectedCall();
    registerInCall(SELF_INTRO);
    receive({ type: 'hospital_speaking_start' });

    const send = screen.getByRole('button', { name: `この文を送る: ${SELF_INTRO}` }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(confirmedSpeech()).toEqual([]);
  });

  it('この端末に保存し、画面を開き直しても残る', () => {
    renderConnectedCall();
    registerInCall(SELF_INTRO);
    cleanup();

    renderConnectedCall();

    expect(screen.getByRole('button', { name: `この文を送る: ${SELF_INTRO}` })).toBeTruthy();
  });

  it('すべて削除は確かめてから、端末からも消す', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderConnectedCall();
    registerInCall(SELF_INTRO);
    fireEvent.click(screen.getByRole('button', { name: '登録した文を編集' }));

    fireEvent.click(screen.getByRole('button', { name: 'すべて削除' }));

    expect(confirm).toHaveBeenCalled();
    expect(window.localStorage.getItem('echobridge.customPhrases.v1')).toBeNull();
    expect(screen.queryByText(SELF_INTRO)).toBeNull();
  });

  it('発信前の画面でも登録でき、保存先と削除の方法を示す', () => {
    render(<PatientApp />);
    act(() => socket().open());

    fireEvent.click(screen.getByText('よく使う文の登録（任意）'));
    expect(screen.getByTestId('custom-phrases-privacy').textContent).toContain('この端末のブラウザにだけ保存');
    fireEvent.change(screen.getByRole('textbox', { name: '新しい文を登録' }), { target: { value: SELF_INTRO } });
    fireEvent.click(screen.getByRole('button', { name: '登録する' }));

    expect(screen.getByText(SELF_INTRO)).toBeTruthy();
    expect(socket().sentOfType('patient_confirmed_speech')).toEqual([]);
  });
});

describe('サーバーが送信を断ったとき', () => {
  it('通話中に文を断られたら、届いていないことを本人に示す', () => {
    renderConnectedCall();
    typeMessage('届かない文');
    fireEvent.click(sendTypedButton());

    receive({ type: 'call_error', code: 'invalid_message' });

    expect(screen.getByRole('alert').textContent).toContain('相手に届いていません');
  });

  it('通話の段階が変わって断られた場合も示す', () => {
    renderConnectedCall();
    typeMessage('終了と行き違った文');
    fireEvent.click(sendTypedButton());

    receive({ type: 'call_error', code: 'not_allowed' });

    expect(screen.getByRole('alert').textContent).toContain('相手に届いていません');
  });
});
