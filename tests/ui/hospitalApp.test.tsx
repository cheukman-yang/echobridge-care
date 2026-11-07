// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HospitalApp from '@/app/hospital/page';
import type { ServerMessage, SpeechStatus } from '@/lib/callProtocol';
import { SEAT_TOKEN, callJoined } from '../helpers/callMessages';
import { FakeWebSocket } from '../helpers/fakeWebSocket';

const NOT_SENT_NOTICE = '録音を開始できませんでした。音声は送られていません。';
const INTERRUPTED_NOTICE = '音声認識が中断しました。もう一度話してください。';
const RECORDING_LABEL = '録音＆送信中...';
const PREPARING_LABEL = '録音を準備中... まだ話さないでください';

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  state = 'running';
  destination = {};
  processor = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onaudioprocess: null as ((event: unknown) => void) | null,
  };
  close = vi.fn(async () => {
    this.state = 'closed';
  });

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createMediaStreamSource() {
    return { connect: vi.fn() };
  }

  createScriptProcessor() {
    return this.processor;
  }
}

function socket() {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

function receive(message: ServerMessage) {
  act(() => socket().receive(message));
}

/** サーバーの受け付けを届け、マイクの準備が終わるまで進める。 */
async function serverAccepts() {
  await act(async () => socket().receive({ type: 'hospital_speaking_start' }));
}

function renderConnectedCall(status: SpeechStatus | null = 'ready') {
  render(<HospitalApp />);
  act(() => socket().open());
  if (status) receive({ type: 'speech_status', status });
  receive(callJoined('hospital', { phase: 'ringing' }));
  fireEvent.click(screen.getByRole('button', { name: '応答する' }));
}

async function renderRecordingCall() {
  renderConnectedCall();
  fireEvent.mouseDown(ptt());
  await serverAccepts();
}

const ptt = () => screen.getByRole('button', { name: '長押しで発話' }) as HTMLButtonElement;
const pttLabel = () => screen.getByRole('status').textContent;
const failureNotice = () => screen.queryByRole('alert')?.textContent ?? null;
const startRequests = () => socket().sentOfType('hospital_speaking_start');
const micProcessor = () => FakeAudioContext.instances.at(-1)!.processor;

function speakIntoMic() {
  act(() =>
    micProcessor().onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array([0.25, -0.25]) },
    }),
  );
}

