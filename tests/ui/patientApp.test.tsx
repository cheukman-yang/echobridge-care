// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PatientApp from '@/app/page';
import type { AiMeta } from '@/lib/aiMeta';
import { CLOSE_CODE_IDLE, buildGreeting } from '@/lib/callProtocol';
import type { AppointmentDraft, ServerMessage } from '@/lib/callProtocol';
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
    expect(screen.queryByText('あなた・入力した文')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(230 * 30);
    });

    expect(screen.getByText('あなた・入力した文')).toBeTruthy();
  });
});

describe('通話後の予定の確認', () => {
  const unknown: AppointmentDraft = {
    title: '内科の予約',
    date: null,
    startTime: null,
    endTime: null,
    location: 'ひまわり医院 (受付)',
    details: '',
  };

  function endCall(appointment: AppointmentDraft, ai: AiMeta) {
    renderConnectedCall();
    receive({ type: 'end_call', appointment, ai });
  }

  const calendarButton = () => screen.getByRole('button', { name: 'Google カレンダーに追加' });

  it('AIが失敗したら理由を示し、日時を埋めない', () => {
    endCall(unknown, { source: 'fallback', reason: 'not_configured' });

    expect(screen.getByRole('alert').textContent).toContain('AIで読み取れませんでした');
    expect(screen.getByLabelText(/日付/)).toHaveProperty('value', '');
    expect(screen.getAllByText('要確認')).toHaveLength(2);
    expect(calendarButton()).toHaveProperty('disabled', true);
  });

  it('本人が日時を入れるとカレンダーへ進める', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    endCall(unknown, { source: 'fallback', reason: 'not_configured' });

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

    expect(socket().sentOfType('start_call')).toEqual([{ type: 'start_call', intent: '内科の初診予約' }]);
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
    expect(screen.getByText('病院役の参加を待っています...')).toBeTruthy();
  });

  it('病院役が画面を開いたら、応答待ちに変える', () => {
    placeCall();
    receive(callJoined('patient', { phase: 'ringing', invite: INVITE, peerConnected: false }));

    receive({ type: 'peer_status', connected: true });

    expect(screen.getByText('病院役の応答を待っています...')).toBeTruthy();
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
  it('通話がないときはリセットを出さない', () => {
    render(<PatientApp />);
    act(() => socket().open());

    expect(screen.queryByRole('button', { name: 'この通話をリセット' })).toBeNull();
  });

  it('リセットしたら席を忘れ、切断しても前の通話に戻らない', () => {
    vi.useFakeTimers();
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

    expect(screen.getByText('切断中に届いた質問です')).toBeTruthy();
    expect(screen.getByText('本人が送った文')).toBeTruthy();
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

  it('相手の発話中に切れても、再接続で入力を戻す', () => {
    renderConnectedCall();
    receive({ type: 'hospital_speaking_start' });
    expect(input()).toHaveProperty('disabled', true);

    receive(callJoined('patient', { turns, isHospitalSpeaking: false }));

    expect(input()).toHaveProperty('disabled', false);
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
            details: '',
          },
          ai: GEMINI,
        },
      }),
    );

    expect(screen.getByLabelText(/日付/)).toHaveProperty('value', '2026-11-12');
  });
});
