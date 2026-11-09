import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallTestServer } from '../helpers/callTestServer';
import type { OpenCall } from '../helpers/callTestServer';

/**
 * 相手の録音が届かなかったときに、Cloud Logging だけで原因を見分けられるようにする。
 * 実機で「音声0ms」の録音が続いたが、準備中に止めたのか、マイクの音が来なかったのかを区別できなかった。
 */
describe('録音の取り消しと終わりのログ', () => {
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

  function entries(message: string): Record<string, unknown>[] {
    return logs
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is Record<string, unknown> => entry?.message === message);
  }

  async function startRecording(call: OpenCall) {
    call.hospital.send({ type: 'hospital_speaking_start' });
    await call.hospital.waitFor('hospital_speaking_start');
  }

  it('取り消しの理由とマイクの準備の時間を残し、認識の結果は待たない', async () => {
    const call = await testServer.openCall();
    await startRecording(call);

    call.hospital.send({ type: 'hospital_speaking_stop', reason: 'not_ready', prepMs: 2300 });
    await call.patient.waitFor('hospital_speaking_stop');
    await testServer.flush(call);

    expect(entries('recording_cancelled')).toMatchObject([
      { reason: 'not_ready', prepMs: 2300, audioMs: 0, wasRecording: true },
    ]);
    expect(entries('stt_settled')).toEqual([]);
    expect(call.hospital.all('transcript_empty')).toEqual([]);
  });

  it('値が壊れていても取り消しは受け付け、値だけを捨てる', async () => {
    const call = await testServer.openCall();
    await startRecording(call);

    call.hospital.send({ type: 'hospital_speaking_stop', reason: 'whatever', prepMs: -1 });
    await call.patient.waitFor('hospital_speaking_stop');
    await testServer.flush(call);

    expect(call.hospital.all('call_error')).toEqual([]);
    expect(entries('recording_cancelled')).toMatchObject([{ reason: 'unspecified', prepMs: null }]);
  });

  it('古い画面（値なし）の取り消しも、これまでどおり受け付ける', async () => {
    const call = await testServer.openCall();
    await startRecording(call);

    call.hospital.send({ type: 'hospital_speaking_stop' });
    await call.patient.waitFor('hospital_speaking_stop');
    await testServer.flush(call);

    expect(call.hospital.all('call_error')).toEqual([]);
    expect(entries('recording_cancelled')).toMatchObject([{ reason: 'unspecified', prepMs: null }]);
  });

  it('話し終えたときは、認識のログにマイクの準備の時間を添える', async () => {
    const call = await testServer.openCall();
    await startRecording(call);
    call.hospital.sendBinary(Buffer.alloc(3200, 7));
    await vi.waitFor(() => expect(call.stream().written).toHaveLength(1));
    call.stream().speak('はい');
    await call.hospital.waitFor('transcript_interim');

    call.hospital.send({ type: 'hospital_speech_end', prepMs: 640 });
    await call.hospital.waitFor('transcript_final');

    expect(entries('stt_settled')).toMatchObject([{ audioMs: 100, prepMs: 640, recognized: true }]);
    expect(logs.join('\n')).not.toContain('はい');
  });
});
