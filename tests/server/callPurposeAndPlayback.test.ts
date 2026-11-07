import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGreeting } from '@/lib/callProtocol';
import { MAX_PARTNER_NAME_LENGTH } from '@/lib/callPurpose';
import { CallTestServer } from '../helpers/callTestServer';
import { createFakeModels, jsonReply, sentContents } from '../helpers/fakeGemini';

const EMPTY_APPOINTMENT = {
  title: null,
  date: null,
  startTime: null,
  endTime: null,
  location: null,
  details: null,
};

describe('通話の目的と相手の名前', () => {
  let testServer: CallTestServer;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    testServer = new CallTestServer();
  });

  afterEach(() => testServer.close());

  it('目的と相手の名前を両方の画面に渡し、目的に合ったあいさつを読む', async () => {
    await testServer.listen(null);
    const intent = '土曜の待ち合わせを決めたいです';

    const { patient, joined, inviteCode } = await testServer.placeCall(intent, {
      purpose: 'general',
      partnerName: '  佐藤\nさん ',
    });
    const hospital = await testServer.connect();
    hospital.send({ type: 'join_call', inviteCode });
    const hospitalJoined = await hospital.waitFor('call_joined');
    hospital.send({ type: 'answer_call' });

    expect(joined.snapshot).toMatchObject({ purpose: 'general', partnerName: '佐藤 さん' });
    expect(hospitalJoined.snapshot).toMatchObject({ purpose: 'general', partnerName: '佐藤 さん' });
    expect((await patient.waitFor('answer_call')).text).toBe(buildGreeting(intent, 'general'));
  });

  it('目的を送らない発信は医療機関への連絡として扱う', async () => {
    await testServer.listen(null);

    const { joined } = await testServer.placeCall('内科の予約');

    expect(joined.snapshot).toMatchObject({ purpose: 'medical', partnerName: '' });
  });

  it.each([
    ['知らない目的', { purpose: 'shopping' }],
    ['長すぎる相手の名前', { partnerName: 'あ'.repeat(MAX_PARTNER_NAME_LENGTH + 1) }],
    ['文字列でない相手の名前', { partnerName: 42 }],
  ])('%sは発信を断る', async (_label, extra) => {
    await testServer.listen(null);
    const patient = await testServer.connect();

    patient.send({ type: 'start_call', intent: '用件', ...extra });

    expect((await patient.waitFor('call_error')).code).toBe('invalid_message');
    expect(patient.all('call_joined')).toHaveLength(0);
  });

  it('目的と相手の名前をAIに渡す', async () => {
    const models = createFakeModels(() => jsonReply(EMPTY_APPOINTMENT));
    await testServer.listen(models);
    const { patient } = await testServer.openCall('土曜の待ち合わせ', {
      purpose: 'general',
      partnerName: '佐藤さん',
    });

    patient.send({ type: 'end_call' });
    await patient.waitFor('end_call');

    const params = models.generateContent.mock.calls.at(-1)![0];
    expect(sentContents(params)).toContain('佐藤さん');
    expect(sentContents(params)).toContain('"話者":"本人"');
  });
});

describe('相手の端末での読み上げの報告', () => {
  let testServer: CallTestServer;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    testServer = new CallTestServer();
  });

  afterEach(() => testServer.close());

  async function callWithSpeech() {
    await testServer.listen(null);
    const call = await testServer.openCall();
    call.patient.send({ type: 'patient_confirmed_speech', text: '本人の文', origin: 'typed' });
    const { seq } = await call.hospital.waitFor('patient_speech');
    return { ...call, seq };
  }

  it('相手の画面の報告を本人にだけ届ける', async () => {
    const call = await callWithSpeech();

    call.hospital.send({ type: 'speech_playback', seq: call.seq, status: 'started' });
    call.hospital.send({ type: 'speech_playback', seq: call.seq, status: 'ended' });

    expect(await call.patient.waitFor('speech_playback', 2)).toEqual({
      type: 'speech_playback',
      seq: call.seq,
      status: 'ended',
    });
    await testServer.flush(call);
    expect(call.hospital.all('speech_playback')).toHaveLength(0);
  });

  it('再接続のスナップショットに読み上げの結果を残す', async () => {
    const call = await callWithSpeech();
    const { seatToken } = await call.patient.waitFor('call_joined');
    call.hospital.send({ type: 'speech_playback', seq: call.seq, status: 'failed' });
    await call.patient.waitFor('speech_playback');

    const again = await testServer.connect();
    again.send({ type: 'join_call', seatToken });
    const { snapshot } = await again.waitFor('call_joined');

    expect(snapshot.turns.find((turn) => turn.seq === call.seq)?.playback).toBe('failed');
  });

  it('読み終えた後に遅れて届いた開始の報告で、状態を戻さない', async () => {
    const call = await callWithSpeech();

    call.hospital.send({ type: 'speech_playback', seq: call.seq, status: 'ended' });
    call.hospital.send({ type: 'speech_playback', seq: call.seq, status: 'started' });
    await call.patient.waitFor('speech_playback');
    await testServer.flush(call);

    expect(call.patient.all('speech_playback').map(({ status }) => status)).toEqual(['ended']);
  });

  it('本人の発言でない番号と、存在しない番号は無視する', async () => {
    const call = await callWithSpeech();
    await testServer.hospitalSays(call, '相手の発言');
    const { seq: partnerSeq } = await call.patient.waitFor('transcript_final');

    call.hospital.send({ type: 'speech_playback', seq: partnerSeq, status: 'ended' });
    call.hospital.send({ type: 'speech_playback', seq: 999, status: 'ended' });
    await testServer.flush(call);

    expect(call.patient.all('speech_playback')).toHaveLength(0);
  });

  it('本人の画面からは報告できず、形式の違う報告は断る', async () => {
    const call = await callWithSpeech();

    call.patient.send({ type: 'speech_playback', seq: call.seq, status: 'ended' });
    call.hospital.send({ type: 'speech_playback', seq: call.seq, status: 'heard' });

    expect((await call.patient.waitFor('call_error')).code).toBe('not_allowed');
    expect((await call.hospital.waitFor('call_error')).code).toBe('invalid_message');
    expect(call.patient.all('speech_playback')).toHaveLength(0);
  });
});
