import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecognizeStream, SpeechRecognizer } from '../../server/callServer';
import { createSpeechRecognizer, limitConcurrentStreams } from '../../server/speechRecognizer';

describe('limitConcurrentStreams', () => {
  it('上限を超える録音は断り、終わったストリームの枠を返す', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const streams: EventEmitter[] = [];
    const base: SpeechRecognizer = {
      status: 'ready',
      onStatusChange: () => () => {},
      createStream: () => {
        const stream = new EventEmitter();
        streams.push(stream);
        return stream as unknown as RecognizeStream;
      },
    };
    const limited = limitConcurrentStreams(base, 2);

    limited.createStream();
    limited.createStream();
    expect(() => limited.createStream()).toThrow('speech_busy');

    streams[0].emit('end');
    streams[0].emit('close');
    expect(() => limited.createStream()).not.toThrow();
    expect(() => limited.createStream()).toThrow('speech_busy');
  });
});

function fakeClient(getClient: () => Promise<unknown>) {
  return { auth: { getClient: vi.fn(getClient) }, streamingRecognize: vi.fn(() => ({ fake: 'stream' })) };
}

const nextTick = () => new Promise((resolve) => setTimeout(resolve));

describe('createSpeechRecognizer', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('認証を確認できたらストリームを作る', async () => {
    const client = fakeClient(async () => ({}));
    const speech = createSpeechRecognizer(client);

    await nextTick();

    expect(speech.status).toBe('ready');
    expect(speech.createStream()).toEqual({ fake: 'stream' });
    expect(client.streamingRecognize).toHaveBeenCalledTimes(1);
  });

  // SDKは認証失敗を未処理のPromise拒否にするので、呼んだ時点でプロセスが落ちる。
  it('認証がなければSDKを呼ばず、捕捉できる例外にする', async () => {
    const client = fakeClient(async () => {
      throw new Error('Could not load the default credentials.');
    });
    const speech = createSpeechRecognizer(client);

    await nextTick();

    expect(speech.status).toBe('unavailable');
    expect(() => speech.createStream()).toThrow('speech_not_ready');
    expect(client.streamingRecognize).not.toHaveBeenCalled();
  });

  it('認証の確認が終わる前は確認中と分かり、SDKを呼ばない', () => {
    const client = fakeClient(() => new Promise(() => {}));
    const speech = createSpeechRecognizer(client);

    expect(speech.status).toBe('checking');
    expect(() => speech.createStream()).toThrow('speech_not_ready');
    expect(client.streamingRecognize).not.toHaveBeenCalled();
  });

  it('確認中に何度押されても、確認を重ねない', () => {
    const client = fakeClient(() => new Promise(() => {}));
    const speech = createSpeechRecognizer(client);

    expect(() => speech.createStream()).toThrow('speech_not_ready');
    expect(() => speech.createStream()).toThrow('speech_not_ready');

    expect(client.auth.getClient).toHaveBeenCalledTimes(1);
  });

  it('確認が終わったら状態の変化を知らせる', async () => {
    const speech = createSpeechRecognizer(fakeClient(async () => ({})));
    const listener = vi.fn();
    speech.onStatusChange(listener);

    await nextTick();

    expect(listener.mock.calls).toEqual([['ready']]);
  });

  it('認証が後から使えるようになれば、次の発話で回復を知らせる', async () => {
    let attempts = 0;
    const speech = createSpeechRecognizer(
      fakeClient(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary failure');
        return {};
      }),
    );
    await nextTick();
    const listener = vi.fn();
    speech.onStatusChange(listener);

    expect(() => speech.createStream()).toThrow('speech_not_ready');
    expect(speech.status).toBe('checking');
    await nextTick();

    expect(listener.mock.calls).toEqual([['checking'], ['ready']]);
    expect(speech.createStream()).toEqual({ fake: 'stream' });
  });

  it('購読をやめたら知らせない', async () => {
    const speech = createSpeechRecognizer(fakeClient(async () => ({})));
    const listener = vi.fn();
    speech.onStatusChange(listener)();

    await nextTick();

    expect(listener).not.toHaveBeenCalled();
  });

  it('認証の失敗をログに残し、詳細は出さない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createSpeechRecognizer(
      fakeClient(async () => {
        throw new Error('path/to/secret.json was rejected');
      }),
    );

    await nextTick();

    const output = warn.mock.calls.flat().join('\n');
    expect(output).toContain('stt_not_configured');
    expect(output).not.toContain('secret.json');
  });
});
