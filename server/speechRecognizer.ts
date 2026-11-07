import { EventEmitter } from 'node:events';
import type { SpeechStatus } from '../src/lib/callProtocol';
import type { RecognizeStream, SpeechRecognizer } from './callServer';

const STREAMING_REQUEST = {
  config: {
    encoding: 'LINEAR16' as const,
    sampleRateHertz: 16000,
    languageCode: 'ja-JP',
  },
  interimResults: true,
};

/** STT v1のストリームは最長約5分なので、終わりの通知が来なくてもこの時間で枠を返す。 */
const STREAM_SLOT_MAX_MS = 6 * 60 * 1000;

/**
 * 同時に開ける認識ストリームの数を制限する。公開URLで録音を開き続けられても、STTの課金に上限ができる。
 * 枠がないときは例外を投げるので、画面には「録音を開始できませんでした」と出る。
 */
export function limitConcurrentStreams(recognizer: SpeechRecognizer, maxStreams: number): SpeechRecognizer {
  let active = 0;
  return {
    get status() {
      return recognizer.status;
    },
    onStatusChange: (listener) => recognizer.onStatusChange(listener),
    createStream() {
      if (active >= maxStreams) {
        console.warn(JSON.stringify({ severity: 'WARNING', message: 'stt_capacity_reached', active }));
        throw new Error('speech_busy');
      }
      const stream = recognizer.createStream() as RecognizeStream & EventEmitter;
      active += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        active -= 1;
        clearTimeout(timer);
      };
      const timer = setTimeout(release, STREAM_SLOT_MAX_MS);
      timer.unref?.();
      stream.once('end', release);
      stream.once('close', release);
      stream.once('error', release);
      return stream;
    },
  };
}

export interface SpeechClientLike {
  auth: { getClient(): Promise<unknown> };
  streamingRecognize(request: typeof STREAMING_REQUEST): unknown;
}

/**
 * 音声認識の入口を作る。
 *
 * @google-cloud/speech は認証の失敗を initialize().catch(err => { throw err }) で再送出する。
 * これは未処理のPromise拒否になり、try/catchでも error イベントでも止められず、
 * 全員の通話ごとプロセスが落ちる。そのため、認証を確認できるまでSDKを呼ばない。
 *
 * 確認は非同期なので、その間の状態を公開して画面が録音を止められるようにする。
 * 音声は溜めない。Speech-to-Textは実時間に近い速度での送信を求めるので、遅れた音声をまとめて送れない。
 */
export function createSpeechRecognizer(client: SpeechClientLike): SpeechRecognizer {
  const events = new EventEmitter();
  let status: SpeechStatus = 'checking';

  const setStatus = (next: SpeechStatus) => {
    if (status === next) return;
    status = next;
    events.emit('status', next);
  };

  const checkCredentials = () => {
    setStatus('checking');
    client.auth.getClient().then(
      () => setStatus('ready'),
      (error: unknown) => {
        console.warn(
          JSON.stringify({
            severity: 'WARNING',
            message: 'stt_not_configured',
            errorName: error instanceof Error ? error.name : 'unknown',
          }),
        );
        setStatus('unavailable');
      },
    );
  };

  checkCredentials();

  return {
    get status() {
      return status;
    },
    onStatusChange(listener) {
      events.on('status', listener);
      return () => events.off('status', listener);
    },
    createStream() {
      if (status !== 'ready') {
        // 起動時の一時的な失敗から戻れるよう確認し直す。確認中なら、その結果を待つ。
        if (status === 'unavailable') checkCredentials();
        throw new Error('speech_not_ready');
      }
      return client.streamingRecognize(STREAMING_REQUEST) as RecognizeStream;
    },
  };
}
