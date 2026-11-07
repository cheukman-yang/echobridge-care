// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HospitalApp from '@/app/hospital/page';
import type { ServerMessage, SpeechStatus } from '@/lib/callProtocol';
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
  receive({ type: 'start_call', intent: '内科の予約' });
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

      receive({ type: 'reset_call' });

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
