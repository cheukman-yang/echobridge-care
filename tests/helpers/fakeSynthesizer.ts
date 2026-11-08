import type { SpeechAudio, SpeechVoice } from '@/lib/callProtocol';
import type { SpeechSynthesizer, SynthesisOutcome } from '../../server/speechSynthesizer';

/** 音声合成の偽物。呼ばれた文を記録し、結果を手で決められる。 */
export class FakeSynthesizer implements SpeechSynthesizer {
  available = true;
  readonly calls: { text: string; voice: SpeechVoice }[] = [];
  readonly cache = new Map<string, SpeechAudio>();
  private listeners = new Set<(available: boolean) => void>();

  /** 既定は、文字数を入れた偽の音声をすぐ返す。 */
  respond: (text: string) => Promise<SynthesisOutcome> = async (text) => ({
    ok: true,
    cached: false,
    audio: FakeSynthesizer.audioFor(text),
    mimeType: 'audio/mpeg',
  });

  static audioFor(text: string): string {
    return Buffer.from(`fake-audio:${text.length}`).toString('base64');
  }

  onAvailabilityChange(listener: (available: boolean) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setAvailable(available: boolean) {
    this.available = available;
    this.listeners.forEach((listener) => listener(available));
  }

  synthesize(text: string, voice: SpeechVoice): Promise<SynthesisOutcome> {
    this.calls.push({ text, voice });
    return this.respond(text);
  }

  cachedAudio(text: string): SpeechAudio | null {
    return this.cache.get(text) ?? null;
  }
}