describe('病院の録音', () => {
  let track: { stop: ReturnType<typeof vi.fn> };
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeAudioContext.instances = [];
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/hospital');
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('alert', vi.fn());

    track = { stop: vi.fn() };
    getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  describe('録音できない状態を押す前に知らせる', () => {
    it('音声認識の確認が終わるまで押せない', () => {
      renderConnectedCall('checking');

      expect(ptt().disabled).toBe(true);
      expect(pttLabel()).toBe('音声認識を準備中です。まだ録音できません');

      fireEvent.mouseDown(ptt());
      expect(startRequests()).toEqual([]);
    });

    it('状態が届く前も押せない', () => {
      renderConnectedCall(null);

      expect(ptt().disabled).toBe(true);
      expect(pttLabel()).toBe('音声認識を準備中です。まだ録音できません');
    });

    it('準備が終わると押せるようになる', () => {
      renderConnectedCall('checking');

      receive({ type: 'speech_status', status: 'ready' });

      expect(ptt().disabled).toBe(false);
      expect(pttLabel()).toBe('長押しで発話 (PTT)');
    });

    it('利用できないことを表示し、押すと確認し直せる', () => {
      renderConnectedCall('unavailable');

      expect(pttLabel()).toBe('音声認識を利用できません。長押しで再確認します');
      expect(ptt().disabled).toBe(false);

      fireEvent.mouseDown(ptt());

      expect(startRequests()).toHaveLength(1);
    });

    it('サーバーに接続していないと押せず、理由を表示する', () => {
      renderConnectedCall();

      act(() => socket().drop());

      expect(ptt().disabled).toBe(true);
      expect(pttLabel()).toBe('サーバーに接続していません');
    });

    it('相手が話している間は押せない', () => {
      renderConnectedCall();

      receive({ type: 'patient_speaking_status', isSpeaking: true });

      expect(ptt().disabled).toBe(true);
      expect(pttLabel()).toBe('相手が発話・入力中...');
    });

    // 無効にすると mouseup が届かず、指を離しても録音が止まらなくなる。
    it('録音中に相手が話し始めても、指を離して止められる', async () => {
      await renderRecordingCall();

      receive({ type: 'patient_speaking_status', isSpeaking: true });
      fireEvent.mouseUp(ptt());

      expect(track.stop).toHaveBeenCalled();
      expect(socket().sentOfType('hospital_speech_end')).toHaveLength(1);
    });

    it('再接続するまで前の状態を信用しない', () => {
      renderConnectedCall();
      act(() => socket().drop());

      act(() => {
        socket().readyState = FakeWebSocket.OPEN;
        socket().onopen?.();
      });

      expect(ptt().disabled).toBe(true);
    });
  });

  describe('サーバーが受け付けてから録音する', () => {
    it('受け付けまではマイクを開かず、録音中と表示しない', () => {
      renderConnectedCall();

      fireEvent.mouseDown(ptt());

      expect(startRequests()).toHaveLength(1);
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(pttLabel()).toBe(PREPARING_LABEL);
    });

    it('マイクが開くまでは録音中と表示しない', async () => {
      let openMic: (stream: unknown) => void = () => {};
      getUserMedia.mockImplementation(() => new Promise((resolve) => { openMic = resolve; }));
      renderConnectedCall();
      fireEvent.mouseDown(ptt());

      await serverAccepts();
      expect(pttLabel()).toBe(PREPARING_LABEL);

      await act(async () => openMic({ getTracks: () => [track] }));
      expect(pttLabel()).toBe(RECORDING_LABEL);
    });

    it('受け付けとマイクがそろったら音声を送る', async () => {
      await renderRecordingCall();

      speakIntoMic();

      expect(pttLabel()).toBe(RECORDING_LABEL);
      expect(socket().audio).toHaveLength(1);
    });

    it('指を離すとマイクを閉じ、発話の終わりを送る', async () => {
      await renderRecordingCall();

      fireEvent.mouseUp(ptt());

      expect(track.stop).toHaveBeenCalled();
      expect(micProcessor().disconnect).toHaveBeenCalled();
      expect(socket().sentOfType('hospital_speech_end')).toHaveLength(1);
      expect(pttLabel()).toBe('長押しで発話 (PTT)');
    });

    it('別の端末の録音の配信ではマイクを開かない', async () => {
      renderConnectedCall();

      await serverAccepts();

      expect(getUserMedia).not.toHaveBeenCalled();
    });
  });

  describe('録音できなかったら本人に知らせる', () => {
    it('サーバーが断ったらマイクを開かず、音声が届いていないと伝える', async () => {
      renderConnectedCall();
      fireEvent.mouseDown(ptt());

      receive({ type: 'hospital_recording_failed', reason: 'start_failed' });
      await serverAccepts();

      expect(getUserMedia).not.toHaveBeenCalled();
      expect(failureNotice()).toBe(NOT_SENT_NOTICE);
      expect(pttLabel()).toBe('長押しで発話 (PTT)');
    });

    it('断られた後に指を離しても、発話の終わりを送らない', () => {
      renderConnectedCall();
      fireEvent.mouseDown(ptt());
      receive({ type: 'hospital_recording_failed', reason: 'start_failed' });

      fireEvent.mouseUp(ptt());

      expect(socket().sentOfType('hospital_speech_end')).toEqual([]);
    });

    it('録音中に認識が止まったらマイクを閉じ、話し直すよう伝える', async () => {
      await renderRecordingCall();

      receive({ type: 'hospital_recording_failed', reason: 'stream_failed' });

      expect(track.stop).toHaveBeenCalled();
      expect(failureNotice()).toBe(INTERRUPTED_NOTICE);
      expect(pttLabel()).toBe('長押しで発話 (PTT)');
      expect(socket().sentOfType('hospital_speech_end')).toEqual([]);
    });

    it('次の録音を始めると通知を消す', () => {
      renderConnectedCall();
      fireEvent.mouseDown(ptt());
      receive({ type: 'hospital_recording_failed', reason: 'start_failed' });

      fireEvent.mouseDown(ptt());

      expect(failureNotice()).toBeNull();
    });

    it('録音中に接続が切れたらマイクを閉じ、話し直すよう伝える', async () => {
      await renderRecordingCall();

      act(() => socket().drop());

      expect(track.stop).toHaveBeenCalled();
      expect(failureNotice()).toBe(INTERRUPTED_NOTICE);
    });

    it('再接続しても、録音が中断した通知は次の録音まで残す', async () => {
      await renderRecordingCall();
      act(() => socket().drop());

      act(() => {
        socket().readyState = FakeWebSocket.OPEN;
        socket().onopen?.();
      });
      receive(callJoined('hospital', {}));

      expect(failureNotice()).toBe(INTERRUPTED_NOTICE);
    });

    it('マイクを使えなければ録音を取り消す', async () => {
      getUserMedia.mockRejectedValue(new Error('denied'));
      renderConnectedCall();
      fireEvent.mouseDown(ptt());

      await serverAccepts();

      expect(alert).toHaveBeenCalledWith('マイクの使用が許可されていません。');
      expect(socket().sentOfType('hospital_speaking_stop')).toHaveLength(1);
      expect(pttLabel()).toBe('長押しで発話 (PTT)');
    });
  });

  describe('不要になったマイクを残さない', () => {
    it('マイクが開く前に指を離したら、開いた時点で閉じる', async () => {
      let openMic: (stream: unknown) => void = () => {};
      getUserMedia.mockImplementation(() => new Promise((resolve) => { openMic = resolve; }));
      renderConnectedCall();
      fireEvent.mouseDown(ptt());
      await serverAccepts();

      fireEvent.mouseUp(ptt());
      await act(async () => openMic({ getTracks: () => [track] }));

      expect(track.stop).toHaveBeenCalled();
      expect(pttLabel()).toBe('長押しで発話 (PTT)');
      expect(socket().sentOfType('hospital_speech_end')).toHaveLength(1);
    });

    it('受け付けの前に指を離したら、マイクを開かない', async () => {
      renderConnectedCall();
      fireEvent.mouseDown(ptt());
      fireEvent.mouseUp(ptt());

      await serverAccepts();

      expect(getUserMedia).not.toHaveBeenCalled();
    });

    it('リセットされたらマイクを閉じる', async () => {
      await renderRecordingCall();

      receive({ type: 'call_closed', reason: 'reset' });

      expect(track.stop).toHaveBeenCalled();
    });

    it('通話が終わったらマイクを閉じる', async () => {
      await renderRecordingCall();

      receive({ type: 'call_ending' });

      expect(track.stop).toHaveBeenCalled();
      expect(screen.getByText('通話が終了しました')).toBeTruthy();
    });
  });
});

