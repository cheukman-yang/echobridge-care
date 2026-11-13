import dotenv from 'dotenv';
import http from 'node:http';
import next from 'next';
import speech from '@google-cloud/speech';
import textToSpeech from '@google-cloud/text-to-speech';
import { TYPING_NOTICE_TEXT } from '../src/lib/callProtocol';
import { QUICK_PHRASES } from '../src/lib/quickPhrases';
import { attachCallServer, resolveAllowedOrigins } from './callServer';
import { createGeminiRunnerFromEnv } from './geminiClient';
import { createAiAssistant } from './geminiService';
import { createSpeechRecognizer, limitConcurrentStreams } from './speechRecognizer';
import { DISABLED_SYNTHESIZER, createCloudSynthesizer, resolveSynthesizerConfig } from './speechSynthesizer';
import type { SpeechSynthesizer, TtsClientLike } from './speechSynthesizer';

dotenv.config({ path: ['.env.local', '.env'] });

/**
 * 本番（NODE_ENV=production）では、画面（Next.js）と通話のWebSocketを同じポートで配る。
 * Cloud Runは1サービスで済み、画面は同一オリジンの /ws/call へつなぐ。
 * 開発時は、画面は `next dev`（3000番）が配り、このサーバーは通話だけを受ける（8080番）。
 */
const isProduction = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 8080;
/** Cloud RunはSIGTERMの10秒後に強制終了するので、その前に通話を閉じて知らせる。 */
const SHUTDOWN_GRACE_MS = 8_000;
/** 同時に録音できる数。STTの課金の上限になる。 */
const MAX_CONCURRENT_STT_STREAMS = Number(process.env.STT_MAX_CONCURRENT_STREAMS) || 3;

type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

async function prepareNext(): Promise<RequestHandler> {
  const app = next({ dev: false });
  await app.prepare();
  const handle = app.getRequestHandler();
  return (req, res) => handle(req, res);
}

/**
 * 本人の文を読み上げる音声合成（Cloud Text-to-Speech、Chirp 3: HD）。
 * 即答フレーズと「入力中です」は個人の情報を含まない決まった文なので、作り置きして使い回す。
 * TTS_ENABLED=false なら使わず、相手の端末の声で読む。
 */
function createSynthesizer(): SpeechSynthesizer {
  const config = resolveSynthesizerConfig(process.env, [...QUICK_PHRASES, TYPING_NOTICE_TEXT]);
  if (!config) return DISABLED_SYNTHESIZER;
  const client = new textToSpeech.TextToSpeechClient(
    process.env.TTS_API_ENDPOINT ? { apiEndpoint: process.env.TTS_API_ENDPOINT } : {},
  );
  return createCloudSynthesizer(client as unknown as TtsClientLike, config);
}

async function main(): Promise<void> {
  const handle = isProduction ? await prepareNext() : null;

  const server = http.createServer((req, res) => {
    if (handle) {
      handle(req, res).catch(() => {
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  const wss = attachCallServer(
    server,
    {
      ai: createAiAssistant(createGeminiRunnerFromEnv(process.env)),
      speech: limitConcurrentStreams(
        createSpeechRecognizer(new speech.SpeechClient()),
        MAX_CONCURRENT_STT_STREAMS,
      ),
      tts: createSynthesizer(),
    },
    { allowedOrigins: resolveAllowedOrigins(process.env) },
  );

  server.listen(PORT, () => {
    const scope = isProduction ? 'app and calls' : 'calls only';
    console.log(`> EchoBridge Care server (${scope}) on port ${PORT}, call socket at /ws/call`);
  });

  process.once('SIGTERM', () => {
    console.log(JSON.stringify({ severity: 'INFO', message: 'server_shutdown' }));
    // 通話中の両方の画面に server_closing を送ってから閉じる。
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  });
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      severity: 'ERROR',
      message: 'server_start_failed',
      errorName: error instanceof Error ? error.name : 'unknown',
    }),
  );
  process.exit(1);
});
