import { z } from 'zod';

/**
 * 3択サジェスト（動的生成および静的フォールバック共通）
 */
export const SuggestionItemSchema = z.object({
  id: z.string().describe('選択肢の一意なID (例: opt_1, fb_1)'),
  label: z.string().describe('画面ボタンに表示する要約テキスト (30文字以内)'),
  speech_text: z.string().describe('TTSで実際に相手側へ読み上げる丁寧語テキスト'),
  intent: z.enum(['accept', 'decline', 'counter_offer', 'general']).describe('発話の意図分類'),
  is_fallback: z.boolean().default(false).describe('1.2sサーキットブレーカー等によるフォールバック生成か否か'),
});

export type SuggestionItem = z.infer<typeof SuggestionItemSchema>;

/**
 * Gemini 1.5 Flash から返却される3択サジェストの出力スキーマ
 */
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

/**
 * 通話終了後のカルテ形式要約（Gemini 1.5 Pro 出力）
 */
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

/**
 * WebSocket クライアント -> サーバー メッセージスキーマ
 */
export const ClientWsMessageSchema = z.discriminatedUnion('type', [
  // 通話セッション開始
  z.object({
    type: z.literal('SESSION_START'),
    payload: z.object({
      callId: z.string(),
      targetClinic: z.string().default('ひまわり医院'),
      calendarId: z.string().optional(),
    }),
  }),
  // 音声ストリーム (16kHz PCM Int16Array の Base64)
  z.object({
    type: z.literal('AUDIO_CHUNK'),
    payload: z.object({
      audioBase64: z.string(),
      sequence: z.number(),
    }),
  }),
  // ユーザーが選択肢をタップまたは自由入力を送信
  z.object({
    type: z.literal('USER_SPEECH_REQUEST'),
    payload: z.object({
      text: z.string(),
      isCustomInput: z.boolean().default(false),
    }),
  }),
  // 通話終了
  z.object({
    type: z.literal('SESSION_END'),
    payload: z.object({
      reason: z.enum(['completed', 'canceled', 'hangup']),
    }),
  }),
  // 接続維持ハートビート
  z.object({
    type: z.literal('PING'),
  }),
]);

export type ClientWsMessage = z.infer<typeof ClientWsMessageSchema>;

/**
 * WebSocket サーバー -> クライアント メッセージスキーマ
 */
export const ServerWsMessageSchema = z.discriminatedUnion('type', [
  // STT 文字起こし結果（中間または確定）
  z.object({
    type: z.literal('STT_TRANSCRIPT'),
    payload: z.object({
      text: z.string(),
      isFinal: z.boolean(),
      confidence: z.number().optional(),
    }),
  }),
  // AI リアルタイムサジェスト提示
  z.object({
    type: z.literal('AI_SUGGESTIONS'),
    payload: GeminiSuggestionResponseSchema,
  }),
  // 発話音声（相手または自分のTTS合成音声バイナリ）
  z.object({
    type: z.literal('TTS_AUDIO_PLAY'),
    payload: z.object({
      audioBase64: z.string(),
      format: z.literal('audio/mp3'),
      text: z.string(),
    }),
  }),
  // 通話終了時の最終カルテ要約
  z.object({
    type: z.literal('CALL_SUMMARY'),
    payload: MedicalSummarySchema,
  }),
  // カレンダー登録完了通知
  z.object({
    type: z.literal('CALENDAR_SYNCED'),
    payload: z.object({
      eventId: z.string(),
      htmlLink: z.string(),
      start: z.string(),
      end: z.string(),
    }),
  }),
  // 接続維持ハートビート応答
  z.object({
    type: z.literal('PONG'),
  }),
  // エラー通知
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
