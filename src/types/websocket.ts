import { z } from 'zod';

export const SuggestionItemSchema = z.object({
  id: z.string().describe('選択肢の一意なID (例: opt_1, fb_1)'),
  label: z.string().describe('画面ボタンに表示する要約テキスト (30文字以内)'),
  speech_text: z.string().describe('TTSで実際に相手側へ読み上げる丁寧語テキスト'),
  intent: z.enum(['accept', 'decline', 'counter_offer', 'general']).describe('発話の意図分類'),
  is_fallback: z.boolean().default(false).describe('1.2sサーキットブレーカー等によるフォールバック生成か否か'),
});

export type SuggestionItem = z.infer<typeof SuggestionItemSchema>;

export const GeminiSuggestionResponseSchema = z.object({
  detected_intent: z.string().describe('相手の発話から読み取った意図'),
  confidence_score: z.number().min(0).max(1).describe('推論の信頼度スコア'),
  suggestions: z.tuple([
    SuggestionItemSchema,
    SuggestionItemSchema,
    SuggestionItemSchema,
  ]).describe('必ず厳密に3つの選択肢を出力'),
});

export type GeminiSuggestionResponse = z.infer<typeof GeminiSuggestionResponseSchema>;

export const MedicalSummarySchema = z.object({
  clinic_name: z.string().describe('受診先クリニック名'),
  appointment_date: z.string().describe('予約日 (YYYY-MM-DD)'),
  appointment_time: z.string().describe('予約時間 (HH:mm)'),
  department: z.string().optional().describe('診療科'),
  items_to_bring: z.array(z.string()).describe('当日の持ち物一覧 (保険証、診察券など)'),
  notes: z.string().describe('特記事項・注意事項'),
  raw_transcript_summary: z.string().describe('通話全体の要約文'),
});

export type MedicalSummary = z.infer<typeof MedicalSummarySchema>;

export const ClientWsMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('SESSION_START'),
    payload: z.object({
      callId: z.string(),
      targetClinic: z.string().default('ひまわり医院'),
      calendarId: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal('AUDIO_CHUNK'),
    payload: z.object({
      audioBase64: z.string(),
      sequence: z.number(),
    }),
  }),
  z.object({
    type: z.literal('USER_SPEECH_REQUEST'),
    payload: z.object({
      text: z.string(),
      isCustomInput: z.boolean().default(false),
    }),
  }),
  z.object({
    type: z.literal('SESSION_END'),
    payload: z.object({
      reason: z.enum(['completed', 'canceled', 'hangup']),
    }),
  }),
  z.object({
    type: z.literal('PING'),
  }),
]);

export type ClientWsMessage = z.infer<typeof ClientWsMessageSchema>;

export const ServerWsMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('STT_TRANSCRIPT'),
    payload: z.object({
      text: z.string(),
      isFinal: z.boolean(),
      confidence: z.number().optional(),
    }),
  }),
  z.object({
    type: z.literal('AI_SUGGESTIONS'),
    payload: GeminiSuggestionResponseSchema,
  }),
  z.object({
    type: z.literal('TTS_AUDIO_PLAY'),
    payload: z.object({
      audioBase64: z.string(),
      format: z.literal('audio/mp3'),
      text: z.string(),
    }),
  }),
  z.object({
    type: z.literal('CALL_SUMMARY'),
    payload: MedicalSummarySchema,
  }),
  z.object({
    type: z.literal('CALENDAR_SYNCED'),
    payload: z.object({
      eventId: z.string(),
      htmlLink: z.string(),
      start: z.string(),
      end: z.string(),
    }),
  }),
  z.object({
    type: z.literal('PONG'),
  }),
  z.object({
    type: z.literal('ERROR'),
    payload: z.object({
      code: z.string(),
      message: z.string(),
      fatal: z.boolean().default(false),
    }),
  }),
]);

export type ServerWsMessage = z.infer<typeof ServerWsMessageSchema>;