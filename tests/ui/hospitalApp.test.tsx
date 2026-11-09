// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HospitalApp from '@/app/join/page';
import type { ServerMessage, SpeechStatus } from '@/lib/callProtocol';
import { SEAT_TOKEN, callJoined } from '../helpers/callMessages';
import { FakeWebSocket } from '../helpers/fakeWebSocket';

const NOT_SENT_NOTICE = '録音を開始できませんでした。音声は送られていません。';
const INTERRUPTED_NOTICE = '音声認識が中断しました。もう一度話してください。';
const NO_SPEECH_NOTICE = '声を聞き取れませんでした。相手には何も届いていません。もう一度話してください。';
const RECORDING_LABEL = '録音中です。話し終えたら離してください';
const PREPARING_LABEL = '録音を準備しています。まだ話さないでください';

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  /** 作った直後の状態。操作の外で作ると止まったまま始まるブラウザ（iPhoneなど）を再現する。 */
  static initialState = 'running';

  state = FakeAudioContext.initialState;
  // 多くの端末の標準のレート。画面はこのレートで受け取り、16kHzに変えて送る。
  sampleRate = 48000;
  destination = {};
  processor = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onaudioprocess: null as ((event: unknown) => void) | null,
  };
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  resume = vi.fn(async () => {
    this.state = 'running';
  });

  constructor(public options?: AudioContextOptions) {
    FakeAudioContext.instances.push(this);
  }

  createMediaStreamSource() {
    return { connect: vi.fn() };
  }

  createScriptProcessor() {
    return this.processor;
  }
}

/**
 * jsdom の audio 要素は再生できない（未実装の警告が出る）。この画面は応答などの操作の中で audio 要素の再生を許可させるので、
 * 何も鳴らさない代わりを置く。サーバーの音声の再生は tests/ui/partnerSpeech.test.tsx で確かめる。
 */
class SilentAudio {
  paused = true;
  src = '';
  preload = '';
  setAttribute() {}
  play() {
    return Promise.resolve();
  }
  pause() {}
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
  fireEvent.pointerDown(ptt());
  await serverAccepts();
}

const ptt = () => screen.getByRole('button', { name: '押して話す' }) as HTMLButtonElement;
const pttLabel = () => screen.getByRole('status').textContent;
const failureNotice = () => screen.queryByRole('alert')?.textContent ?? null;
const startRequests = () => socket().sentOfType('hospital_speaking_start');
const micProcessor = () => FakeAudioContext.instances.at(-1)!.processor;

/**
 * 長押しとみなされる時間だけ時計を進める。タイマーは本物のまま。
 * 短く押すと「押して開始・もう一度押して終了」になるので、離して終える検査ではこれを使う。
 */
function holdLongEnough() {
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 1_000);
}

/** ブラウザの ScriptProcessor の1回分（4096サンプル、48kHzで約85ミリ秒）のマイクの音を届ける。 */
const MIC_CHUNK = 4096;

function speakIntoMic() {
  act(() =>
    micProcessor().onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(MIC_CHUNK).fill(0.25) },
    }),
  );
}

const MIC_DENIED_NOTICE = 'マイクの使用が許可されていません。ブラウザの設定で、このサイトのマイクを許可してください。';
const NO_AUDIO_NOTICE =
  'マイクの音を受け取れませんでした。相手には何も届いていません。もう一度押してください。続くときは画面を読み込み直してください。';
const NOT_READY_NOTICE =
  'マイクの準備ができる前に止めたため、録音していません。相手には何も届いていません。もう一度押し、「録音中です」と表示されてから話してください。';

