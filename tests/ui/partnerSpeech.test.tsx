// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HospitalApp from '@/app/join/page';
import type { ServerMessage } from '@/lib/callProtocol';
import { SEAT_TOKEN, callJoined } from '../helpers/callMessages';
import { FakeWebSocket } from '../helpers/fakeWebSocket';

/** ブラウザの audio 要素の代わり。再生の結果を手で起こせる。 */
class FakeAudio {
  static instances: FakeAudio[] = [];
  /** play() の結果。既定は再生を許可する。 */
  static playResult: () => Promise<void> = () => Promise.resolve();

  paused = true;
  src = '';
  preload = '';
  sources: string[] = [];
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeAudio.instances.push(this);
  }

  setAttribute() {}

  play() {
    this.paused = false;
    this.sources.push(this.src);
    return FakeAudio.playResult();
  }

  pause() {
    this.paused = true;
  }
}

class FakeUtterance {
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  lang = '';
  rate = 1;
  volume = 1;
  voice: { lang: string; name: string } | null = null;
  constructor(public text: string) {}
}

class FakeAudioContext {
  state = 'running';
  destination = {};
  close = vi.fn(async () => {});
  createMediaStreamSource() {
    return { connect: vi.fn() };
  }
  createScriptProcessor() {
    return { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
  }
}

const audioOf = (label: string) => btoa(label);

let spoken: FakeUtterance[];
let voices: { lang: string; name: string }[];
let decoded: string[];
let blobTypes: string[];

function socket() {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

function receive(message: ServerMessage) {
  act(() => socket().receive(message));
}

const audio = () => FakeAudio.instances[0];
const reports = () => socket().sentOfType('speech_playback');
const ptt = () => screen.getByRole('button', { name: '押して話す' }) as HTMLButtonElement;
const pttLabel = () => screen.getByRole('status').textContent;
/** サーバーの音声として再生した中身（無音の解除は含まない）。 */
const playedAudio = () => decoded;

function finishAudio() {
  act(() => audio().onplaying?.());
  act(() => audio().onended?.());
}

/** 相手として参加し、応答するところまで進める。 */
function answer({ tts = true }: { tts?: boolean } = {}) {
  render(<HospitalApp />);
  act(() => socket().open());
  receive({ type: 'speech_status', status: 'ready' });
  receive({ type: 'tts_status', available: tts });
  receive(callJoined('hospital', { phase: 'ringing' }));
  fireEvent.click(screen.getByRole('button', { name: '応答する' }));
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeAudio.instances = [];
  FakeAudio.playResult = () => Promise.resolve();
  spoken = [];
  voices = [];
  decoded = [];
  blobTypes = [];
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/join');
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  vi.stubGlobal('speechSynthesis', {
    speaking: false,
    cancel: vi.fn(),
    getVoices: () => voices,
    speak: vi.fn((utterance: FakeUtterance) => {
      if (utterance.text) spoken.push(utterance);
    }),
  });
  const realAtob = globalThis.atob;
  vi.stubGlobal('atob', (value: string) => {
    const text = realAtob(value);
    decoded.push(text);
    return text;
  });
  let urls = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => {
      blobTypes.push(blob.type);
      urls += 1;
      return `blob:test-${urls}`;
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
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

describe('サーバーで作った音声を相手の画面で鳴らす', () => {
  it('応答の操作の中で、audio要素の再生を許可させる', () => {
    answer();
    expect(audio().sources).toHaveLength(1);
    expect(blobTypes).toEqual(['audio/wav']);
  });

  it('文が届いたら音声を待ち、届いたら鳴らして、始まりと終わりを知らせる', () => {
    answer();
    receive({ type: 'answer_call', text: 'あいさつの文', seq: 1 });

    expect(spoken).toEqual([]);
    expect(screen.getByText('音声を準備中')).toBeTruthy();
    expect(ptt().disabled).toBe(true);
    expect(pttLabel()).toBe('相手の文の音声を準備しています。少しお待ちください');

    receive({ type: 'speech_audio', seq: 1, audio: audioOf('greeting-mp3'), mimeType: 'audio/mpeg' });

    expect(playedAudio()).toEqual(['greeting-mp3']);
    expect(blobTypes.at(-1)).toBe('audio/mpeg');
    finishAudio();

    expect(reports()).toEqual([
      { type: 'speech_playback', seq: 1, status: 'started', engine: 'cloud' },
      { type: 'speech_playback', seq: 1, status: 'ended', engine: 'cloud' },
    ]);
    expect(spoken).toEqual([]);
    expect(ptt().disabled).toBe(false);
  });

  it('後の文の音声が先に届いても、番号の順に鳴らす', () => {
    answer();
    receive({ type: 'answer_call', text: 'あいさつ', seq: 1 });
    receive({ type: 'patient_speech', text: '二つ目', origin: 'typed', seq: 2 });

    receive({ type: 'speech_audio', seq: 2, audio: audioOf('second'), mimeType: 'audio/mpeg' });
    // 先頭の文（あいさつ）の音声がまだないので、二つ目は鳴らさない。
    expect(playedAudio()).toEqual([]);

    receive({ type: 'speech_audio', seq: 1, audio: audioOf('first'), mimeType: 'audio/mpeg' });
    expect(playedAudio()).toEqual(['first']);
    finishAudio();

    expect(playedAudio()).toEqual(['first', 'second']);
    expect(reports().map(({ seq, status }) => `${seq}:${status}`)).toEqual(['1:started', '1:ended']);
  });

  it('サーバーが作れなかった文は、端末の声で読み、そのことを知らせる', () => {
    answer();
    receive({ type: 'answer_call', text: 'あいさつ', seq: 1 });

    receive({ type: 'speech_audio_failed', seq: 1, reason: 'timeout' });

    expect(spoken.map((utterance) => utterance.text)).toEqual(['あいさつ']);
    act(() => spoken[0].onstart?.());
    expect(reports()).toEqual([{ type: 'speech_playback', seq: 1, status: 'started', engine: 'device' }]);
  });

  it('入力中の案内は、付いてきた音声で鳴らす', () => {
    answer();
    receive({ type: 'patient_typing_notice', text: '入力中です', audio: audioOf('notice'), mimeType: 'audio/mpeg' });

    expect(decoded).toEqual(['notice']);
    expect(spoken).toEqual([]);
  });

  it('サーバーが合成できないときは、音声を待たずに端末の声で読む', () => {
    answer({ tts: false });
    receive({ type: 'answer_call', text: 'あいさつ', seq: 1 });

    expect(spoken.map((utterance) => utterance.text)).toEqual(['あいさつ']);
  });
});

describe('ブラウザが自動再生を止めたとき', () => {
  it('「音声を再生する」を出して本人に知らせ、押すと同じ文から鳴らす', async () => {
    answer();
    receive({ type: 'answer_call', text: 'あいさつ', seq: 1 });
    FakeAudio.playResult = () => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));

    await act(async () => {
      socket().receive({ type: 'speech_audio', seq: 1, audio: audioOf('greeting'), mimeType: 'audio/mpeg' });
    });

    expect(reports()).toEqual([{ type: 'speech_playback', seq: 1, status: 'blocked', engine: 'cloud' }]);
    expect(pttLabel()).toBe('音声の再生が止まっています。「音声を再生する」を押してください');
    expect(ptt().disabled).toBe(true);

    FakeAudio.playResult = () => Promise.resolve();
    fireEvent.click(screen.getByRole('button', { name: '音声を再生する' }));

    expect(decoded).toEqual(['greeting', 'greeting']);
    expect(screen.queryByRole('button', { name: '音声を再生する' })).toBeNull();
    finishAudio();
    expect(reports().at(-1)).toEqual({ type: 'speech_playback', seq: 1, status: 'ended', engine: 'cloud' });
  });
});

describe('読み直しと再接続', () => {
  it('字幕の「もう一度聞く」で同じ音声を鳴らし直す', () => {
    answer();
    receive({ type: 'answer_call', text: 'あいさつ', seq: 1 });
    receive({ type: 'speech_audio', seq: 1, audio: audioOf('greeting'), mimeType: 'audio/mpeg' });
    finishAudio();

    fireEvent.click(screen.getByRole('button', { name: 'もう一度聞く：あいさつ' }));

    expect(decoded).toEqual(['greeting', 'greeting']);
    expect(socket().sentOfType('speech_audio_request')).toEqual([]);
    finishAudio();
    expect(reports().filter(({ status }) => status === 'ended')).toHaveLength(2);
  });

  it('本人が読み直しを頼んだら、もう一度鳴らす', () => {
    answer();
    receive({ type: 'answer_call', text: 'あいさつ', seq: 1 });
    receive({ type: 'speech_audio', seq: 1, audio: audioOf('greeting'), mimeType: 'audio/mpeg' });
    finishAudio();

    receive({ type: 'speech_replay', seq: 1 });

    expect(decoded).toEqual(['greeting', 'greeting']);
  });

  it('再接続したら、読み残しの文の音声をサーバーへ求める', () => {
    answer();
    receive({ type: 'answer_call', text: 'あいさつ', seq: 1 });
    receive({ type: 'speech_audio', seq: 1, audio: audioOf('greeting'), mimeType: 'audio/mpeg' });
    finishAudio();
    act(() => socket().drop());
    act(() => {
      socket().readyState = FakeWebSocket.OPEN;
      socket().onopen?.();
    });
    expect(socket().sentOfType('join_call')).toContainEqual({ type: 'join_call', seatToken: SEAT_TOKEN });

    receive(
      callJoined('hospital', {
        turns: [
          { seq: 1, sender: '患者', text: 'あいさつ', origin: 'greeting' },
          { seq: 2, sender: '病院受付', text: '受付の発言' },
          { seq: 3, sender: '患者', text: '切断中に送った文', origin: 'typed' },
        ],
      }),
    );

    expect(socket().sentOfType('speech_audio_request')).toEqual([{ type: 'speech_audio_request', seq: 3 }]);
    receive({ type: 'speech_audio', seq: 3, audio: audioOf('while-away'), mimeType: 'audio/mpeg' });
    expect(decoded.at(-1)).toBe('while-away');
  });
});

describe('端末の声', () => {
  it('日本語の声を明示して選ぶ', () => {
    voices = [
      { lang: 'yue-HK', name: 'Cantonese' },
      { lang: 'ja_JP', name: 'Japanese' },
    ];
    answer({ tts: false });
    receive({ type: 'answer_call', text: 'あいさつ', seq: 1 });

    expect(spoken[0].voice?.name).toBe('Japanese');
    expect(spoken[0].lang).toBe('ja-JP');
  });

  it('日本語の声がない端末では別の言語で読ませず、字幕だけになったことを示す', () => {
    voices = [{ lang: 'yue-HK', name: 'Cantonese' }];
    answer({ tts: false });

    receive({ type: 'answer_call', text: 'あいさつ', seq: 1 });

    expect(spoken).toEqual([]);
    expect(reports()).toEqual([{ type: 'speech_playback', seq: 1, status: 'failed', engine: 'device' }]);
    expect(screen.getByText(/日本語の読み上げ音声がないため/)).toBeTruthy();
    expect(ptt().disabled).toBe(false);
  });
});