describe('病院役の参加と読み上げ', () => {
  class FakeUtterance {
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    lang = '';
    rate = 1;
    constructor(public text: string) {}
  }

  let spoken: FakeUtterance[];

  const finishSpeaking = () => act(() => spoken.at(-1)?.onend?.());
  const spokenTexts = () => spoken.map((utterance) => utterance.text);
  const codeInput = () => screen.getByRole('textbox', { name: '通話コード' }) as HTMLInputElement;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeAudioContext.instances = [];
    spoken = [];
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/hospital');
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    vi.stubGlobal('speechSynthesis', {
      speaking: false,
      cancel: vi.fn(),
      speak: vi.fn((utterance: FakeUtterance) => spoken.push(utterance)),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('通話への参加', () => {
    it('招待リンクを開くと自動で参加し、アドレスバーからコードを消す', () => {
      window.history.replaceState(null, '', '/hospital#invite=abcde-12345');
      render(<HospitalApp />);

      act(() => socket().open());

      expect(socket().sentOfType('join_call')).toEqual([
        { type: 'join_call', inviteCode: 'ABCDE12345' },
      ]);
      expect(window.location.hash).toBe('');
    });

    it('コードを手で入力して参加できる', () => {
      render(<HospitalApp />);
      act(() => socket().open());

      fireEvent.change(codeInput(), { target: { value: 'abcde-12345' } });
      fireEvent.click(screen.getByRole('button', { name: '通話に参加する' }));

      expect(socket().sentOfType('join_call')).toEqual([
        { type: 'join_call', inviteCode: 'ABCDE12345' },
      ]);
    });

    it('リンクなしで開いても参加しない', () => {
      render(<HospitalApp />);

      act(() => socket().open());

      expect(socket().sentOfType('join_call')).toEqual([]);
      expect(codeInput()).toBeTruthy();
    });

    it('使えないコードは理由を出して、入力画面に留まる', () => {
      render(<HospitalApp />);
      act(() => socket().open());

      receive({ type: 'call_error', code: 'invalid_invite' });

      expect(screen.getByTestId('call-notice').textContent).toContain('このコードは使えません');
      expect(codeInput()).toBeTruthy();
    });

    it('参加すると着信を表示する', () => {
      render(<HospitalApp />);
      act(() => socket().open());

      receive(callJoined('hospital', { phase: 'ringing' }));

      expect(screen.getByRole('button', { name: '応答する' })).toBeTruthy();
    });

    it('切断中に応答を押しても、応答したことにしない', () => {
      render(<HospitalApp />);
      act(() => socket().open());
      receive(callJoined('hospital', { phase: 'ringing' }));
      act(() => socket().drop());

      fireEvent.click(screen.getByRole('button', { name: '応答する' }));

      expect(screen.getByRole('button', { name: '応答する' })).toBeTruthy();
      expect(screen.getByTestId('call-notice').textContent).toContain('再接続しています');
    });

    it('切断中に貼ったリンクは、つながった時に使う', () => {
      vi.useFakeTimers();
      render(<HospitalApp />);
      act(() => socket().open());
      act(() => socket().drop());

      act(() => {
        window.history.replaceState(null, '', '/hospital#invite=ABCDE12345');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      act(() => socket().open());

      expect(socket().sentOfType('join_call')).toEqual([
        { type: 'join_call', inviteCode: 'ABCDE12345' },
      ]);
    });

    it('応答しないと席を手放し、入力画面に戻る', () => {
      render(<HospitalApp />);
      act(() => socket().open());
      receive(callJoined('hospital', { phase: 'ringing' }));

      fireEvent.click(screen.getByRole('button', { name: '応答しない' }));

      expect(socket().sentOfType('leave_call')).toHaveLength(1);
      expect(codeInput()).toBeTruthy();
      expect(window.sessionStorage.getItem('echobridge.seat.hospital')).toBeNull();
    });

    it('通話を切ると終了を送り、マイクの録音を止める', () => {
      render(<HospitalApp />);
      act(() => socket().open());
      receive(callJoined('hospital', { phase: 'ringing' }));
      fireEvent.click(screen.getByRole('button', { name: '応答する' }));

      fireEvent.click(screen.getByRole('button', { name: '通話を切る' }));

      expect(socket().sentOfType('end_call')).toHaveLength(1);
      expect(screen.getByText('通話が終了しました')).toBeTruthy();
    });

    it('切断中は通話を切れず、画面もそのまま', () => {
      render(<HospitalApp />);
      act(() => socket().open());
      receive(callJoined('hospital', { phase: 'ringing' }));
      fireEvent.click(screen.getByRole('button', { name: '応答する' }));
      act(() => socket().drop());

      fireEvent.click(screen.getByRole('button', { name: '通話を切る' }));

      expect(screen.queryByText('通話が終了しました')).toBeNull();
      expect(screen.getByTestId('call-notice').textContent).toContain('再接続しています');
    });

    it('待機画面に戻ると席を手放す。通話のリセットは送らない', () => {
      render(<HospitalApp />);
      act(() => socket().open());
      receive(callJoined('hospital', { phase: 'ended' }));

      fireEvent.click(screen.getByRole('button', { name: '待機画面に戻る' }));

      expect(socket().sentOfType('leave_call')).toHaveLength(1);
      expect(socket().sentOfType('reset_call')).toEqual([]);
      expect(codeInput()).toBeTruthy();
    });

    it('通話が閉じられたら理由を出し、入力画面に戻る', () => {
      render(<HospitalApp />);
      act(() => socket().open());
      receive(callJoined('hospital', { phase: 'ringing' }));
      fireEvent.click(screen.getByRole('button', { name: '応答する' }));

      receive({ type: 'call_closed', reason: 'reset' });

      expect(screen.getByTestId('call-notice').textContent).toContain('相手が通話を終了しました');
      expect(codeInput()).toBeTruthy();
    });

    it('保存期間の終わりは病院役に知らせない', () => {
      render(<HospitalApp />);
      act(() => socket().open());
      receive(callJoined('hospital', { phase: 'ended' }));

      receive({ type: 'call_closed', reason: 'retention_expired' });

      expect(codeInput()).toBeTruthy();
      expect(screen.queryByTestId('call-notice')).toBeNull();
    });

    it('開いているタブに新しいリンクを貼ると参加する', () => {
      render(<HospitalApp />);
      act(() => socket().open());

      act(() => {
        window.history.replaceState(null, '', '/hospital#invite=ABCDE12345');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });

      expect(socket().sentOfType('join_call')).toEqual([
        { type: 'join_call', inviteCode: 'ABCDE12345' },
      ]);
      expect(window.location.hash).toBe('');
    });

    it('終わった通話の画面で新しいリンクを貼ると、席を手放してから参加する', () => {
      render(<HospitalApp />);
      act(() => socket().open());
      receive(callJoined('hospital', { phase: 'ended' }));

      act(() => {
        window.history.replaceState(null, '', '/hospital#invite=ABCDE12345');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });

      expect(socket().sent.map((message) => message.type)).toEqual(['leave_call', 'join_call']);
    });

    it('通話中に別のリンクを貼っても、今の通話を離れない', () => {
      render(<HospitalApp />);
      act(() => socket().open());
      receive(callJoined('hospital', { phase: 'ringing' }));
      fireEvent.click(screen.getByRole('button', { name: '応答する' }));

      act(() => {
        window.history.replaceState(null, '', '/hospital#invite=ABCDE12345');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });

      expect(socket().sentOfType('join_call')).toEqual([]);
      expect(screen.getByTestId('call-notice').textContent).toContain('通話中は別の通話に参加できません');
    });
  });

  describe('再接続', () => {
    const turns = [
      { seq: 1, sender: '患者' as const, text: 'あいさつ', origin: 'greeting' as const },
      { seq: 2, sender: '病院受付' as const, text: '受付の発言' },
      { seq: 3, sender: '患者' as const, text: '切断中に送った文', origin: 'typed' as const },
    ];

    function connectAndAnswer() {
      render(<HospitalApp />);
      act(() => socket().open());
      receive(callJoined('hospital', { phase: 'ringing' }));
      fireEvent.click(screen.getByRole('button', { name: '応答する' }));
      receive({ type: 'answer_call', text: 'あいさつ', seq: 1 });
      finishSpeaking();
    }

    it('切断中に送られた文を再接続で読み上げ、読んだ文は繰り返さない', () => {
      vi.useFakeTimers();
      connectAndAnswer();
      act(() => socket().drop());
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      act(() => socket().open());

      expect(socket().sentOfType('join_call')).toEqual([{ type: 'join_call', seatToken: SEAT_TOKEN }]);

      receive(callJoined('hospital', { turns }));

      expect(spokenTexts()).toEqual(['あいさつ', '切断中に送った文']);
    });

    it('同じスナップショットが2回届いても二重に読まない', () => {
      connectAndAnswer();

      receive(callJoined('hospital', { turns }));
      receive(callJoined('hospital', { turns }));
      finishSpeaking();

      expect(spokenTexts()).toEqual(['あいさつ', '切断中に送った文']);
    });

    it('再読み込みの後は操作があるまで読み上げず、押すと続きから読む', () => {
      window.sessionStorage.setItem('echobridge.seat.hospital', SEAT_TOKEN);
      window.sessionStorage.setItem(
        'echobridge.hospital.spoken',
        JSON.stringify({ seatToken: SEAT_TOKEN, seq: 1 }),
      );
      render(<HospitalApp />);
      act(() => socket().open());

      receive(callJoined('hospital', { turns }));

      expect(spokenTexts()).toEqual([]);
      expect(screen.queryByRole('button', { name: '長押しで発話' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: '通話に戻る' }));

      expect(spokenTexts()).toEqual(['切断中に送った文']);
      expect(screen.getByRole('button', { name: '長押しで発話' })).toBeTruthy();
    });

    it('別の通話の読み上げ位置は使わない', () => {
      window.sessionStorage.setItem(
        'echobridge.hospital.spoken',
        JSON.stringify({ seatToken: 'old-call', seq: 3 }),
      );
      connectAndAnswer();

      expect(spokenTexts()).toEqual(['あいさつ']);
    });

    it('読み終えた位置を保存する', () => {
      connectAndAnswer();

      const saved = JSON.parse(window.sessionStorage.getItem('echobridge.hospital.spoken') ?? '{}');

      expect(saved).toEqual({ seatToken: SEAT_TOKEN, seq: 1 });
    });

    it('次の通話では読み上げ位置をやり直す', () => {
      connectAndAnswer();
      receive({ type: 'call_closed', reason: 'reset' });

      receive(callJoined('hospital', { phase: 'ringing' }, 'next-seat'));
      fireEvent.click(screen.getByRole('button', { name: '応答する' }));
      receive({ type: 'answer_call', text: '次の通話のあいさつ', seq: 1 });

      expect(spokenTexts()).toEqual(['あいさつ', '次の通話のあいさつ']);
    });

    it('相手が切断したら知らせる', () => {
      connectAndAnswer();

      receive({ type: 'peer_status', connected: false });

      expect(screen.getByTestId('call-notice').textContent).toContain('相手の接続が切れています');
    });

    it('スナップショットで相手の入力中の表示を解除する', () => {
      connectAndAnswer();
      receive({ type: 'speech_status', status: 'ready' });
      receive({ type: 'patient_speaking_status', isSpeaking: true });
      expect((screen.getByRole('button', { name: '長押しで発話' }) as HTMLButtonElement).disabled).toBe(true);

      receive(callJoined('hospital', { turns: [], isPatientSpeaking: false }));

      expect((screen.getByRole('button', { name: '長押しで発話' }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('通話が見つからなければ、席を忘れて入力画面に戻る', () => {
      window.sessionStorage.setItem('echobridge.seat.hospital', SEAT_TOKEN);
      render(<HospitalApp />);
      act(() => socket().open());

      receive({ type: 'call_error', code: 'call_not_found' });

      expect(screen.getByTestId('call-notice').textContent).toContain('通話が見つかりません');
      expect(window.sessionStorage.getItem('echobridge.seat.hospital')).toBeNull();
    });

    it('別の画面に席を取られたら、入力画面に戻って理由を出す', () => {
      connectAndAnswer();

      act(() => socket().drop(4001));

      expect(screen.getByTestId('call-notice').textContent).toContain('別の画面で開かれた');
      expect(codeInput()).toBeTruthy();
    });
  });
});
