import 'dotenv/config';
import express from 'express';
import http from 'http';
import speech from '@google-cloud/speech';
import { attachCallServer, resolveAllowedOrigins } from './callServer';
import { createGeminiRunnerFromEnv } from './geminiClient';
import { createAiAssistant } from './geminiService';
import { createSpeechRecognizer } from './speechRecognizer';

const app = express();
const server = http.createServer(app);

attachCallServer(
  server,
  {
    ai: createAiAssistant(createGeminiRunnerFromEnv(process.env)),
    speech: createSpeechRecognizer(new speech.SpeechClient()),
  },
  { allowedOrigins: resolveAllowedOrigins(process.env) },
);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`> EchoBridge WS Server running on ws://localhost:${PORT}/ws/call`);
});
