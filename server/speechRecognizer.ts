import type { RecognizeStream } from './callServer';

const STREAMING_REQUEST = {
  config: {
    encoding: 'LINEAR16' as const,
    sampleRateHertz: 16000,
    languageCode: 'ja-JP',
  },
  interimResults: true,
};

export interface SpeechClientLike {
  auth: { getClient(): Promise<unknown> };
  streamingRecognize(request: typeof STREAMING_REQUEST): unknown;
}

/**
 * 音声認識ストリームの作成処理を返す。
 *
 * @google-cloud/speech は認証の失敗を initialize().catch(err => { throw err }) で再送出する。
 * これは未処理のPromise拒否になり、try/catchでも error イベントでも止められず、
 * 全員の通話ごとプロセスが落ちる。そのため、認証を確認できるまでSDKを呼ばない。
 */
export function createRecognizeStreamFactory(client: SpeechClientLike): () => RecognizeStream {
  let ready = false;

  const checkCredentials = () => {
    client.auth.getClient().then(
      () => {
        ready = true;
      },
      (error: unknown) => {
        console.warn(
          JSON.stringify({
            severity: 'WARNING',
            message: 'stt_not_configured',
            errorName: error instanceof Error ? error.name : 'unknown',
          }),
        );
      },
    );
  };

  checkCredentials();

  return () => {
    if (!ready) {
      // 起動時の一時的な失敗から戻れるよう、次の発話に向けて確認し直す。
      checkCredentials();
      throw new Error('speech_not_ready');
    }
    return client.streamingRecognize(STREAMING_REQUEST) as RecognizeStream;
  };
}
