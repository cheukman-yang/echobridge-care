import textToSpeech from '@google-cloud/text-to-speech';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  DISABLED_SYNTHESIZER,
  createCloudSynthesizer,
  resolveSynthesizerConfig,
} from '../../../../../server/speechSynthesizer';
import type { SpeechSynthesizer, TtsClientLike } from '../../../../../server/speechSynthesizer';

const RequestSchema = z.object({
  text: z.string().trim().min(1).max(400),
  voice: z.enum(['female', 'male']).default('female'),
});

let cachedSynthesizer: SpeechSynthesizer | null = null;

function hasExplicitCloudTtsCredentials(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ||
      env.GOOGLE_CLOUD_PROJECT?.trim() ||
      env.TTS_API_ENDPOINT?.trim(),
  );
}

function getSynthesizer(): SpeechSynthesizer {
  if (cachedSynthesizer) return cachedSynthesizer;
  if (!hasExplicitCloudTtsCredentials(process.env)) {
    cachedSynthesizer = DISABLED_SYNTHESIZER;
    return cachedSynthesizer;
  }
  const config = resolveSynthesizerConfig(process.env, []);
  if (!config) {
    cachedSynthesizer = DISABLED_SYNTHESIZER;
    return cachedSynthesizer;
  }
  try {
    const client = new textToSpeech.TextToSpeechClient(
      process.env.TTS_API_ENDPOINT ? { apiEndpoint: process.env.TTS_API_ENDPOINT } : {},
    );
    cachedSynthesizer = createCloudSynthesizer(client as unknown as TtsClientLike, config);
  } catch {
    cachedSynthesizer = DISABLED_SYNTHESIZER;
  }
  return cachedSynthesizer;
}

export async function POST(request: Request) {
  try {
    const json: unknown = await request.json();
    const parsed = RequestSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ available: false }, { status: 400 });
    }
    const synthesizer = getSynthesizer();
    if (!synthesizer.available) {
      return NextResponse.json({ available: false });
    }
    const outcome = await synthesizer.synthesize(parsed.data.text, parsed.data.voice);
    if (!outcome.ok) {
      return NextResponse.json({ available: false, reason: outcome.reason });
    }
    return NextResponse.json({
      available: true,
      audio: outcome.audio,
      mimeType: outcome.mimeType,
    });
  } catch {
    return NextResponse.json({ available: false });
  }
}
