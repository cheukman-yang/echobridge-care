import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_REPLAYS_PER_TURN, TYPING_NOTICE_TEXT, buildGreeting } from '@/lib/callProtocol';
import type { SynthesisOutcome } from '../../server/speechSynthesizer';
import { CallTestServer, DEFAULT_INTENT } from '../helpers/callTestServer';
import type { TestClient } from '../helpers/callTestServer';
import { FakeSynthesizer } from '../helpers/fakeSynthesizer';

/** 待っている間の結果を、テストの中で返す。 */
function deferred() {
  let resolve!: (outcome: SynthesisOutcome) => void;
  const promise = new Promise<SynthesisOutcome>((done) => (resolve = done));
  return { promise, resolve };
}

const OK = (text: string): SynthesisOutcome => ({
  ok: true,
  cached: false,
  audio: FakeSynthesizer.audioFor(text),
  mimeType: 'audio/mpeg',
});

describe('サーバーでの音声合成と、相手への配信', () => {
  let testServer: CallTestServer;
  let tts: FakeSynthesizer;
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(String(line)));
    vi.spyOn(console, 'warn').mockImplementation((line: string) => logs.push(String(line)));
    testServer = new CallTestServer();
    tts = new FakeSynthesizer();
  });

  afterEach(() => testServer.close());

  async function speak(patient: TestClient, text: string) {
    patient.send({ type: 'patient_confirmed_speech', text, origin: 'typed' });
  }

  it('接続した画面に、音声合成を使えるかを知らせ、変わったら知らせ直す', async () => {
    await testServer.listen(null, undefined, undefined, tts);
    const client = await testServer.connect();
    expect((await client.waitFor('tts_status')).available).toBe(true);

    tts.setAvailable(false);

    expect((await client.waitFor('tts_status', 2)).available).toBe(false);
  });

  it('音声合成を渡さないサーバーは、使えないと知らせる', async () => {
    await testServer.listen(null);
    const client = await testServer.connect();
    expect((await client.waitFor('tts_status')).available).toBe(false);
  });

  it('本人の文は先に文として届け、音声は相手の席にだけ後から送る', async () => {
    await testServer.listen(null, undefined, undefined, tts);
    const call = await testServer.openCall();

    await speak(call.patient, '明日の午後に伺います。');
    const speech = await call.hospital.waitFor('patient_speech');
    const audio = await call.hospital.waitFor('speech_audio', 2);
    const synthesis = await call.patient.waitFor('speech_synthesis', 2);

    expect(audio).toEqual({
      type: 'speech_audio',
      seq: speech.seq,
      audio: FakeSynthesizer.audioFor('明日の午後に伺います。'),
      mimeType: 'audio/mpeg',
    });
    expect(synthesis).toEqual({ type: 'speech_synthesis', seq: speech.seq, status: 'ready' });
    // 音声は本人の画面には送らない。文は書き換えない。
    expect(call.patient.all('speech_audio')).toEqual([]);
    expect(speech.text).toBe('明日の午後に伺います。');
    const order = call.hospital.messages.map((message) => message.type);
    expect(order.lastIndexOf('patient_speech')).toBeLessThan(order.lastIndexOf('speech_audio'));
  });

  it('あいさつは相手が着信画面を開いた時点で作り始め、応答したらすぐ送る', async () => {
    const greeting = deferred();
    tts.respond = () => greeting.promise;
    await testServer.listen(null, undefined, undefined, tts);
    const { patient, inviteCode } = await testServer.placeCall();
    expect(tts.calls).toEqual([]);

    const hospital = await testServer.connect();
    hospital.send({ type: 'join_call', inviteCode });
    await hospital.waitFor('call_joined');
    expect(tts.calls).toEqual([{ text: buildGreeting(DEFAULT_INTENT, 'medical'), voice: 'female' }]);

    greeting.resolve(OK('greeting'));
    hospital.send({ type: 'answer_call' });
    const answer = await hospital.waitFor('answer_call');
    const audio = await hospital.waitFor('speech_audio');

    expect(audio.seq).toBe(answer.seq);
    expect(tts.calls).toHaveLength(1);
    expect((await patient.waitFor('speech_synthesis')).status).toBe('ready');
  });

  it('発信のときに選んだ声で合成する', async () => {
    await testServer.listen(null, undefined, undefined, tts);
    await testServer.openCall(DEFAULT_INTENT, { voice: 'male' });
    expect(tts.calls.map((call) => call.voice)).toEqual(['male']);
  });

  it('知らない声は発信を断る', async () => {
    await testServer.listen(null, undefined, undefined, tts);
    const patient = await testServer.connect();
    patient.send({ type: 'start_call', intent: DEFAULT_INTENT, voice: 'robot' });
    expect((await patient.waitFor('call_error')).code).toBe('invalid_message');
  });

  it('作れなかったら、相手には端末の声で読むよう、本人には理由を知らせる', async () => {
    await testServer.listen(null, undefined, undefined, tts);
    const call = await testServer.openCall();
    tts.respond = async () => ({ ok: false, reason: 'timeout' });

    await speak(call.patient, '本人の文');
    const failed = await call.hospital.waitFor('speech_audio_failed');
    const synthesis = await call.patient.waitFor('speech_synthesis', 2);

    expect(failed.reason).toBe('timeout');
    expect(synthesis).toMatchObject({ status: 'failed', reason: 'timeout' });
  });

  it('使えないときは合成を呼ばず、すぐ失敗を返す', async () => {
    tts.available = false;
    await testServer.listen(null, undefined, undefined, tts);
    const call = await testServer.openCall();

    await speak(call.patient, '本人の文');

    expect((await call.hospital.waitFor('speech_audio_failed', 2)).reason).toBe('unavailable');
    expect(tts.calls).toEqual([]);
  });

  it('1通話の文字数の上限を超えた分は合成しない', async () => {
    const greetingLength = buildGreeting('予約', 'medical').length;
    await testServer.listen(null, undefined, { limits: { maxSpeechCharsPerCall: greetingLength + 10 } }, tts);
    const call = await testServer.openCall('予約');
    expect((await call.patient.waitFor('speech_synthesis')).status).toBe('ready');
    const before = tts.calls.length;

    await speak(call.patient, 'あ'.repeat(11));
    await call.hospital.waitFor('speech_audio_failed');

    expect((await call.patient.waitFor('speech_synthesis', 2)).reason).toBe('quota');
    expect(tts.calls).toHaveLength(before);
  });

  it('再接続した相手が求めたら、作り終えた音声を作り直さずに送り直す', async () => {
    await testServer.listen(null, undefined, undefined, tts);
    const call = await testServer.openCall();
    await speak(call.patient, '切断中に送った文');
    const speech = await call.hospital.waitFor('patient_speech');
    await call.hospital.waitFor('speech_audio', 2);
    const calls = tts.calls.length;

    call.hospital.send({ type: 'speech_audio_request', seq: speech.seq });
    const resent = await call.hospital.waitFor('speech_audio', 3);

    expect(resent.seq).toBe(speech.seq);
    expect(tts.calls).toHaveLength(calls);
    // 本人には二度知らせない。
    expect(call.patient.all('speech_synthesis')).toHaveLength(2);
  });

  it('失敗していた音声は、求められたら一度だけ作り直す', async () => {
    await testServer.listen(null, undefined, undefined, tts);
    const call = await testServer.openCall();
    tts.respond = async () => ({ ok: false, reason: 'error' });
    await speak(call.patient, '本人の文');
    const speech = await call.hospital.waitFor('patient_speech');
    await call.hospital.waitFor('speech_audio_failed');

    tts.respond = async (text) => OK(text);
    call.hospital.send({ type: 'speech_audio_request', seq: speech.seq });
    expect((await call.hospital.waitFor('speech_audio', 2)).seq).toBe(speech.seq);

    tts.respond = async () => ({ ok: false, reason: 'error' });
    const calls = tts.calls.length;
    call.hospital.send({ type: 'speech_audio_request', seq: speech.seq });
    await call.hospital.waitFor('speech_audio', 3);
    expect(tts.calls).toHaveLength(calls);
  });

  it('相手の発言の番号や存在しない番号の音声は求められない', async () => {
    await testServer.listen(null, undefined, undefined, tts);
    const call = await testServer.openCall();
    await testServer.hospitalSays(call, '受付の発言');
    const final = await call.hospital.waitFor('transcript_final');
    const calls = tts.calls.length;

    call.hospital.send({ type: 'speech_audio_request', seq: final.seq });
    call.hospital.send({ type: 'speech_audio_request', seq: 999 });
    await testServer.flush(call);

    expect(tts.calls).toHaveLength(calls);
    expect(call.hospital.all('speech_audio')).toHaveLength(1);
  });

  it('音声を求められるのは相手の席だけ', async () => {
    await testServer.listen(null, undefined, undefined, tts);
    const call = await testServer.openCall();
    call.patient.send({ type: 'speech_audio_request', seq: 1 });
    expect((await call.patient.waitFor('call_error')).code).toBe('not_allowed');
  });

  it('通話の終了の直後も、相手は読み残しの音声を受け取れる', async () => {
    await testServer.listen(null, undefined, undefined, tts);
    const call = await testServer.openCall();
    await speak(call.patient, '失礼します。');
    const speech = await call.hospital.waitFor('patient_speech');
    call.patient.send({ type: 'end_call' });
    await call.hospital.waitFor('call_ending');

    call.hospital.send({ type: 'speech_audio_request', seq: speech.seq });

    expect((await call.hospital.waitFor('speech_audio', 3)).seq).toBe(speech.seq);
  });

  describe('読み直し', () => {
    it('本人が頼むと、相手の席にだけ読み直しを送る。新しい発言にはしない', async () => {
      await testServer.listen(null, undefined, undefined, tts);
      const call = await testServer.openCall();
      await speak(call.patient, '本人の文');
      const speech = await call.hospital.waitFor('patient_speech');
      call.hospital.send({ type: 'speech_playback', seq: speech.seq, status: 'ended', engine: 'cloud' });
      await call.patient.waitFor('speech_playback');

      call.patient.send({ type: 'speech_replay_request', seq: speech.seq });
      expect(await call.hospital.waitFor('speech_replay')).toEqual({ type: 'speech_replay', seq: speech.seq });
      expect(call.patient.all('speech_replay')).toEqual([]);

      // 読み直しの報告は、終わった状態からでも受け付ける。
      call.hospital.send({ type: 'speech_playback', seq: speech.seq, status: 'started', engine: 'cloud' });
      expect(await call.patient.waitFor('speech_playback', 2)).toMatchObject({ status: 'started', engine: 'cloud' });
      expect(call.hospital.all('patient_speech')).toHaveLength(1);
    });

    it(`1文につき${MAX_REPLAYS_PER_TURN}回まで`, async () => {
      await testServer.listen(null, undefined, undefined, tts);
      const call = await testServer.openCall();
      await speak(call.patient, '本人の文');
      const speech = await call.hospital.waitFor('patient_speech');

      for (let i = 0; i < MAX_REPLAYS_PER_TURN + 1; i += 1) {
        call.patient.send({ type: 'speech_replay_request', seq: speech.seq });
      }

      expect((await call.patient.waitFor('call_error')).code).toBe('not_allowed');
      expect(call.hospital.all('speech_replay')).toHaveLength(MAX_REPLAYS_PER_TURN);
    });

    it('相手の発言は読み直せず、相手の席からは頼めない', async () => {
      await testServer.listen(null, undefined, undefined, tts);
      const call = await testServer.openCall();
      await testServer.hospitalSays(call, '受付の発言');
      const final = await call.hospital.waitFor('transcript_final');

      call.patient.send({ type: 'speech_replay_request', seq: final.seq });
      call.hospital.send({ type: 'speech_replay_request', seq: 1 });

      expect((await call.patient.waitFor('call_error')).code).toBe('not_allowed');
      expect((await call.hospital.waitFor('call_error')).code).toBe('not_allowed');
      expect(call.hospital.all('speech_replay')).toEqual([]);
    });
  });

  it('入力中の案内は、作り置きの音声があれば相手の席にだけ付けて送る', async () => {
    tts.cache.set(TYPING_NOTICE_TEXT, { audio: 'notice-audio', mimeType: 'audio/mpeg' });
    await testServer.listen(null, undefined, undefined, tts);
    const call = await testServer.openCall();

    call.patient.send({ type: 'patient_typing_notice' });

    expect(await call.hospital.waitFor('patient_typing_notice')).toEqual({
      type: 'patient_typing_notice',
      text: TYPING_NOTICE_TEXT,
      audio: 'notice-audio',
      mimeType: 'audio/mpeg',
    });
    expect(await call.patient.waitFor('patient_typing_notice')).toEqual({
      type: 'patient_typing_notice',
      text: TYPING_NOTICE_TEXT,
    });
  });

  it('作り置きがなければ待たずに文だけを送り、次のために作る', async () => {
    await testServer.listen(null, undefined, undefined, tts);
    const call = await testServer.openCall();
    const before = tts.calls.length;

    call.patient.send({ type: 'patient_typing_notice' });

    const notice = await call.hospital.waitFor('patient_typing_notice');
    expect(notice).not.toHaveProperty('audio');
    expect(tts.calls.slice(before)).toEqual([{ text: TYPING_NOTICE_TEXT, voice: 'female' }]);
  });

  it('相手の画面の報告（止められた・端末の声）を本人に届ける', async () => {
    await testServer.listen(null, undefined, undefined, tts);
    const call = await testServer.openCall();
    await speak(call.patient, '本人の文');
    const speech = await call.hospital.waitFor('patient_speech');

    call.hospital.send({ type: 'speech_playback', seq: speech.seq, status: 'blocked', engine: 'cloud' });
    call.hospital.send({ type: 'speech_playback', seq: speech.seq, status: 'ended', engine: 'device' });
    call.hospital.send({ type: 'speech_playback', seq: speech.seq, status: 'blocked', engine: 'cloud' });
    await testServer.flush(call);

    expect(call.patient.all('speech_playback').map(({ status, engine }) => [status, engine])).toEqual([
      ['blocked', 'cloud'],
      ['ended', 'device'],
    ]);
  });

  it('知らない声の出どころの報告は断る', async () => {
    await testServer.listen(null, undefined, undefined, tts);
    const call = await testServer.openCall();
    call.hospital.send({ type: 'speech_playback', seq: 1, status: 'ended', engine: 'robot' });
    expect((await call.hospital.waitFor('call_error')).code).toBe('invalid_message');
  });

  it('再接続のスナップショットに、合成と再生の結果を残す', async () => {
    await testServer.listen(null, undefined, undefined, tts);
    const call = await testServer.openCall();
    await speak(call.patient, '本人の文');
    const speech = await call.hospital.waitFor('patient_speech');
    await call.patient.waitFor('speech_synthesis', 2);
    call.hospital.send({ type: 'speech_playback', seq: speech.seq, status: 'ended', engine: 'cloud' });
    await call.patient.waitFor('speech_playback');
    const seatToken = (await call.patient.waitFor('call_joined')).seatToken;

    const again = await testServer.connect();
    again.send({ type: 'join_call', seatToken });
    const joined = await again.waitFor('call_joined');

    expect(joined.snapshot.turns.find((turn) => turn.seq === speech.seq)).toMatchObject({
      synthesis: 'ready',
      playback: 'ended',
      playbackEngine: 'cloud',
    });
  });

  it('通話に入っていない接続には、音声も合成の結果も届かない', async () => {
    await testServer.listen(null, undefined, undefined, tts);
    const stranger = await testServer.connect();
    const call = await testServer.openCall();
    await speak(call.patient, '秘密の返答');
    await call.hospital.waitFor('speech_audio', 2);
    await testServer.flush(call);

    expect(stranger.messages.map((message) => message.type)).toEqual(['ai_status', 'speech_status', 'tts_status']);
  });

  it('ログに本文と音声を出さない', async () => {
    await testServer.listen(null, undefined, undefined, tts);
    const call = await testServer.openCall('架空の用件ABC');
    await speak(call.patient, '架空の返答XYZ');
    await call.hospital.waitFor('speech_audio', 2);

    const joined = logs.join('\n');
    expect(joined).not.toContain('架空の用件ABC');
    expect(joined).not.toContain('架空の返答XYZ');
    expect(joined).not.toContain(FakeSynthesizer.audioFor('架空の返答XYZ'));
  });
});
