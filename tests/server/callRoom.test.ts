import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallRegistry, DEFAULT_CALL_LIMITS } from '../../server/callRoom';
import type { AiAssistant, ExtractAppointmentResult } from '../../server/geminiService';
import { FakeSpeech, FakeRecognizeStream } from '../helpers/callTestServer';
import type { RecognizeStream } from '../../server/callServer';

const APPOINTMENT: ExtractAppointmentResult = {
  appointment: {
    title: '内科',
    date: null,
    startTime: null,
    endTime: null,
    location: 'ひまわり医院 (受付)',
    address: '',
    details: '',
  },
  ai: { source: 'fallback', reason: 'not_configured' },
};

/** 一覧の外から見える動きと、タイマーの残りを確かめる。 */
describe('通話の後片付け', () => {
  let finishExtraction: (result: ExtractAppointmentResult) => void;

  const ai: AiAssistant = {
    status: { configured: false, backend: null, model: null },
    suggestReplies: async () => ({ suggestions: [], ai: APPOINTMENT.ai }),
    polishText: async ({ text }) => ({ original: text, polished: null, ai: APPOINTMENT.ai }),
    extractAppointment: () => new Promise((resolve) => (finishExtraction = resolve)),
  };

  function createRegistry() {
    const stream = new FakeRecognizeStream();
    const speech = new FakeSpeech(() => stream as unknown as RecognizeStream);
    return { registry: new CallRegistry({ ai, speech, limits: DEFAULT_CALL_LIMITS }), stream };
  }

  function createRoom(registry: CallRegistry) {
    const room = registry.create('架空の用件');
    if (!room) throw new Error('room was not created');
    return room;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('閉じるとタイマーを残さない', () => {
    const { registry } = createRegistry();
    const room = createRoom(registry);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    room.close('reset');

    expect(vi.getTimerCount()).toBe(0);
    expect(registry.activeCalls).toBe(0);
  });

  it('予定の読み取り中に閉じたら、保存のタイマーを作らない', async () => {
    const { registry } = createRegistry();
    const room = createRoom(registry);
    room.answer();

    const ending = room.end();
    room.close('reset');
    finishExtraction(APPOINTMENT);
    await ending;

    expect(vi.getTimerCount()).toBe(0);
    expect(room.phase).toBe('ending');
  });

  it('閉じたら認識ストリームを止める', () => {
    const { registry, stream } = createRegistry();
    const room = createRoom(registry);
    room.answer();
    room.startRecording();

    room.close('reset');

    expect(stream.writable).toBe(false);
  });

  it('閉じた通話はトークンでも招待でも見つからない', () => {
    const { registry } = createRegistry();
    const room = createRoom(registry);
    const sent: string[] = [];
    const peer = {
      send: (message: { type: string; seatToken?: string; snapshot?: { invite: { code: string } | null } }) => {
        sent.push(message.seatToken ?? '', message.snapshot?.invite?.code ?? '');
      },
      release: () => {},
    };
    room.takeSeat('patient', peer);
    const [seatToken, inviteCode] = sent;
    expect(registry.findSeat(seatToken)?.role).toBe('patient');
    expect(registry.findByInvite(inviteCode)).toBe(room);

    room.close('reset');

    expect(registry.findSeat(seatToken)).toBeNull();
    expect(registry.findByInvite(inviteCode)).toBeNull();
  });

  it('全部閉じると通話は残らない', () => {
    const { registry } = createRegistry();
    createRoom(registry);
    createRoom(registry);

    registry.closeAll('server_closing');

    expect(registry.activeCalls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
