import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallTestServer } from '../helpers/callTestServer';
import type { OpenCall } from '../helpers/callTestServer';

/**
 * 相手の声の中継。相手がSTTへ送る録音の音声を、本人が「相手の声」をオンにしたときだけ本人の席へ送る。
 * 送るのは相手が録音している間だけで、本人の選択は接続ごとに選び直してもらう。
 */
describe('相手の声の中継', () => {
  let testServer: CallTestServer;
  let logs: string[];

  beforeEach(async () => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(String(line)));
    vi.spyOn(console, 'warn').mockImplementation((line: string) => logs.push(String(line)));
    testServer = new CallTestServer();
    await testServer.listen(null);
  });

  afterEach(async () => {
    await testServer.close();
    vi.restoreAllMocks();
  });

  async function startRecording(call: OpenCall) {
    const count = call.hospital.all('hospital_speaking_start').length + 1;
    call.hospital.send({ type: 'hospital_speaking_start' });
    await call.hospital.waitFor('hospital_speaking_start', count);
  }

  async function listen(call: OpenCall, enabled: boolean) {
    call.patient.send({ type: 'partner_audio_listen', enabled });
    // 同じ接続のメッセージは順に処理されるので、後の確認の往復を待てば反映済み。
    await testServer.flush(call);
  }

  it('本人が聞くと選ぶまでは、録音の音声を本人へ送らない', async () => {
    const call = await testServer.openCall();
    await startRecording(call);
    call.hospital.sendBinary(Buffer.from([1, 0, 2, 0]));
    await vi.waitFor(() => expect(call.stream().written).toHaveLength(1));
    await testServer.flush(call);
    expect(call.patient.audio).toHaveLength(0);
  });

  it('聞くと選ぶと、STTへ送ったのと同じ音声を、同じ順で本人へ送る', async () => {
    const call = await testServer.openCall();
    await listen(call, true);
    await startRecording(call);

    call.hospital.sendBinary(Buffer.from([1, 0, 2, 0]));
    call.hospital.sendBinary(Buffer.from([3, 0, 4, 0]));
    await vi.waitFor(() => expect(call.patient.audio).toHaveLength(2));
    expect(call.patient.audio.map((chunk) => [...chunk])).toEqual([
      [1, 0, 2, 0],
      [3, 0, 4, 0],
    ]);
    expect(call.stream().written.map((chunk) => [...chunk])).toEqual([
      [1, 0, 2, 0],
      [3, 0, 4, 0],
    ]);
    // 相手の席には自分の声を返さない。
    expect(call.hospital.audio).toHaveLength(0);
  });

  it('録音していない間に届いた音声は、聞くと選んでいても本人へ送らない', async () => {
    const call = await testServer.openCall();
    await listen(call, true);
    call.hospital.sendBinary(Buffer.from([9, 9]));
    await testServer.flush(call);
    expect(call.patient.audio).toHaveLength(0);
  });

  it('オフにしたら、その後の音声は送らない', async () => {
    const call = await testServer.openCall();
    await listen(call, true);
    await startRecording(call);
    call.hospital.sendBinary(Buffer.from([1, 0]));
    await vi.waitFor(() => expect(call.patient.audio).toHaveLength(1));

    await listen(call, false);
    call.hospital.sendBinary(Buffer.from([2, 0]));
    await vi.waitFor(() => expect(call.stream().written).toHaveLength(2));
    await testServer.flush(call);
    expect(call.patient.audio).toHaveLength(1);
  });

  it('本人がつなぎ直したら、選び直すまで送らない（古い選択を持ち越さない）', async () => {
    const call = await testServer.openCall();
    await listen(call, true);
    const seatToken = call.patient.all('call_joined')[0].seatToken;

    call.patient.terminate();
    const patient = await testServer.connect();
    patient.send({ type: 'join_call', seatToken });
    await patient.waitFor('call_joined');
    const reconnected = { ...call, patient };
    // つなぎ直した本人の画面は受信の数が違うので、本人の接続だけで往復を待つ。
    const roundTrip = async () => {
      const count = patient.all('patient_speaking_status').length + 1;
      patient.send({ type: 'patient_speaking_status', isSpeaking: false });
      await patient.waitFor('patient_speaking_status', count);
    };

    await startRecording(reconnected);
    call.hospital.sendBinary(Buffer.from([1, 0]));
    await vi.waitFor(() => expect(call.stream().written).toHaveLength(1));
    await roundTrip();
    expect(patient.audio).toHaveLength(0);

    patient.send({ type: 'partner_audio_listen', enabled: true });
    await roundTrip();
    call.hospital.sendBinary(Buffer.from([2, 0]));
    await vi.waitFor(() => expect(patient.audio).toHaveLength(1));
  });

  it('相手が聞くかを選ぶメッセージは送れない', async () => {
    const call = await testServer.openCall();
    call.hospital.send({ type: 'partner_audio_listen', enabled: true });
    expect((await call.hospital.waitFor('call_error')).code).toBe('not_allowed');
  });

  it('値が壊れていたら受け付けない', async () => {
    const call = await testServer.openCall();
    call.patient.send({ type: 'partner_audio_listen', enabled: 'yes' });
    expect((await call.patient.waitFor('call_error')).code).toBe('invalid_message');
  });

  it('応答の前でも選べる（発信したらすぐ選ぶため）', async () => {
    const { patient } = await testServer.placeCall();
    patient.send({ type: 'partner_audio_listen', enabled: true });
    patient.send({ type: 'partner_audio_listen', enabled: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(patient.all('call_error')).toHaveLength(0);
  });

  it('中継した音声の長さをログに残し、音声の中身は残さない', async () => {
    const call = await testServer.openCall();
    await listen(call, true);
    await startRecording(call);
    // 16kHz・16bit なので 3200 バイトで 100ms。
    call.hospital.sendBinary(Buffer.alloc(3200, 7));
    await vi.waitFor(() => expect(call.patient.audio).toHaveLength(1));
    call.stream().speak('はい');
    await call.hospital.waitFor('transcript_interim');
    call.hospital.send({ type: 'hospital_speech_end' });
    await call.hospital.waitFor('transcript_final');

    const settled = logs
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.message === 'stt_settled');
    expect(settled).toMatchObject({ audioMs: 100, relayedMs: 100, relayDroppedMs: 0 });
    expect(logs.some((line) => line.includes('partner_audio_listen') && line.includes('"enabled":true'))).toBe(true);
    expect(logs.join('\n')).not.toContain('はい');
  });

  it('再生の開始の報告に付いた音声の長さを本人へ伝える', async () => {
    const call = await testServer.openCall();
    const seq = call.patient.all('answer_call')[0].seq;
    call.hospital.send({ type: 'speech_playback', seq, status: 'started', engine: 'cloud', durationMs: 4200 });
    const report = await call.patient.waitFor('speech_playback');
    expect(report).toMatchObject({ seq, status: 'started', engine: 'cloud', durationMs: 4200 });

    // 終わりの報告には付けない。範囲外の長さは捨て、報告そのものは通す。
    call.hospital.send({ type: 'speech_playback', seq, status: 'ended', engine: 'cloud', durationMs: 4200 });
    const ended = await call.patient.waitFor('speech_playback', 2);
    expect(ended).not.toHaveProperty('durationMs');
  });

  it('範囲外の長さは捨てて、開始の報告だけを伝える', async () => {
    const call = await testServer.openCall();
    const seq = call.patient.all('answer_call')[0].seq;
    call.hospital.send({ type: 'speech_playback', seq, status: 'started', engine: 'cloud', durationMs: -5 });
    const report = await call.patient.waitFor('speech_playback');
    expect(report.status).toBe('started');
    expect(report).not.toHaveProperty('durationMs');
  });
});
