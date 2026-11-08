import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallRegistry, DEFAULT_CALL_LIMITS, FINAL_TRANSCRIPT_WAIT_MS } from '../../server/callRoom';
import type { CallRoom, RecognizeStream } from '../../server/callRoom';
import type { AiAssistant } from '../../server/geminiService';
import { limitConcurrentStreams } from '../../server/speechRecognizer';
import type { ServerMessage } from '@/lib/callProtocol';
import { FakeSpeech } from '../helpers/callTestServer';

/**
 * @google-cloud/speech の streamingRecognize が返すストリームと同じ動きをする偽物。
 * 実物で確かめた動き（local-dev の実験）:
 * - 送信を閉じると、STTが応答を終えたときに 'end' を出す。'close' は出さない
 * - destroy() すると 'close' を出す。エラー付きなら 'error' の後に 'close'
 * - 下位の接続が応答を終えなければ、送信を閉じても 'end' は来ない
 */
class SdkLikeStream extends EventEmitter {
  writable = true;
  destroyed = false;
  /** 送信を閉じてから 'end' までの時間。null なら来ない。 */
  endDelayMs: number | null = 0;

  write() {
    return true;
  }

  end() {
    if (!this.writable) return this;
    this.writable = false;
    const delay = this.endDelayMs;
    if (delay !== null) {
      setTimeout(() => {
        if (!this.destroyed) this.emit('end');
      }, delay);
    }
    return this;
  }

  destroy(error?: Error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.writable = false;
    queueMicrotask(() => {
      if (error) this.emit('error', error);
      this.emit('close');
    });
    return this;
  }

  speak(transcript: string, isFinal = false) {
    this.emit('data', { results: [{ alternatives: [{ transcript }], isFinal }] });
  }
}

const FALLBACK = { source: 'fallback', reason: 'not_configured' } as const;

const ai: AiAssistant = {
  status: { configured: false, backend: null, model: null },
  suggestReplies: async () => ({ suggestions: [], ai: FALLBACK }),
  polishText: async ({ text }) => ({ original: text, polished: null, ai: FALLBACK }),
  extractAppointment: async () => ({
    appointment: { title: '', date: null, startTime: null, endTime: null, location: '', address: '', details: '' },
    ai: FALLBACK,
  }),
};

interface Server {
  registry: CallRegistry;
  streams: SdkLikeStream[];
}

interface Setup extends Server {
  room: CallRoom;
  /** 相手の席に届いたメッセージ。 */
  hospital: ServerMessage[];
  /** 相手の席に、記録する接続を入れ直す。 */
  seatHospital(): void;
}

/** 本番と同じく、同時録音の上限を CallRoom の外側に挟む。枠はサーバー全体で1つの上限を共有する。 */
function createServer(maxStreams = 1): Server {
  const streams: SdkLikeStream[] = [];
  const base = new FakeSpeech(() => {
    const stream = new SdkLikeStream();
    streams.push(stream);
    return stream as unknown as RecognizeStream;
  });
  const registry = new CallRegistry({
    ai,
    speech: limitConcurrentStreams(base, maxStreams),
    limits: DEFAULT_CALL_LIMITS,
  });
  return { registry, streams };
}

function setup(server: Server | number = 1): Setup {
  const { registry, streams } = typeof server === 'number' ? createServer(server) : server;
  const room = registry.create('架空の用件');
  if (!room) throw new Error('room was not created');
  const hospital: ServerMessage[] = [];
  const seatHospital = () =>
    room.takeSeat('hospital', { send: (message) => hospital.push(message), release: () => {} });
  room.takeSeat('patient', { send: () => {}, release: () => {} });
  room.openHospitalSeat();
  seatHospital();
  room.answer();
  return { registry, room, streams, hospital, seatHospital };
}

/** 録音を始め、受け付けられたか（枠が空いていたか）を返す。 */
function tryRecording({ room, hospital }: Setup): boolean {
  const before = hospital.length;
  room.startRecording();
  const replies = hospital.slice(before).map((message) => message.type);
  if (replies.includes('hospital_speaking_start')) return true;
  if (replies.includes('hospital_recording_failed')) return false;
  throw new Error(`unexpected replies: ${replies.join(',')}`);
}

