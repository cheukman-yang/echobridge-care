import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { isAllowedOrigin, resolveAllowedOrigins } from '../../server/callServer';
import type { CallServerOptions } from '../../server/callServer';
import type { GeminiModels } from '../../server/geminiClient';
import {
  CLOSE_CODE_IDLE,
  CLOSE_CODE_SEAT_TAKEN,
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  formatInviteCode,
} from '@/lib/callProtocol';
import { CallTestServer, TestClient } from '../helpers/callTestServer';
import type { CallPair, OpenCall } from '../helpers/callTestServer';
import {
  createFakeModels,
  jsonReply,
  requestsField,
  sentContents,
} from '../helpers/fakeGemini';

const THREE_SUGGESTIONS = {
  suggestions: [
    { text: 'はい、お願いいたします。', tag: '承諾' },
    { text: '別の日時でお願いできますか。', tag: '別日程' },
    { text: '持ち物はありますか。', tag: '確認' },
  ],
};

const APPOINTMENT = {
  title: '内科 初診予約',
  date: '2026-11-12',
  startTime: '14:30',
  endTime: null,
  details: null,
};

/** 機能ごとに決まった応答を返す偽のGemini。 */
const scriptedModels = () =>
  createFakeModels((params) => {
    if (requestsField(params, 'suggestions')) return jsonReply(THREE_SUGGESTIONS);
    if (requestsField(params, 'polished')) return jsonReply({ polished: '整えた文です。' });
    return jsonReply(APPOINTMENT);
  });

/** 手でほどくまで返らない偽のGemini。非同期の行き違いを作る。 */
function heldModels() {
  const resolvers: Array<(value: ReturnType<typeof jsonReply>) => void> = [];
  const models = createFakeModels(() => new Promise((resolve) => resolvers.push(resolve)));
  return { models, resolvers };
}

