import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecognizeStreamFactory } from '../../server/speechRecognizer';

function fakeClient(getClient: () => Promise<unknown>) {
  return { auth: { getClient: vi.fn(getClient) }, streamingRecognize: vi.fn(() => ({ fake: 'stream' })) };
}

const nextTick = () => new Promise((resolve) => setTimeout(resolve));

describe('createRecognizeStreamFactory', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('認証を確認できたらストリームを作る', async () => {
    const client = fakeClient(async () => ({}));
    const create = createRecognizeStreamFactory(client);

    await nextTick();

    expect(create()).toEqual({ fake: 'stream' });
    expect(client.streamingRecognize).toHaveBeenCalledTimes(1);
  });

  // SDKは認証失敗を未処理のPromise拒否にするので、呼んだ時点でプロセスが落ちる。
  it('認証がなければSDKを呼ばず、捕捉できる例外にする', async () => {
    const client = fakeClient(async () => {
      throw new Error('Could not load the default credentials.');
    });
    const create = createRecognizeStreamFactory(client);

    await nextTick();

    expect(create).toThrow('speech_not_ready');
    expect(client.streamingRecognize).not.toHaveBeenCalled();
  });

  it('認証の確認が終わる前もSDKを呼ばない', () => {
    const client = fakeClient(() => new Promise(() => {}));
    const create = createRecognizeStreamFactory(client);

    expect(create).toThrow('speech_not_ready');
    expect(client.streamingRecognize).not.toHaveBeenCalled();
  });

  it('認証が後から使えるようになれば、次の発話で回復する', async () => {
    let attempts = 0;
    const client = fakeClient(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary failure');
      return {};
    });
    const create = createRecognizeStreamFactory(client);

    await nextTick();
    expect(create).toThrow('speech_not_ready');
    await nextTick();

    expect(create()).toEqual({ fake: 'stream' });
  });

  it('認証の失敗をログに残し、詳細は出さない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createRecognizeStreamFactory(
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