describe('STTの同時録音の枠', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('話し終えて最終結果が届いたら、枠を返す', async () => {
    const call = setup(1);
    expect(tryRecording(call)).toBe(true);
    call.streams[0].speak('架空の発話');

    const finishing = call.room.finishHospitalSpeech();
    await vi.advanceTimersByTimeAsync(0);
    await finishing;

    expect(tryRecording(call)).toBe(true);
  });

  it('最終結果の待ちが時間切れになっても、枠を返す', async () => {
    const call = setup(1);
    expect(tryRecording(call)).toBe(true);
    call.streams[0].endDelayMs = FINAL_TRANSCRIPT_WAIT_MS + 3_000;
    call.streams[0].speak('架空の発話');

    const finishing = call.room.finishHospitalSpeech();
    await vi.advanceTimersByTimeAsync(FINAL_TRANSCRIPT_WAIT_MS);
    await finishing;

    expect(tryRecording(call)).toBe(true);
  });

  it('時間切れの後に遅れて終わりの合図が来ても、枠を二重に返さない', async () => {
    const call = setup(1);
    expect(tryRecording(call)).toBe(true);
    call.streams[0].endDelayMs = FINAL_TRANSCRIPT_WAIT_MS + 3_000;

    const finishing = call.room.finishHospitalSpeech();
    await vi.advanceTimersByTimeAsync(FINAL_TRANSCRIPT_WAIT_MS);
    await finishing;
    // 実物は打ち切った後に 'end' を出さないが、出ても数を狂わせない。
    call.streams[0].emit('end');
    call.streams[0].emit('close');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(tryRecording(call)).toBe(true);
    expect(tryRecording(call)).toBe(false);
  });

  it('応答を終えないストリームは時間切れで打ち切り、枠を返す', async () => {
    const call = setup(1);
    expect(tryRecording(call)).toBe(true);
    call.streams[0].endDelayMs = null;

    const finishing = call.room.finishHospitalSpeech();
    await vi.advanceTimersByTimeAsync(FINAL_TRANSCRIPT_WAIT_MS);
    await finishing;

    expect(call.streams[0].destroyed).toBe(true);
    expect(tryRecording(call)).toBe(true);
  });

  it('時間切れの後に届いた認識結果は、確定した発話に足さない', async () => {
    const call = setup(1);
    expect(tryRecording(call)).toBe(true);
    call.streams[0].endDelayMs = null;
    call.streams[0].speak('前半');

    const finishing = call.room.finishHospitalSpeech();
    await vi.advanceTimersByTimeAsync(FINAL_TRANSCRIPT_WAIT_MS);
    await finishing;
    call.streams[0].speak('前半と後半', true);

    const finals = call.hospital.filter((message) => message.type === 'transcript_final');
    expect(finals).toEqual([expect.objectContaining({ text: '前半' })]);
  });

  it('録音を止めた後のストリームが失敗しても、枠を返し、サーバーは落ちない', async () => {
    const call = setup(1);
    expect(tryRecording(call)).toBe(true);
    call.streams[0].endDelayMs = null;

    call.room.stopRecording();
    // エラーのリスナーがないと EventEmitter は例外を投げる。
    expect(() => call.streams[0].emit('error', new Error('late failure'))).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    expect(tryRecording(call)).toBe(true);
  });

  it('録音中に相手が切断しても、枠を返す', async () => {
    const call = setup(1);
    expect(tryRecording(call)).toBe(true);
    call.streams[0].endDelayMs = null;

    const peer = { send: () => {}, release: () => {} };
    call.room.takeSeat('hospital', peer);
    call.room.handleDisconnect(peer);
    await vi.advanceTimersByTimeAsync(0);
    call.seatHospital();

    expect(tryRecording(call)).toBe(true);
  });

  it('録音中に通話を閉じても、ほかの通話のために枠を返す', async () => {
    const server = createServer(1);
    const call = setup(server);
    expect(tryRecording(call)).toBe(true);
    call.streams[0].endDelayMs = null;

    call.room.close('reset');
    await vi.advanceTimersByTimeAsync(0);

    expect(call.streams[0].destroyed).toBe(true);
    expect(tryRecording(setup(server))).toBe(true);
  });

  it('通話の終了中に録音していても、ほかの通話のために枠を返す', async () => {
    const server = createServer(1);
    const call = setup(server);
    expect(tryRecording(call)).toBe(true);
    call.streams[0].endDelayMs = null;

    await call.room.end();
    await vi.advanceTimersByTimeAsync(0);

    expect(tryRecording(setup(server))).toBe(true);
  });

  it('ほかの通話の録音中は、上限どおり断る', () => {
    const server = createServer(1);
    expect(tryRecording(setup(server))).toBe(true);
    expect(tryRecording(setup(server))).toBe(false);
  });

  it('録音中にストリームが失敗したら、枠を返して相手に知らせる', async () => {
    const call = setup(1);
    expect(tryRecording(call)).toBe(true);

    call.streams[0].destroy(new Error('stream failed'));
    await vi.advanceTimersByTimeAsync(0);

    expect(call.hospital.map((message) => message.type)).toContain('hospital_recording_failed');
    expect(tryRecording(call)).toBe(true);
  });

  it('音声が来ない時間切れで開き直したら、古い枠を返し、新しい枠だけを使う', async () => {
    const call = setup(1);
    expect(tryRecording(call)).toBe(true);

    call.streams[0].destroy(new Error('Long duration elapsed without audio. Audio should be sent close to real time.'));
    await vi.advanceTimersByTimeAsync(0);

    // 開き直したストリームで録音を続ける。
    expect(call.streams).toHaveLength(2);
    expect(call.hospital.map((message) => message.type)).not.toContain('hospital_recording_failed');
    call.streams[1].speak('続きの発話');
    const finishing = call.room.finishHospitalSpeech();
    await vi.advanceTimersByTimeAsync(0);
    await finishing;

    expect(tryRecording(call)).toBe(true);
  });
});

describe('limitConcurrentStreams の解放', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('終わり・閉じる・失敗の合図が全部来ても、1回だけ返す', () => {
    const streams: SdkLikeStream[] = [];
    const limited = limitConcurrentStreams(
      new FakeSpeech(() => {
        const stream = new SdkLikeStream();
        streams.push(stream);
        return stream as unknown as RecognizeStream;
      }),
      2,
    );
    limited.createStream();
    limited.createStream();

    streams[0].on('error', () => {});
    streams[0].emit('end');
    streams[0].emit('close');
    streams[0].emit('error', new Error('late'));

    expect(() => limited.createStream()).not.toThrow();
    expect(() => limited.createStream()).toThrow('speech_busy');
  });
});