describe('病院の録音', () => {
  let track: { stop: ReturnType<typeof vi.fn> };
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeAudioContext.instances = [];
    FakeAudioContext.initialState = 'running';
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/hospital');
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('Audio', SilentAudio);
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
    vi.useRealTimers();
    // ほかの describe の偽物に持ち越さない。
    FakeAudioContext.initialState = 'running';
  });

  describe('録音できない状態を押す前に知らせる', () => {
    it('音声認識の確認が終わるまで押せない', () => {
      renderConnectedCall('checking');

      expect(ptt().disabled).toBe(true);
      expect(pttLabel()).toBe('音声認識を準備しています。まだ録音できません');

      fireEvent.pointerDown(ptt());
      expect(startRequests()).toEqual([]);
    });

    it('状態が届く前も押せない', () => {
      renderConnectedCall(null);

      expect(ptt().disabled).toBe(true);
      expect(pttLabel()).toBe('音声認識を準備しています。まだ録音できません');
    });

    it('準備が終わると押せるようになる', () => {
      renderConnectedCall('checking');

      receive({ type: 'speech_status', status: 'ready' });

      expect(ptt().disabled).toBe(false);
      expect(pttLabel()).toBe('押すと録音を始めます');
    });

    it('利用できないことを表示し、押すと確認し直せる', () => {
      renderConnectedCall('unavailable');

      expect(pttLabel()).toBe('音声認識を利用できません。押すと再確認します');
      expect(ptt().disabled).toBe(false);

      fireEvent.pointerDown(ptt());

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
      expect(pttLabel()).toBe('相手が入力中です。少しお待ちください');
    });

    // 無効にすると mouseup が届かず、指を離しても録音が止まらなくなる。
    it('録音中に相手が話し始めても、指を離して止められる', async () => {
      await renderRecordingCall();
      speakIntoMic();

      receive({ type: 'patient_speaking_status', isSpeaking: true });
      holdLongEnough();
      fireEvent.pointerUp(ptt());

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

      fireEvent.pointerDown(ptt());

      expect(startRequests()).toHaveLength(1);
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(pttLabel()).toBe(PREPARING_LABEL);
    });

    it('マイクが開くまでは録音中と表示しない', async () => {
      let openMic: (stream: unknown) => void = () => {};
      getUserMedia.mockImplementation(() => new Promise((resolve) => { openMic = resolve; }));
      renderConnectedCall();
      fireEvent.pointerDown(ptt());

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
      speakIntoMic();

      holdLongEnough();

      fireEvent.pointerUp(ptt());

      expect(track.stop).toHaveBeenCalled();
      expect(micProcessor().disconnect).toHaveBeenCalled();
      expect(socket().sentOfType('hospital_speech_end')).toHaveLength(1);
      expect(pttLabel()).toBe('押すと録音を始めます');
    });

    it('別の端末の録音の配信ではマイクを開かない', async () => {
      renderConnectedCall();

      await serverAccepts();

      expect(getUserMedia).not.toHaveBeenCalled();
    });
  });

  describe('端末の標準のレートで受け取り、16kHzにして送る', () => {
    it('マイクの部品にはレートを指定しない（iPhoneで音が欠ける報告があるため）', async () => {
      await renderRecordingCall();

      expect(FakeAudioContext.instances.at(-1)!.options).toBeUndefined();
    });

    it('48kHzで受け取った音を、16kHzの16bitにして送る', async () => {
      await renderRecordingCall();

      speakIntoMic();
      speakIntoMic();

      const samples = socket().audio.reduce((sum, chunk) => sum + chunk.byteLength / 2, 0);
      expect(Math.abs(samples - (2 * MIC_CHUNK) / 3)).toBeLessThanOrEqual(1);
      // 0.25 の一定の音は、16bitでも同じ大きさ（フィルタが落ち着いた後）。
      const last = new Int16Array(socket().audio.at(-1)!);
      expect(Math.abs(last[last.length - 1] - 0.25 * 0x7fff)).toBeLessThanOrEqual(1);
    });

    it('止まったまま始まったマイクの部品は、再開してから録音中と表示する', async () => {
      FakeAudioContext.initialState = 'suspended';
      renderConnectedCall();
      fireEvent.pointerDown(ptt());

      await serverAccepts();
      await act(async () => {});

      expect(FakeAudioContext.instances.at(-1)!.resume).toHaveBeenCalled();
      expect(pttLabel()).toBe(RECORDING_LABEL);
    });

    it('マイクの音が届かないまま終えたら、マイクの問題として知らせ、認識を取り消す', async () => {
      await renderRecordingCall();

      holdLongEnough();
      fireEvent.pointerUp(ptt());

      expect(failureNotice()).toBe(NO_AUDIO_NOTICE);
      expect(socket().sentOfType('hospital_speech_end')).toEqual([]);
      expect(socket().sentOfType('hospital_speaking_stop')).toMatchObject([{ reason: 'no_audio' }]);
      expect(track.stop).toHaveBeenCalled();
      expect(pttLabel()).toBe('押すと録音を始めます');
    });
  });

  describe('録音できなかったら本人に知らせる', () => {
    it('サーバーが断ったらマイクを開かず、音声が届いていないと伝える', async () => {
      renderConnectedCall();
      fireEvent.pointerDown(ptt());

      receive({ type: 'hospital_recording_failed', reason: 'start_failed' });
      await serverAccepts();

      expect(getUserMedia).not.toHaveBeenCalled();
      expect(failureNotice()).toBe(NOT_SENT_NOTICE);
      expect(pttLabel()).toBe('押すと録音を始めます');
    });

    it('断られた後に指を離しても、発話の終わりを送らない', () => {
      renderConnectedCall();
      fireEvent.pointerDown(ptt());
      receive({ type: 'hospital_recording_failed', reason: 'start_failed' });

      holdLongEnough();

      fireEvent.pointerUp(ptt());

      expect(socket().sentOfType('hospital_speech_end')).toEqual([]);
    });

    it('録音中に認識が止まったらマイクを閉じ、話し直すよう伝える', async () => {
      await renderRecordingCall();

      receive({ type: 'hospital_recording_failed', reason: 'stream_failed' });

      expect(track.stop).toHaveBeenCalled();
      expect(failureNotice()).toBe(INTERRUPTED_NOTICE);
      expect(pttLabel()).toBe('押すと録音を始めます');
      expect(socket().sentOfType('hospital_speech_end')).toEqual([]);
    });

    it('次の録音を始めると通知を消す', () => {
      renderConnectedCall();
      fireEvent.pointerDown(ptt());
      receive({ type: 'hospital_recording_failed', reason: 'start_failed' });

      fireEvent.pointerDown(ptt());

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

    it('話したのに文字にならなかったら、届いていないと伝える', async () => {
      await renderRecordingCall();
      speakIntoMic();
      holdLongEnough();
      fireEvent.pointerUp(ptt());

      receive({ type: 'hospital_speaking_stop' });
      receive({ type: 'transcript_empty' });

      expect(failureNotice()).toBe(NO_SPEECH_NOTICE);
      expect(pttLabel()).toBe('押すと録音を始めます');
    });

    it('次の録音を始めた後に届いた「聞き取れなかった」は出さず、録音も止めない', async () => {
      await renderRecordingCall();
      speakIntoMic();
      holdLongEnough();
      fireEvent.pointerUp(ptt());
      fireEvent.pointerDown(ptt());
      await serverAccepts();

      receive({ type: 'transcript_empty' });

      expect(failureNotice()).toBeNull();
      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(pttLabel()).toBe(RECORDING_LABEL);
    });

    it('マイクを使えなければ録音を取り消し、理由を画面の中に出す', async () => {
      getUserMedia.mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
      renderConnectedCall();
      fireEvent.pointerDown(ptt());

      await serverAccepts();

      expect(failureNotice()).toBe(MIC_DENIED_NOTICE);
      // アプリ内のブラウザでは alert が出ないことがあり、出ると通話の画面が隠れる。
      expect(alert).not.toHaveBeenCalled();
      expect(socket().sentOfType('hospital_speaking_stop')).toMatchObject([{ reason: 'mic_denied' }]);
      expect(pttLabel()).toBe('押すと録音を始めます');
    });

    it.each([
      ['NotFoundError', 'マイクが見つかりません。マイクを接続してから、もう一度押してください。'],
      ['NotReadableError', 'マイクを使えませんでした。ほかのアプリがマイクを使っていないか確かめてください。'],
      ['TypeError', 'マイクを開けませんでした。もう一度押してください。'],
    ])('マイクのエラー（%s）に合わせて知らせる', async (name, notice) => {
      getUserMedia.mockRejectedValue(Object.assign(new Error(name), { name }));
      renderConnectedCall();
      fireEvent.pointerDown(ptt());

      await serverAccepts();

      expect(failureNotice()).toBe(notice);
    });

    it('マイクを使えないブラウザでは、サーバーに録音を頼まず理由を出す', () => {
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
      renderConnectedCall();

      fireEvent.pointerDown(ptt());

      expect(startRequests()).toEqual([]);
      expect(failureNotice()).toBe('このブラウザではマイクを使えません。SafariかChromeで開き直してください。');
    });

    it('https でないページでは、サーバーに録音を頼まず理由を出す', () => {
      vi.stubGlobal('isSecureContext', false);
      renderConnectedCall();

      fireEvent.pointerDown(ptt());

      expect(startRequests()).toEqual([]);
      expect(failureNotice()).toBe('このページではマイクを使えません。https:// で始まるアドレスで開いてください。');
    });
  });

  describe('不要になったマイクを残さない', () => {
    // 実機（Android）で、準備中に離した録音が「聞き取れなかった」と出ていた。STTには何も届いていないので取り消す。
    it('マイクが開く前に指を離したら、開いた時点で閉じ、認識を待たずに取り消して理由を伝える', async () => {
      let openMic: (stream: unknown) => void = () => {};
      getUserMedia.mockImplementation(() => new Promise((resolve) => { openMic = resolve; }));
      renderConnectedCall();
      fireEvent.pointerDown(ptt());
      await serverAccepts();

      holdLongEnough();

      fireEvent.pointerUp(ptt());
      await act(async () => openMic({ getTracks: () => [track] }));

      expect(track.stop).toHaveBeenCalled();
      expect(pttLabel()).toBe('押すと録音を始めます');
      expect(socket().sentOfType('hospital_speech_end')).toEqual([]);
      const [stop] = socket().sentOfType('hospital_speaking_stop');
      expect(stop).toMatchObject({ reason: 'not_ready' });
      expect(stop.prepMs).toBeGreaterThanOrEqual(1_000);
      expect(failureNotice()).toBe(NOT_READY_NOTICE);
    });

    it('受け付けの前に指を離したら、マイクを開かず、取り消して理由を伝える', async () => {
      renderConnectedCall();
      fireEvent.pointerDown(ptt());
      holdLongEnough();
      fireEvent.pointerUp(ptt());

      await serverAccepts();

      expect(getUserMedia).not.toHaveBeenCalled();
      expect(socket().sentOfType('hospital_speech_end')).toEqual([]);
      expect(socket().sentOfType('hospital_speaking_stop')).toMatchObject([{ reason: 'not_ready' }]);
      expect(failureNotice()).toBe(NOT_READY_NOTICE);
    });

    it('録音中と表示してから終えたら、マイクの準備にかかった時間を添えて発話の終わりを送る', async () => {
      await renderRecordingCall();
      speakIntoMic();
      holdLongEnough();
      fireEvent.pointerUp(ptt());

      const [end] = socket().sentOfType('hospital_speech_end');
      expect(end.prepMs).toBeGreaterThanOrEqual(0);
      expect(end.prepMs).toBeLessThan(1_000);
      expect(failureNotice()).toBeNull();
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
    vi.stubGlobal('Audio', SilentAudio);
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    vi.stubGlobal('speechSynthesis', {
      speaking: false,
      cancel: vi.fn(),
      // 操作の中で読み上げを許可させる空の発話（iPhone向け）は、読み上げた文に数えない。
      speak: vi.fn((utterance: FakeUtterance) => {
        if (utterance.text) spoken.push(utterance);
      }),
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
      expect(screen.queryByRole('button', { name: '押して話す' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: '通話に戻る' }));

      expect(spokenTexts()).toEqual(['切断中に送った文']);
      expect(screen.getByRole('button', { name: '押して話す' })).toBeTruthy();
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
      expect((screen.getByRole('button', { name: '押して話す' }) as HTMLButtonElement).disabled).toBe(true);

      receive(callJoined('hospital', { turns: [], isPatientSpeaking: false }));

      expect((screen.getByRole('button', { name: '押して話す' }) as HTMLButtonElement).disabled).toBe(false);
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

describe('相手の画面の字幕と読み上げの報告', () => {
  class FakeUtterance {
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    lang = '';
    rate = 1;
    constructor(public text: string) {}
  }

  let spoken: FakeUtterance[];
  const current = () => spoken.at(-1)!;
  const playbackReports = () => socket().sentOfType('speech_playback');

  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeAudioContext.instances = [];
    spoken = [];
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/join');
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('Audio', SilentAudio);
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    vi.stubGlobal('speechSynthesis', {
      speaking: false,
      cancel: vi.fn(),
      // 操作の中で読み上げを許可させる空の発話（iPhone向け）は、読み上げた文に数えない。
      speak: vi.fn((utterance: FakeUtterance) => {
        if (utterance.text) spoken.push(utterance);
      }),
    });
    const track = { stop: vi.fn() };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function answeredCall() {
    renderConnectedCall();
    receive({ type: 'answer_call', text: 'あいさつの文', seq: 1 });
  }

  it('着信の画面に目的と宛先を出す', () => {
    render(<HospitalApp />);
    act(() => socket().open());
    receive(callJoined('hospital', { phase: 'ringing', purpose: 'general', partnerName: '佐藤さん' }));

    expect(screen.getByText('日常の連絡')).toBeTruthy();
    expect(screen.getByText('佐藤さん')).toBeTruthy();
  });

  it('応答する前と、コードの入力画面で、実在の個人情報を話さないよう伝える', () => {
    render(<HospitalApp />);
    act(() => socket().open());
    expect(screen.getByTestId('demo-data-notice').textContent).toContain('実在の個人情報は話さないでください');

    receive(callJoined('hospital', { phase: 'ringing' }));
    const notice = screen.getByTestId('demo-data-notice');
    expect(notice.textContent).toContain('架空の内容');
    expect(notice.textContent).toContain('Google Cloud（Speech-to-Text、Gemini）');
  });

  // 本人は最後の一言を送ってすぐ通話を終えることがある。終了の知らせで読み上げを止めると、相手に届かない。
  it('通話の終了の知らせが来ても、本人が送った文は最後まで読み上げる', () => {
    answeredCall();
    act(() => current().onend?.());
    receive({ type: 'patient_speech', text: 'ありがとうございました。', origin: 'quick_phrase', seq: 2 });
    receive({ type: 'patient_speech', text: '失礼します。', origin: 'quick_phrase', seq: 3 });

    receive({ type: 'call_ending' });

    expect(screen.getByText('通話が終了しました')).toBeTruthy();
    expect(window.speechSynthesis.cancel).not.toHaveBeenCalled();
    act(() => current().onend?.());
    expect(spoken.map((utterance) => utterance.text)).toEqual(['あいさつの文', 'ありがとうございました。', '失礼します。']);
  });

  it('自分で通話を切ったときは、読み上げも止める', () => {
    answeredCall();
    receive({ type: 'patient_speech', text: 'まだ読んでいる文', origin: 'typed', seq: 2 });

    fireEvent.click(screen.getByRole('button', { name: '通話を切る' }));

    expect(window.speechSynthesis.cancel).toHaveBeenCalled();
  });

  it('読み上げの開始と終了を、本人の発言の番号で知らせる', () => {
    answeredCall();

    act(() => current().onstart?.());
    act(() => current().onend?.());

    expect(playbackReports()).toEqual([
      { type: 'speech_playback', seq: 1, status: 'started', engine: 'device' },
      { type: 'speech_playback', seq: 1, status: 'ended', engine: 'device' },
    ]);
  });

  it('読み上げに失敗したら知らせる', () => {
    answeredCall();

    act(() => current().onerror?.());

    expect(playbackReports()).toEqual([{ type: 'speech_playback', seq: 1, status: 'failed', engine: 'device' }]);
  });

  it('自動案内の読み上げは知らせない', () => {
    answeredCall();
    act(() => current().onend?.());

    receive({ type: 'patient_typing_notice', text: '入力中です' });
    act(() => current().onend?.());

    expect(playbackReports().map(({ seq }) => seq)).toEqual([1]);
  });

  // 始まりの合図もないまま時間が切れたら、聞こえていないとみなす。「読み上げ済み」にはしない。
  it('終わりの合図が来なくても、時間がたてば次の文へ進み、始まっていなければ失敗と知らせる', () => {
    vi.useFakeTimers();
    answeredCall();
    receive({ type: 'patient_speech', text: '次の文', origin: 'typed', seq: 3 });
    expect(spoken.map(({ text }) => text)).toEqual(['あいさつの文']);

    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    // 止めた読み上げに巻き込まれないよう、少し待ってから次の文を読む。
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(spoken.map(({ text }) => text)).toEqual(['あいさつの文', '次の文']);
    expect(playbackReports()).toEqual([{ type: 'speech_playback', seq: 1, status: 'failed', engine: 'device' }]);
  });

  it('読み上げている間は録音を始めず、理由を表示する', () => {
    answeredCall();

    expect(ptt().disabled).toBe(true);
    expect(pttLabel()).toBe('相手の文を読み上げています。終わってから話してください');

    act(() => current().onend?.());

    expect(ptt().disabled).toBe(false);
  });

  it('相手の文と自分の文字起こしを字幕に並べる', () => {
    answeredCall();
    act(() => current().onend?.());
    receive({ type: 'transcript_final', text: '自分の発言です', seq: 2 });
    receive({ type: 'patient_speech', text: '相手からの文です', origin: 'typed', seq: 3 });

    const log = screen.getByRole('log');
    expect(log.textContent).toContain('あいさつの文');
    expect(log.textContent).toContain('自分の発言です');
    expect(log.textContent).toContain('相手からの文です');
  });

  it('スペースキーを押し続けると、離したときに終える', async () => {
    renderConnectedCall();

    fireEvent.keyDown(ptt(), { key: ' ' });
    expect(startRequests()).toHaveLength(1);
    await serverAccepts();

    fireEvent.keyDown(ptt(), { key: ' ', repeat: true });
    expect(startRequests()).toHaveLength(1);
    speakIntoMic();

    holdLongEnough();
    fireEvent.keyUp(ptt(), { key: ' ' });
    expect(socket().sentOfType('hospital_speech_end')).toHaveLength(1);
  });

  it('スペースキーを短く押すと録音を続け、もう一度押すと終える', async () => {
    renderConnectedCall();

    fireEvent.keyDown(ptt(), { key: ' ' });
    await serverAccepts();
    fireEvent.keyUp(ptt(), { key: ' ' });
    expect(socket().sentOfType('hospital_speech_end')).toEqual([]);
    expect(pttLabel()).toBe('録音中です。話し終えたら、もう一度押してください');

    fireEvent.keyDown(ptt(), { key: ' ' });
    fireEvent.keyUp(ptt(), { key: ' ' });

    expect(socket().sentOfType('hospital_speech_end')).toHaveLength(1);
    expect(startRequests()).toHaveLength(1);
  });

  it('離す合図が2回届いても、発話の終わりは1回だけ送る', async () => {
    renderConnectedCall();
    fireEvent.pointerDown(ptt());
    await serverAccepts();
    speakIntoMic();

    holdLongEnough();
    fireEvent.pointerUp(ptt());
    fireEvent.pointerCancel(ptt());
    fireEvent.click(ptt());

    expect(socket().sentOfType('hospital_speech_end')).toHaveLength(1);
  });
});

describe('レビュー指摘: 読み上げと録音の整合、録音の操作', () => {
  class FakeUtterance {
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    lang = '';
    rate = 1;
    constructor(public text: string) {}
  }

  let spoken: FakeUtterance[];
  // ブラウザの読み上げが止まらず、終わりの合図も来ない状態を再現する。cancel() でだけ止まる。
  let synthSpeaking: boolean;
  let cancel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeAudioContext.instances = [];
    spoken = [];
    synthSpeaking = false;
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/join');
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('Audio', SilentAudio);
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    cancel = vi.fn(() => {
      synthSpeaking = false;
    });
    vi.stubGlobal('speechSynthesis', {
      get speaking() {
        return synthSpeaking;
      },
      cancel,
      speak: vi.fn((utterance: FakeUtterance) => {
        if (!utterance.text) return;
        spoken.push(utterance);
        synthSpeaking = true;
      }),
    });
    const track = { stop: vi.fn() };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const finishCurrent = () =>
    act(() => {
      synthSpeaking = false;
      spoken.at(-1)?.onend?.();
    });

  it('読み上げが時間切れになったら読み上げを止め、その後の録音の音声を送る', async () => {
    vi.useFakeTimers();
    renderConnectedCall();
    receive({ type: 'answer_call', text: '終わりの合図が来ない文', seq: 1 });

    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(cancel).toHaveBeenCalled();

    fireEvent.pointerDown(ptt());
    await serverAccepts();
    speakIntoMic();

    expect(pttLabel()).toContain('録音中');
    expect(socket().audio).toHaveLength(1);
  });

  it('録音中に届いた文は、録音が終わってから読み上げる', async () => {
    renderConnectedCall();
    fireEvent.pointerDown(ptt());
    await serverAccepts();

    receive({ type: 'patient_speech', text: '録音中に届いた文', origin: 'typed', seq: 2 });
    speakIntoMic();
    expect(spoken).toHaveLength(0);
    expect(socket().audio).toHaveLength(1);

    holdLongEnough();
    fireEvent.pointerUp(ptt());

    expect(socket().sentOfType('hospital_speech_end')).toHaveLength(1);
    expect(spoken.map(({ text }) => text)).toEqual(['録音中に届いた文']);
  });

  it('時間切れの後に古い文の終わりの合図が届いても、次の文の読み上げ中の状態を消さない', () => {
    vi.useFakeTimers();
    renderConnectedCall();
    receive({ type: 'answer_call', text: '一つ目', seq: 1 });
    receive({ type: 'patient_speech', text: '二つ目', origin: 'typed', seq: 2 });
    const first = spoken[0];

    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(spoken.map(({ text }) => text)).toEqual(['一つ目', '二つ目']);

    act(() => first.onend?.());

    expect(ptt().disabled).toBe(true);
    // 一つ目は始まりの合図がないまま時間が切れたので失敗。遅れて届いた終わりの合図では「読み上げ済み」にしない。
    expect(socket().sentOfType('speech_playback')).toEqual([
      { type: 'speech_playback', seq: 1, status: 'failed', engine: 'device' },
    ]);
  });

  it('支援技術のクリックで録音を始め、もう一度のクリックで終える', async () => {
    renderConnectedCall();

    fireEvent.click(ptt());
    expect(socket().sentOfType('hospital_speaking_start')).toHaveLength(1);
    await serverAccepts();

    expect(ptt().getAttribute('aria-pressed')).toBe('true');
    expect(pttLabel()).toBe('録音中です。話し終えたら、もう一度押してください');

    fireEvent.click(ptt());

    expect(socket().sentOfType('hospital_speech_end')).toHaveLength(1);
    expect(ptt().getAttribute('aria-pressed')).toBe('false');
  });

  it('短く押すと録音を続け、もう一度押すと終える', async () => {
    renderConnectedCall();

    fireEvent.pointerDown(ptt());
    await serverAccepts();
    fireEvent.pointerUp(ptt());
    fireEvent.click(ptt());

    expect(socket().sentOfType('hospital_speech_end')).toEqual([]);
    expect(ptt().getAttribute('aria-pressed')).toBe('true');

    fireEvent.pointerDown(ptt());
    fireEvent.pointerUp(ptt());
    fireEvent.click(ptt());

    expect(socket().sentOfType('hospital_speech_end')).toHaveLength(1);
    expect(socket().sentOfType('hospital_speaking_start')).toHaveLength(1);
  });

  it('押し続けてから離すと、その時点で終える', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    renderConnectedCall();

    fireEvent.pointerDown(ptt());
    await serverAccepts();
    speakIntoMic();
    vi.setSystemTime(Date.now() + 1_000);
    fireEvent.pointerUp(ptt());

    expect(socket().sentOfType('hospital_speech_end')).toHaveLength(1);
  });

  it('長い認識途中の文でも、録音の操作欄には末尾だけを短く出す', async () => {
    renderConnectedCall();
    fireEvent.click(ptt());
    await serverAccepts();

    receive({ type: 'transcript_interim', text: `${'あ'.repeat(200)}最後の言葉` });

    const live = screen.getByTestId('ptt-live').textContent ?? '';
    expect(live.length).toBeLessThanOrEqual(60);
    expect(live).toContain('最後の言葉');
    expect(screen.getByRole('region', { name: '字幕' }).textContent).toContain(
      `${'あ'.repeat(200)}最後の言葉`,
    );
    expect(ptt()).toBeTruthy();
  });

  it('読み上げを終えると、次に押したときに録音できる', async () => {
    renderConnectedCall();
    receive({ type: 'answer_call', text: 'あいさつ', seq: 1 });
    expect(ptt().disabled).toBe(true);

    finishCurrent();
    fireEvent.click(ptt());

    expect(socket().sentOfType('hospital_speaking_start')).toHaveLength(1);
  });
});

describe('開発用のモックモード（相手の画面）', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/join');
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('モックサーバーにつないだら、文字起こしが台本だと示す', () => {
    render(<HospitalApp />);
    act(() => socket().open());
    receive({ type: 'ai_status', configured: true, backend: 'mock', model: 'mock-dev-only' });

    expect(screen.getByTestId('mock-mode-notice').textContent).toContain('文字起こし');
  });

  it('本番のサーバーでは帯を出さない', () => {
    render(<HospitalApp />);
    act(() => socket().open());
    receive({ type: 'ai_status', configured: true, backend: 'vertex', model: 'gemini-test' });

    expect(screen.queryByTestId('mock-mode-notice')).toBeNull();
  });
});