/** 少し待ってから、届いていないことを確かめるために使う。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function raceClose(client: TestClient) {
  return Promise.race([client.closed, settle().then(() => 'still open')]);
}

describe('通話の分離', () => {
  let testServer: CallTestServer;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    testServer = new CallTestServer();
  });

  afterEach(() => testServer.close());

  const listen = (models: GeminiModels | null = null, options?: CallServerOptions) =>
    testServer.listen(models, undefined, options);
  const connect = () => testServer.connect();
  const placeCall = (intent?: string) => testServer.placeCall(intent);
  const openCall = (intent?: string) => testServer.openCall(intent);
  const flush = (call: CallPair) => testServer.flush(call);
  const hospitalSays = (call: OpenCall, text: string) => testServer.hospitalSays(call, text);

  /** 2つの通話を同時に開く。 */
  async function openTwoCalls(models: GeminiModels | null = null, options?: CallServerOptions) {
    await listen(models, options);
    const a = await openCall('Aの用件');
    const b = await openCall('Bの用件');
    return { a, b };
  }

  /** 通話本文が1つも届いていないことを確かめる。 */
  function expectNoCallContent(client: TestClient) {
    expect(client.all('answer_call')).toEqual([]);
    expectNothingSinceAnswer(client);
  }

  /** 応答のあいさつの後に、通話本文が届いていないことを確かめる。 */
  function expectNothingSinceAnswer(client: TestClient) {
    const contentTypes = [
      'patient_speech',
      'patient_typing_notice',
      'patient_polish_result',
      'transcript_interim',
      'transcript_final',
      'generating_suggestions',
      'suggestions',
      'call_ending',
      'end_call',
      'hospital_speaking_start',
    ] as const;
    contentTypes.forEach((type) => expect(client.all(type)).toEqual([]));
  }

  describe('通話への参加', () => {
    it('発信すると招待と席を発行する', async () => {
      await listen();

      const { joined, inviteCode } = await placeCall();

      expect(joined.role).toBe('patient');
      expect(joined.seatToken.length).toBeGreaterThanOrEqual(43);
      expect(joined.snapshot).toMatchObject({ phase: 'ringing', turns: [], peerConnected: false });
      expect(inviteCode).toHaveLength(INVITE_CODE_LENGTH);
      expect([...inviteCode].every((char) => INVITE_CODE_ALPHABET.includes(char))).toBe(true);
    });

    it('招待コードで病院役が入ると、通話の用件を見せずに着信させる', async () => {
      await listen();
      const { patient, inviteCode } = await placeCall('秘密の用件');
      const hospital = await connect();

      hospital.send({ type: 'join_call', inviteCode });

      const joined = await hospital.waitFor('call_joined');
      expect(joined.role).toBe('hospital');
      expect(joined.snapshot).toMatchObject({ phase: 'ringing', invite: null, peerConnected: true });
      expect(JSON.stringify(joined)).not.toContain('秘密の用件');
      expect((await patient.waitFor('peer_status')).connected).toBe(true);
    });

    it('コードの表記の揺れを受け付ける', async () => {
      await listen();
      const { inviteCode } = await placeCall();
      const hospital = await connect();

      hospital.send({ type: 'join_call', inviteCode: formatInviteCode(inviteCode).toLowerCase() });

      expect((await hospital.waitFor('call_joined')).role).toBe('hospital');
    });

    it('存在しないコードを断る', async () => {
      await listen();
      await placeCall();
      const stranger = await connect();

      stranger.send({ type: 'join_call', inviteCode: '0000000000' });

      expect((await stranger.waitFor('call_error')).code).toBe('invalid_invite');
      expect(stranger.all('call_joined')).toEqual([]);
    });

    it('応答した後の招待は使えない', async () => {
      await listen();
      const { patient, inviteCode } = await placeCall();
      const hospital = await connect();
      hospital.send({ type: 'join_call', inviteCode });
      await hospital.waitFor('call_joined');
      hospital.send({ type: 'answer_call' });
      await patient.waitFor('answer_call');

      const stranger = await connect();
      stranger.send({ type: 'join_call', inviteCode });

      expect((await stranger.waitFor('call_error')).code).toBe('invalid_invite');
      await flush({ patient, hospital });
      expect(await raceClose(hospital)).toBe('still open');
    });

    it('応答の前ならリンクを開き直せて、前の席のトークンは無効になる', async () => {
      await listen();
      const { inviteCode } = await placeCall();
      const first = await connect();
      first.send({ type: 'join_call', inviteCode });
      const { seatToken: oldToken } = await first.waitFor('call_joined');

      const second = await connect();
      second.send({ type: 'join_call', inviteCode });
      const { seatToken: newToken } = await second.waitFor('call_joined');

      expect(await first.closed).toBe(CLOSE_CODE_SEAT_TAKEN);
      expect(newToken).not.toBe(oldToken);

      const third = await connect();
      third.send({ type: 'join_call', seatToken: oldToken });
      expect((await third.waitFor('call_error')).code).toBe('call_not_found');
    });

    it('応答すると病院の席のトークンで戻れる', async () => {
      await listen();
      const { hospital } = await openCall();
      const { seatToken } = hospital.all('call_joined')[0];
      hospital.close();
      await hospital.closed;

      const returning = await connect();
      returning.send({ type: 'join_call', seatToken });

      expect((await returning.waitFor('call_joined')).role).toBe('hospital');
    });

    it('通話中の接続は別の通話を始められない', async () => {
      await listen();
      const { patient, inviteCode } = await placeCall();

      patient.send({ type: 'start_call', intent: '別の用件' });
      expect((await patient.waitFor('call_error')).code).toBe('already_in_call');

      patient.send({ type: 'join_call', inviteCode });
      expect((await patient.waitFor('call_error', 2)).code).toBe('already_in_call');
    });

    it.each([
      ['空の用件', { type: 'start_call', intent: '   ' }],
      ['長すぎる用件', { type: 'start_call', intent: 'あ'.repeat(301) }],
      ['空の参加', { type: 'join_call' }],
      ['型の違うコード', { type: 'join_call', inviteCode: 123 }],
      ['長すぎるトークン', { type: 'join_call', seatToken: 'x'.repeat(129) }],
    ])('%sを断る', async (_, message) => {
      await listen();
      const client = await connect();

      client.send(message);

      expect((await client.waitFor('call_error')).code).toBe('invalid_message');
    });
  });

  describe('2つの通話の分離', () => {
    it('Aの発話はAの2人にだけ届き、Bの発話はBの2人にだけ届く', async () => {
      const { a, b } = await openTwoCalls();

      a.patient.send({ type: 'patient_confirmed_speech', text: 'Aの秘密', origin: 'typed' });
      b.patient.send({ type: 'patient_confirmed_speech', text: 'Bの秘密', origin: 'typed' });

      expect((await a.hospital.waitFor('patient_speech')).text).toBe('Aの秘密');
      expect((await a.patient.waitFor('patient_speech')).text).toBe('Aの秘密');
      expect((await b.hospital.waitFor('patient_speech')).text).toBe('Bの秘密');
      expect((await b.patient.waitFor('patient_speech')).text).toBe('Bの秘密');

      await flush(a);
      await flush(b);
      expect(a.hospital.all('patient_speech')).toHaveLength(1);
      expect(b.hospital.all('patient_speech')).toHaveLength(1);
    });

    it('あいさつと文字起こしが別の通話に届かない', async () => {
      const { a, b } = await openTwoCalls();

      await hospitalSays(a, 'Aの受付の発言');
      await flush(b);

      expect((await a.patient.waitFor('transcript_final')).text).toBe('Aの受付の発言');
      expect(b.patient.all('transcript_interim')).toEqual([]);
      expect(b.patient.all('transcript_final')).toEqual([]);
      expect(b.hospital.all('transcript_final')).toEqual([]);
      expect(a.patient.all('answer_call')[0].text).toContain('Aの用件');
      expect(b.patient.all('answer_call')[0].text).toContain('Bの用件');
    });

    it('同時に録音しても音声と文字起こしが混ざらない', async () => {
      const { a, b } = await openTwoCalls();

      a.hospital.send({ type: 'hospital_speaking_start' });
      await a.hospital.waitFor('hospital_speaking_start');
      const streamA = testServer.streams.at(-1)!;
      b.hospital.send({ type: 'hospital_speaking_start' });
      await b.hospital.waitFor('hospital_speaking_start');
      const streamB = testServer.streams.at(-1)!;
      expect(streamB).not.toBe(streamA);

      a.hospital.sendBinary(Buffer.from([1]));
      b.hospital.sendBinary(Buffer.from([2]));
      await vi.waitFor(() => {
        expect(streamA.written).toHaveLength(1);
        expect(streamB.written).toHaveLength(1);
      });
      expect([...streamA.written[0]]).toEqual([1]);
      expect([...streamB.written[0]]).toEqual([2]);

      streamA.speak('Aの音声');
      streamB.speak('Bの音声');
      expect((await a.patient.waitFor('transcript_interim')).text).toBe('Aの音声');
      expect((await b.patient.waitFor('transcript_interim')).text).toBe('Bの音声');

      a.hospital.send({ type: 'hospital_speech_end' });
      b.hospital.send({ type: 'hospital_speech_end' });
      expect((await a.patient.waitFor('transcript_final')).text).toBe('Aの音声');
      expect((await b.patient.waitFor('transcript_final')).text).toBe('Bの音声');
    });

    it('発話の表示が別の通話の入力を止めない', async () => {
      const { a, b } = await openTwoCalls();

      a.hospital.send({ type: 'hospital_speaking_start' });
      await a.patient.waitFor('hospital_speaking_start');
      a.patient.send({ type: 'patient_speaking_status', isSpeaking: true });
      await a.hospital.waitFor('patient_speaking_status');
      await flush(b);

      expect(b.patient.all('hospital_speaking_start')).toEqual([]);
      expect(b.hospital.all('patient_speaking_status')).toHaveLength(1);
      expect(b.hospital.all('patient_speaking_status')[0].isSpeaking).toBe(false);
    });

    it('AIの案と候補は依頼した通話の患者にだけ届く', async () => {
      const { a, b } = await openTwoCalls(scriptedModels());

      await hospitalSays(a, 'アレルギーはありますか');
      await a.patient.waitFor('suggestions');
      a.patient.send({ type: 'patient_polish_request', requestId: 'r1', text: 'ありません' });
      await a.patient.waitFor('patient_polish_result');
      await flush(a);
      await flush(b);

      expect(a.hospital.all('suggestions')).toEqual([]);
      expect(a.hospital.all('generating_suggestions')).toEqual([]);
      expect(a.hospital.all('patient_polish_result')).toEqual([]);
      expectNothingSinceAnswer(b.patient);
      expectNothingSinceAnswer(b.hospital);
    });

    it('Geminiへ渡す文脈に別の通話の内容が入らない', async () => {
      const models = scriptedModels();
      const { a, b } = await openTwoCalls(models);

      a.patient.send({ type: 'patient_confirmed_speech', text: 'Aだけの事情', origin: 'typed' });
      await a.hospital.waitFor('patient_speech');
      await hospitalSays(b, 'Bの質問');
      await b.patient.waitFor('suggestions');

      const contents = sentContents(models.generateContent.mock.calls.at(-1)![0]);
      expect(contents).toContain('Bの用件');
      expect(contents).toContain('Bの質問');
      expect(contents).not.toContain('Aの用件');
      expect(contents).not.toContain('Aだけの事情');
    });

    it('通話を終えても予定は本人にだけ届き、別の通話は続く', async () => {
      const models = scriptedModels();
      const { a, b } = await openTwoCalls(models);

      a.patient.send({ type: 'end_call' });

      expect((await a.patient.waitFor('end_call')).appointment.date).toBe('2026-11-12');
      expect(await a.hospital.waitFor('call_ending')).toBeDefined();
      await flush(b);
      expect(a.hospital.all('end_call')).toEqual([]);
      expect(b.patient.all('call_ending')).toEqual([]);
      expect(b.patient.all('end_call')).toEqual([]);
      expect(b.hospital.all('end_call')).toEqual([]);

      b.patient.send({ type: 'patient_confirmed_speech', text: 'Bは続く', origin: 'typed' });
      expect((await b.hospital.waitFor('patient_speech')).text).toBe('Bは続く');
    });

    it('一方をリセットしても、もう一方には影響しない', async () => {
      const { a, b } = await openTwoCalls();

      a.patient.send({ type: 'reset_call' });
      await a.hospital.waitFor('call_closed');
      await flush(b);

      expect(b.patient.all('call_closed')).toEqual([]);
      expect(b.hospital.all('call_closed')).toEqual([]);

      await hospitalSays(b, 'Bの通話は続いています');
      expect((await b.patient.waitFor('transcript_final')).text).toBe('Bの通話は続いています');
    });

    it('一方の病院が切断しても、もう一方の録音は止まらない', async () => {
      const { a, b } = await openTwoCalls();
      a.hospital.send({ type: 'hospital_speaking_start' });
      await a.hospital.waitFor('hospital_speaking_start');
      const streamA = testServer.streams.at(-1)!;
      b.hospital.send({ type: 'hospital_speaking_start' });
      await b.hospital.waitFor('hospital_speaking_start');
      const streamB = testServer.streams.at(-1)!;

      a.hospital.terminate();

      await vi.waitFor(() => expect(streamA.writable).toBe(false));
      expect(streamB.writable).toBe(true);
      expect(b.patient.all('hospital_speaking_stop')).toEqual([]);
    });
  });

  describe('関係のない接続を止める', () => {
    it('接続しただけの第三者には通話の内容が届かない', async () => {
      await listen(scriptedModels());
      const stranger = await connect();
      const call = await openCall();

      await hospitalSays(call, '受付の発言');
      await call.patient.waitFor('suggestions');
      call.patient.send({ type: 'patient_confirmed_speech', text: '秘密の返答', origin: 'typed' });
      await call.hospital.waitFor('patient_speech');
      call.patient.send({ type: 'end_call' });
      await call.patient.waitFor('end_call');
      await settle();

      expectNoCallContent(stranger);
      expect(stranger.messages.map((message) => message.type)).toEqual(['ai_status', 'speech_status']);
    });

    it.each([
      [{ type: 'reset_call' }],
      [{ type: 'end_call' }],
      [{ type: 'leave_call' }],
      [{ type: 'answer_call' }],
      [{ type: 'hospital_speaking_start' }],
      [{ type: 'hospital_speech_end' }],
      [{ type: 'patient_typing_notice' }],
      [{ type: 'patient_speaking_status', isSpeaking: true }],
      [{ type: 'patient_confirmed_speech', text: '乗っ取り', origin: 'typed' }],
      [{ type: 'patient_polish_request', requestId: 'x', text: '乗っ取り' }],
    ])('席のない接続の %j を断る', async (message) => {
      const models = scriptedModels();
      await listen(models);
      const call = await openCall();
      const stranger = await connect();

      stranger.send(message);

      expect((await stranger.waitFor('call_error')).code).toBe('not_in_call');
      await flush(call);
      expect(call.patient.all('call_closed')).toEqual([]);
      expect(call.hospital.all('call_closed')).toEqual([]);
      expect(call.hospital.all('patient_speech')).toEqual([]);
      expect(models.generateContent).not.toHaveBeenCalled();
    });

    it('席のない接続の音声は認識に渡さない', async () => {
      await listen();
      const call = await openCall();
      const stranger = await connect();
      call.hospital.send({ type: 'hospital_speaking_start' });
      await call.hospital.waitFor('hospital_speaking_start');

      stranger.sendBinary(Buffer.from([9]));
      call.hospital.sendBinary(Buffer.from([1]));

      await vi.waitFor(() => expect(call.stream().written).toHaveLength(1));
      expect([...call.stream().written[0]]).toEqual([1]);
    });

    it.each([
      ['hospital', { type: 'patient_confirmed_speech', text: 'なりすまし', origin: 'typed' }],
      ['hospital', { type: 'patient_polish_request', requestId: 'x', text: 'なりすまし' }],
      ['hospital', { type: 'patient_typing_notice' }],
      ['hospital', { type: 'patient_speaking_status', isSpeaking: true }],
      ['hospital', { type: 'reset_call' }],
      ['patient', { type: 'answer_call' }],
      ['patient', { type: 'hospital_speaking_start' }],
      ['patient', { type: 'hospital_speaking_stop' }],
      ['patient', { type: 'hospital_speech_end' }],
      ['patient', { type: 'leave_call' }],
    ] as const)('%s の席から相手のメッセージ %j を断る', async (role, message) => {
      await listen();
      const call = await openCall();

      call[role].send(message);

      expect((await call[role].waitFor('call_error')).code).toBe('not_allowed');
      await flush(call);
      expect(call.hospital.all('patient_speech')).toEqual([]);
      expect(call.patient.all('call_closed')).toEqual([]);
      expect(testServer.streams).toEqual([]);
    });

    it('患者の席から送った音声は認識に渡さない', async () => {
      await listen();
      const call = await openCall();
      call.hospital.send({ type: 'hospital_speaking_start' });
      await call.hospital.waitFor('hospital_speaking_start');

      call.patient.sendBinary(Buffer.from([9]));
      call.hospital.sendBinary(Buffer.from([1]));

      await vi.waitFor(() => expect(call.stream().written).toHaveLength(1));
      expect([...call.stream().written[0]]).toEqual([1]);
    });

    it('病院が通話を切っても、患者の記録は消えない', async () => {
      await listen(scriptedModels());
      const { patient, hospital } = await openCall();

      hospital.send({ type: 'end_call' });

      expect((await patient.waitFor('end_call')).appointment.title).toBe('内科 初診予約');
      expect(patient.all('call_closed')).toEqual([]);
    });

    it.each([
      ['応答の前の発話', { type: 'patient_confirmed_speech', text: 'まだ届かない', origin: 'typed' }],
      ['応答の前の録音', { type: 'hospital_speaking_start' }],
      ['応答の前の終了', { type: 'end_call' }],
    ])('%sを断る', async (_, message) => {
      await listen();
      const { patient, inviteCode } = await placeCall();
      const hospital = await connect();
      hospital.send({ type: 'join_call', inviteCode });
      await hospital.waitFor('call_joined');

      const sender = message.type === 'hospital_speaking_start' ? hospital : patient;
      sender.send(message);

      expect((await sender.waitFor('call_error')).code).toBe('not_allowed');
      expect(hospital.all('patient_speech')).toEqual([]);
      expect(testServer.streams).toEqual([]);
    });

    it('二重の応答は受け付けず、あいさつを繰り返さない', async () => {
      await listen();
      const { hospital } = await openCall();

      hospital.send({ type: 'answer_call' });

      expect((await hospital.waitFor('call_error')).code).toBe('not_allowed');
      expect(hospital.all('answer_call')).toHaveLength(1);
    });

    it('二重の通話終了ではAIを1回しか呼ばない', async () => {
      const { models, resolvers } = heldModels();
      await listen(models);
      const { patient, hospital } = await openCall();

      patient.send({ type: 'end_call' });
      await hospital.waitFor('call_ending');
      patient.send({ type: 'end_call' });
      hospital.send({ type: 'end_call' });
      await hospital.waitFor('call_error');
      await patient.waitFor('call_error');

      expect(resolvers).toHaveLength(1);
      resolvers[0](jsonReply(APPOINTMENT));
      await patient.waitFor('end_call');
    });

    it('終わった通話には発話を送れない', async () => {
      await listen(scriptedModels());
      const { patient, hospital } = await openCall();
      patient.send({ type: 'end_call' });
      await patient.waitFor('end_call');

      patient.send({ type: 'patient_confirmed_speech', text: '遅い発話', origin: 'typed' });

      expect((await patient.waitFor('call_error')).code).toBe('not_allowed');
      expect(hospital.all('patient_speech')).toEqual([]);
    });

    it.each(['constructor', '__proto__', 'toString', 'patient_send', 'force_finalize'])(
      '未知の種類 %s を処理しない',
      async (type) => {
        await listen();
        const { patient } = await openCall();

        patient.send({ type, text: '読み上げない' });

        expect((await patient.waitFor('call_error')).code).toBe('invalid_message');
        expect(warnSpy.mock.calls.flat().join('\n')).not.toContain('ws_message_failed');
      },
    );

    it.each(['壊れたJSON', 'null', '[]', '{"type":1}'])('読めないメッセージ %s を断る', async (text) => {
      await listen();
      const client = await connect();

      client.sendText(text);

      expect((await client.waitFor('call_error')).code).toBe('invalid_message');
    });
  });

  describe('切断と再接続', () => {
    const fastGrace = { limits: { reconnectGraceMs: 30 } };

    it('切断を相手に知らせ、戻ると状態を渡す', async () => {
      await listen();
      const { patient, hospital } = await openCall();
      const { seatToken } = patient.all('call_joined')[0];
      patient.send({ type: 'patient_confirmed_speech', text: '切断前の発話', origin: 'typed' });
      await hospital.waitFor('patient_speech');

      patient.terminate();
      expect((await hospital.waitFor('peer_status')).connected).toBe(false);

      const returning = await connect();
      returning.send({ type: 'join_call', seatToken });
      const joined = await returning.waitFor('call_joined');

      expect(joined.snapshot.phase).toBe('connected');
      expect(joined.snapshot.peerConnected).toBe(true);
      expect(joined.snapshot.turns.map((turn) => turn.text)).toContain('切断前の発話');
      expect((await hospital.waitFor('peer_status', 2)).connected).toBe(true);
    });

    it('切断中に届かなかった発話を再接続で受け取れる', async () => {
      await listen(scriptedModels());
      const call = await openCall();
      const { hospital, patient } = call;
      const { seatToken } = hospital.all('call_joined')[0];

      hospital.terminate();
      await patient.waitFor('peer_status', 2);
      patient.send({ type: 'patient_confirmed_speech', text: '切断中の発話', origin: 'typed' });
      await patient.waitFor('patient_speech');

      const returning = await connect();
      returning.send({ type: 'join_call', seatToken });
      const joined = await returning.waitFor('call_joined');

      const missed = joined.snapshot.turns.at(-1)!;
      expect(missed).toMatchObject({ sender: '患者', text: '切断中の発話', origin: 'typed' });
      expect(missed.seq).toBeGreaterThan(joined.snapshot.turns[0].seq);
    });

    it('患者の再接続で候補と生成中の状態を取り戻す', async () => {
      const { models, resolvers } = heldModels();
      await listen(models);
      const call = await openCall();
      const { seatToken } = call.patient.all('call_joined')[0];

      await hospitalSays(call, '質問です');
      await vi.waitFor(() => expect(resolvers).toHaveLength(1));

      call.patient.terminate();
      await call.hospital.waitFor('peer_status');
      const returning = await connect();
      returning.send({ type: 'join_call', seatToken });
      const joined = await returning.waitFor('call_joined');
      expect(joined.snapshot.isGeneratingSuggestions).toBe(true);

      resolvers[0](jsonReply(THREE_SUGGESTIONS));
      expect((await returning.waitFor('suggestions')).suggestions).toEqual(THREE_SUGGESTIONS.suggestions);

      returning.close();
      await returning.closed;
      const again = await connect();
      again.send({ type: 'join_call', seatToken });
      expect((await again.waitFor('call_joined')).snapshot.suggestions?.suggestions).toEqual(
        THREE_SUGGESTIONS.suggestions,
      );
    });

    it('病院の席のスナップショットに候補と予定を入れない', async () => {
      await listen(scriptedModels());
      const call = await openCall();
      const { seatToken } = call.hospital.all('call_joined')[0];
      await hospitalSays(call, '質問です');
      await call.patient.waitFor('suggestions');
      call.hospital.close();
      await call.hospital.closed;

      const middle = await connect();
      middle.send({ type: 'join_call', seatToken });
      const inCall = await middle.waitFor('call_joined');
      expect(inCall.snapshot.suggestions).toBeNull();
      expect(inCall.snapshot.isGeneratingSuggestions).toBe(false);

      call.patient.send({ type: 'end_call' });
      await call.patient.waitFor('end_call');
      middle.close();
      await middle.closed;

      const returning = await connect();
      returning.send({ type: 'join_call', seatToken });
      const ended = await returning.waitFor('call_joined');
      expect(ended.snapshot.phase).toBe('ended');
      expect(ended.snapshot.appointment).toBeNull();
    });

    it('通話が終わった後の再接続で、患者は予定を受け取れる', async () => {
      await listen(scriptedModels());
      const { patient } = await openCall();
      const { seatToken } = patient.all('call_joined')[0];
      patient.send({ type: 'end_call' });
      await patient.waitFor('end_call');
      patient.close();
      await patient.closed;

      const returning = await connect();
      returning.send({ type: 'join_call', seatToken });
      const { snapshot } = await returning.waitFor('call_joined');

      expect(snapshot.phase).toBe('ended');
      expect(snapshot.appointment?.appointment.date).toBe('2026-11-12');
    });

    it('発信中の再接続で、患者は招待を受け取れる', async () => {
      await listen();
      const { patient, joined, inviteCode } = await placeCall();
      patient.close();
      await patient.closed;

      const returning = await connect();
      returning.send({ type: 'join_call', seatToken: joined.seatToken });

      expect((await returning.waitFor('call_joined')).snapshot.invite?.code).toBe(inviteCode);
    });

    it('録音中に病院が切断したら、認識を止めて患者の入力を戻す', async () => {
      await listen(scriptedModels());
      const call = await openCall();
      const { hospital, patient, stream } = call;
      hospital.send({ type: 'hospital_speaking_start' });
      await patient.waitFor('hospital_speaking_start');
      const recording = stream();
      recording.speak('途中までの文');
      await patient.waitFor('transcript_interim');

      hospital.terminate();

      await patient.waitFor('hospital_speaking_stop');
      expect(recording.writable).toBe(false);
      expect(patient.all('transcript_final')).toEqual([]);
    });

    it('入力中通知の間に患者が切断したら、病院の録音を止めたままにしない', async () => {
      await listen();
      const { patient, hospital } = await openCall();
      patient.send({ type: 'patient_speaking_status', isSpeaking: true });
      await hospital.waitFor('patient_speaking_status');

      patient.terminate();

      const message = await hospital.waitFor('patient_speaking_status', 2);
      expect(message.isSpeaking).toBe(false);
    });

    it('同じ席に新しい接続が入ると古い接続を閉じ、相手には切断を知らせない', async () => {
      await listen();
      const { patient, hospital } = await openCall();
      const { seatToken } = patient.all('call_joined')[0];
      const peerStatusBefore = hospital.all('peer_status').length;

      const replacement = await connect();
      replacement.send({ type: 'join_call', seatToken });
      await replacement.waitFor('call_joined');

      expect(await patient.closed).toBe(CLOSE_CODE_SEAT_TAKEN);
      await settle();
      expect(hospital.all('peer_status')).toHaveLength(peerStatusBefore);

      replacement.send({ type: 'patient_confirmed_speech', text: '新しい接続', origin: 'typed' });
      expect((await hospital.waitFor('patient_speech')).text).toBe('新しい接続');
    });

    it('追い出された接続の後始末が、新しい接続を席から外さない', async () => {
      await listen();
      const { patient, hospital } = await openCall();
      const { seatToken } = patient.all('call_joined')[0];
      const replacement = await connect();
      replacement.send({ type: 'join_call', seatToken });
      await replacement.waitFor('call_joined');
      await patient.closed;

      hospital.send({ type: 'hospital_speaking_start' });

      expect(await replacement.waitFor('hospital_speaking_start')).toBeDefined();
    });

    it('録音中に同じ席へ入り直したら、前の録音を止める', async () => {
      await listen();
      const { patient, hospital, stream } = await openCall();
      const { seatToken } = hospital.all('call_joined')[0];
      hospital.send({ type: 'hospital_speaking_start' });
      await patient.waitFor('hospital_speaking_start');
      const recording = stream();

      const replacement = await connect();
      replacement.send({ type: 'join_call', seatToken });
      const { snapshot } = await replacement.waitFor('call_joined');

      expect(snapshot.isHospitalSpeaking).toBe(false);
      expect(recording.writable).toBe(false);
      await patient.waitFor('hospital_speaking_stop');
    });

    it('両方が戻らなければ、猶予の後に通話を閉じて席を無効にする', async () => {
      await listen(null, fastGrace);
      const { patient, hospital } = await openCall();
      const { seatToken } = patient.all('call_joined')[0];

      patient.terminate();
      hospital.terminate();
      await vi.waitFor(() =>
        expect(logSpy.mock.calls.flat().join('\n')).toContain('"reason":"abandoned"'),
      );

      const returning = await connect();
      returning.send({ type: 'join_call', seatToken });
      expect((await returning.waitFor('call_error')).code).toBe('call_not_found');
    });

    it('猶予の間に戻れば通話は続く', async () => {
      await listen(null, { limits: { reconnectGraceMs: 80 } });
      const { patient, hospital } = await openCall();
      const { seatToken } = patient.all('call_joined')[0];

      patient.terminate();
      hospital.terminate();
      await patient.closed;
      await hospital.closed;
      await settle();

      const returning = await connect();
      returning.send({ type: 'join_call', seatToken });
      await returning.waitFor('call_joined');
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(returning.all('call_closed')).toEqual([]);
    });

    it('通話に入らない接続は待機時間の後に閉じ、通話中の接続は閉じない', async () => {
      await listen(null, { limits: { heartbeatIntervalMs: 40, idleConnectionMs: 80 } });
      const { patient, hospital } = await openCall();
      const idle = await connect();

      expect(await idle.closed).toBe(CLOSE_CODE_IDLE);
      expect(await raceClose(patient)).toBe('still open');
      expect(await raceClose(hospital)).toBe('still open');
    });

    it('通話が閉じて席がなくなった接続も、待機時間の後に閉じる', async () => {
      await listen(null, { limits: { heartbeatIntervalMs: 40, idleConnectionMs: 80 } });
      const { patient, hospital } = await openCall();

      patient.send({ type: 'reset_call' });
      await hospital.waitFor('call_closed');

      expect(await patient.closed).toBe(CLOSE_CODE_IDLE);
      expect(await hospital.closed).toBe(CLOSE_CODE_IDLE);
    });

    it('通話中に片方だけが切断しても、通話は閉じない', async () => {
      await listen(null, fastGrace);
      const { patient, hospital } = await openCall();

      patient.terminate();
      await hospital.waitFor('peer_status');
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(hospital.all('call_closed')).toEqual([]);
    });

    it('発信中に患者が戻らなければ、着信を止める', async () => {
      await listen(null, fastGrace);
      const { patient, inviteCode } = await placeCall();
      const hospital = await connect();
      hospital.send({ type: 'join_call', inviteCode });
      await hospital.waitFor('call_joined');

      patient.terminate();

      expect((await hospital.waitFor('call_closed')).reason).toBe('abandoned');
    });

    it('発信中に切断した患者を待つ間に応答されたら、通話を閉じない', async () => {
      await listen(null, { limits: { reconnectGraceMs: 40 } });
      const { patient, inviteCode } = await placeCall();
      const hospital = await connect();
      hospital.send({ type: 'join_call', inviteCode });
      await hospital.waitFor('call_joined');
      patient.terminate();
      await hospital.waitFor('peer_status');

      hospital.send({ type: 'answer_call' });
      await hospital.waitFor('answer_call');
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(hospital.all('call_closed')).toEqual([]);
    });

    it('招待の期限が切れたら通話を閉じ、コードを無効にする', async () => {
      await listen(null, { limits: { inviteTtlMs: 30 } });
      const { patient, inviteCode } = await placeCall();

      expect((await patient.waitFor('call_closed')).reason).toBe('invite_expired');

      const stranger = await connect();
      stranger.send({ type: 'join_call', inviteCode });
      expect((await stranger.waitFor('call_error')).code).toBe('invalid_invite');
    });

    it('応答すると招待の期限では閉じない', async () => {
      await listen(null, { limits: { inviteTtlMs: 40 } });
      const { patient } = await openCall();

      await new Promise((resolve) => setTimeout(resolve, 70));

      expect(patient.all('call_closed')).toEqual([]);
    });

    it('通話の上限時間で閉じ、録音も止める', async () => {
      await listen(null, { limits: { maxCallDurationMs: 40 } });
      const { patient, hospital, stream } = await openCall();
      hospital.send({ type: 'hospital_speaking_start' });
      await hospital.waitFor('hospital_speaking_start');
      const recording = stream();

      expect((await patient.waitFor('call_closed')).reason).toBe('time_limit');
      expect((await hospital.waitFor('call_closed')).reason).toBe('time_limit');
      expect(recording.writable).toBe(false);
    });

    it('通話が終わった後は保存期間で記録を消す', async () => {
      await listen(scriptedModels(), { limits: { endedRetentionMs: 30 } });
      const { patient } = await openCall();
      const { seatToken } = patient.all('call_joined')[0];
      patient.send({ type: 'end_call' });
      await patient.waitFor('end_call');

      expect((await patient.waitFor('call_closed')).reason).toBe('retention_expired');

      const returning = await connect();
      returning.send({ type: 'join_call', seatToken });
      expect((await returning.waitFor('call_error')).code).toBe('call_not_found');
    });

    it('閉じた後は同じ接続で次の通話を始められる', async () => {
      await listen();
      const { patient, hospital } = await openCall();
      patient.send({ type: 'reset_call' });
      await hospital.waitFor('call_closed');

      patient.send({ type: 'start_call', intent: '次の用件' });

      const joined = await patient.waitFor('call_joined', 2);
      expect(joined.snapshot.phase).toBe('ringing');
      expect(joined.seatToken).not.toBe(patient.all('call_joined')[0].seatToken);
      expect(joined.snapshot.turns).toEqual([]);
    });

    it('病院が席を手放すと、そのトークンでは戻れない', async () => {
      await listen();
      const { patient, hospital } = await openCall();
      const { seatToken } = hospital.all('call_joined')[0];

      hospital.send({ type: 'leave_call' });
      expect((await patient.waitFor('peer_status', 2)).connected).toBe(false);

      const returning = await connect();
      returning.send({ type: 'join_call', seatToken });
      expect((await returning.waitFor('call_error')).code).toBe('call_not_found');
    });

    it('応答せずに退出しても、招待で別の人が入れる', async () => {
      await listen();
      const { inviteCode } = await placeCall();
      const first = await connect();
      first.send({ type: 'join_call', inviteCode });
      await first.waitFor('call_joined');

      first.send({ type: 'leave_call' });
      await settle();

      const second = await connect();
      second.send({ type: 'join_call', inviteCode });
      expect((await second.waitFor('call_joined')).role).toBe('hospital');
    });

    it('応答のない接続を切り、相手に切断を知らせる', async () => {
      await listen(null, { limits: { heartbeatIntervalMs: 20 } });
      const { patient, inviteCode } = await placeCall();
      const silent = await testServer.connect({ autoPong: false });
      silent.send({ type: 'join_call', inviteCode });
      await silent.waitFor('call_joined');

      await vi.waitFor(() => expect(patient.all('peer_status').at(-1)?.connected).toBe(false));
      expect(await silent.closed).toBe(1006);
    });
  });

  describe('古い非同期処理', () => {
    it('リセットの後に届いた返答候補を捨てる', async () => {
      const { models, resolvers } = heldModels();
      await listen(models);
      const call = await openCall();
      await hospitalSays(call, '質問です');
      await vi.waitFor(() => expect(resolvers).toHaveLength(1));

      call.patient.send({ type: 'reset_call' });
      await call.hospital.waitFor('call_closed');
      resolvers[0](jsonReply(THREE_SUGGESTIONS));
      await settle();

      expect(call.patient.all('suggestions')).toEqual([]);
      expect(call.hospital.all('suggestions')).toEqual([]);
    });

    it('リセットの後に届いたAIの整形案を捨てる', async () => {
      const { models, resolvers } = heldModels();
      await listen(models);
      const { patient, hospital } = await openCall();
      patient.send({ type: 'patient_polish_request', requestId: 'r1', text: 'あした' });
      await vi.waitFor(() => expect(resolvers).toHaveLength(1));

      patient.send({ type: 'reset_call' });
      await hospital.waitFor('call_closed');
      resolvers[0](jsonReply({ polished: '古い案' }));
      await settle();

      expect(patient.all('patient_polish_result')).toEqual([]);
    });

    it('前の通話の読み取りが終わっても、次の通話に結果が混ざらない', async () => {
      const { models, resolvers } = heldModels();
      await listen(models);
      const { patient, hospital } = await openCall('前の用件');
      patient.send({ type: 'end_call' });
      await hospital.waitFor('call_ending');
      await vi.waitFor(() => expect(resolvers).toHaveLength(1));

      patient.send({ type: 'reset_call' });
      await hospital.waitFor('call_closed');
      patient.send({ type: 'start_call', intent: '次の用件' });
      await patient.waitFor('call_joined', 2);

      resolvers[0](jsonReply(APPOINTMENT));
      await settle();

      expect(patient.all('end_call')).toEqual([]);
      expect(patient.all('call_joined')[1].snapshot.phase).toBe('ringing');
    });

    it('通話の終了後に届いた返答候補を捨てる', async () => {
      const { models, resolvers } = heldModels();
      await listen(models);
      const call = await openCall();
      await hospitalSays(call, '質問です');
      await vi.waitFor(() => expect(resolvers).toHaveLength(1));

      call.patient.send({ type: 'end_call' });
      await call.hospital.waitFor('call_ending');
      await vi.waitFor(() => expect(resolvers).toHaveLength(2));
      resolvers[0](jsonReply(THREE_SUGGESTIONS));
      resolvers[1](jsonReply(APPOINTMENT));
      await call.patient.waitFor('end_call');

      expect(call.patient.all('suggestions')).toEqual([]);
    });

    it('閉じた通話の録音は、遅れて届いた認識結果を無視する', async () => {
      await listen();
      const { patient, hospital, stream } = await openCall();
      hospital.send({ type: 'hospital_speaking_start' });
      await hospital.waitFor('hospital_speaking_start');
      const recording = stream();

      patient.send({ type: 'reset_call' });
      await hospital.waitFor('call_closed');
      recording.speak('遅れた認識');
      expect(() => recording.emit('error', new Error('late failure'))).not.toThrow();
      await settle();

      expect(patient.all('transcript_interim')).toEqual([]);
      expect(hospital.all('transcript_interim')).toEqual([]);
    });
  });

  describe('公開URLを守る', () => {
    const rejectedStatus = (url: string, headers: Record<string, string> = {}) =>
      new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(url, { headers });
        socket.once('unexpected-response', (_, response) => resolve(response.statusCode ?? 0));
        socket.once('error', () => resolve(0));
        socket.once('open', () => {
          socket.close();
          reject(new Error('connection was accepted'));
        });
      });

    it('許可していないOriginの接続を断る', async () => {
      await listen(null, { allowedOrigins: ['http://localhost:3000'] });

      expect(await rejectedStatus(testServer.url, { Origin: 'https://evil.example' })).toBe(403);
    });

    it('許可したOriginと同一オリジンの接続を通す', async () => {
      await listen(null, { allowedOrigins: ['http://localhost:3000'] });

      const allowed = await connectWithOrigin(testServer.url, 'http://localhost:3000');
      const sameOrigin = await connectWithOrigin(
        testServer.url,
        testServer.url.replace('ws://', 'http://').replace('/ws/call', ''),
      );

      expect(allowed).toBe('open');
      expect(sameOrigin).toBe('open');
    });

    it('別のパスへの接続を断る', async () => {
      await listen();

      expect(await rejectedStatus(testServer.url.replace('/ws/call', '/other'))).toBe(404);
    });

    it('上限を超えた接続を断る', async () => {
      await listen(null, { limits: { maxConnections: 1 } });
      await connect();

      expect(await rejectedStatus(testServer.url)).toBe(503);
    });

    it('上限を超えた発信を断り、空きが出たら受け付ける', async () => {
      await listen(null, { limits: { maxActiveCalls: 1 } });
      const { patient } = await placeCall();
      const second = await connect();

      second.send({ type: 'start_call', intent: '二人目' });
      expect((await second.waitFor('call_error')).code).toBe('server_busy');

      patient.send({ type: 'reset_call' });
      await patient.waitFor('call_closed');
      second.send({ type: 'start_call', intent: '二人目' });
      expect(await second.waitFor('call_joined')).toBeDefined();
    });

    it('短時間に送りすぎた接続を閉じる', async () => {
      await listen(null, { limits: { maxMessagesPerMinute: 3 } });
      const client = await connect();

      for (let index = 0; index < 5; index += 1) client.send({ type: 'unknown' });

      expect(await client.closed).toBe(1008);
      const warnings = warnSpy.mock.calls.flat().join('\n').match(/ws_rate_limited/g);
      expect(warnings).toHaveLength(1);
    });

    it('音声はメッセージの上限に数えない', async () => {
      await listen(null, { limits: { maxMessagesPerMinute: 8 } });
      const { hospital, stream } = await openCall();
      hospital.send({ type: 'hospital_speaking_start' });
      await hospital.waitFor('hospital_speaking_start');

      for (let index = 0; index < 20; index += 1) hospital.sendBinary(Buffer.from([index]));

      await vi.waitFor(() => expect(stream().written).toHaveLength(20));
    });

    it('大きすぎるメッセージで切っても、別の通話は続く', async () => {
      await listen();
      const call = await openCall();
      const attacker = await connect();

      attacker.sendBinary(Buffer.alloc(65 * 1024));

      expect(await attacker.closed).toBe(1009);
      call.patient.send({ type: 'patient_confirmed_speech', text: '続いている', origin: 'typed' });
      expect((await call.hospital.waitFor('patient_speech')).text).toBe('続いている');
    });

    it('壊れたフレームでもサーバーは落ちない', async () => {
      await listen();
      const call = await openCall();
      const attacker = await connect();

      attacker.writeRaw(Buffer.from([0xff, 0xff, 0xff, 0xff]));

      await attacker.closed;
      await vi.waitFor(() =>
        expect(warnSpy.mock.calls.flat().join('\n')).toContain('ws_socket_error'),
      );
      call.patient.send({ type: 'patient_confirmed_speech', text: '続いている', origin: 'typed' });
      expect((await call.hospital.waitFor('patient_speech')).text).toBe('続いている');
    });

    it('AIの整形は1通話の上限を超えると呼ばない', async () => {
      const models = scriptedModels();
      await listen(models, { limits: { maxPolishRequestsPerCall: 1 } });
      const { patient } = await openCall();

      patient.send({ type: 'patient_polish_request', requestId: 'r1', text: 'はい' });
      await patient.waitFor('patient_polish_result');
      patient.send({ type: 'patient_polish_request', requestId: 'r2', text: 'いいえ' });

      expect(await patient.waitFor('patient_polish_result', 2)).toMatchObject({
        requestId: 'r2',
        polished: null,
        ai: { source: 'fallback', reason: 'rate_limited' },
      });
      expect(models.generateContent).toHaveBeenCalledTimes(1);
    });

    it('トークンと招待コードをログに出さない', async () => {
      await listen(scriptedModels());
      const { patient, joined, inviteCode } = await placeCall();
      const hospital = await connect();
      hospital.send({ type: 'join_call', inviteCode });
      const { seatToken } = await hospital.waitFor('call_joined');
      hospital.send({ type: 'answer_call' });
      await patient.waitFor('answer_call');
      patient.send({ type: 'reset_call' });
      await hospital.waitFor('call_closed');

      const output = [...logSpy.mock.calls, ...warnSpy.mock.calls].flat().join('\n');
      expect(output).toContain('call_created');
      expect(output).not.toContain(joined.seatToken);
      expect(output).not.toContain(seatToken);
      expect(output).not.toContain(inviteCode);
    });
  });
});

function connectWithOrigin(url: string, origin: string) {
  return new Promise<string>((resolve) => {
    const socket = new WebSocket(url, { headers: { Origin: origin } });
    socket.once('open', () => {
      socket.close();
      resolve('open');
    });
    socket.once('unexpected-response', (_, response) => resolve(String(response.statusCode)));
    socket.once('error', () => resolve('error'));
  });
}

describe('isAllowedOrigin', () => {
  const allowed = ['http://localhost:3000'];

  it.each([
    ['ブラウザ以外（Originなし）', undefined, 'example.run.app', true],
    ['許可リストのOrigin', 'http://localhost:3000', 'localhost:8080', true],
    ['同一オリジン', 'https://example.run.app', 'example.run.app', true],
    ['別のサイト', 'https://evil.example', 'example.run.app', false],
    ['ホストの一部だけ一致', 'https://example.run.app.evil.example', 'example.run.app', false],
    ['ポート違い', 'https://example.run.app:8443', 'example.run.app', false],
    ['壊れたOrigin', 'not a url', 'example.run.app', false],
    ['null（サンドボックスのiframe）', 'null', 'example.run.app', false],
  ])('%s', (_, origin, host, expected) => {
    expect(isAllowedOrigin(origin, host, allowed)).toBe(expected);
  });
});

describe('resolveAllowedOrigins', () => {
  it('開発時はNext.jsの開発サーバーを許可する', () => {
    expect(resolveAllowedOrigins({} as NodeJS.ProcessEnv)).toEqual([
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ]);
  });

  it('本番では開発用のOriginを許可しない', () => {
    expect(resolveAllowedOrigins({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('指定があればそれを使う', () => {
    expect(
      resolveAllowedOrigins({
        NODE_ENV: 'production',
        ALLOWED_ORIGINS: 'https://a.example, https://b.example',
      } as NodeJS.ProcessEnv),
    ).toEqual(['https://a.example', 'https://b.example']);
  });
});
