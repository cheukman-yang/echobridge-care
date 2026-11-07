import type { AiMeta, AiStatus } from './aiMeta';

/** 患者が入力・確定できる文の上限。Geminiへの入力量の上限も兼ねる。 */
export const MAX_PATIENT_TEXT_LENGTH = 300;

/** デモの架電先。AIの推測ではなく、シナリオで決まっている値。 */
export const DEMO_CLINIC_LOCATION = 'ひまわり医院 (受付)';

export const TYPING_NOTICE_TEXT = '通話内容入力中のためお待ちください';

const GREETING_PREFIX = 'お忙しいところ恐れ入ります。AI音声アシスタントを介してお電話しております。';

/**
 * 相手に最初に読み上げる文を作る。
 * 発信前のプレビューとサーバーの読み上げが同じ関数を使うので、本人が見た文と読まれる文は一致する。
 * 本人の文に活用や語尾を足すと意味が崩れるので、文末の句点以外は変更しない。
 */
export function buildGreeting(intent: string): string {
  const body = intent.trim();
  if (!body) return GREETING_PREFIX;
  const hasSentenceEnd = /[。．.！!？?]$/.test(body);
  return `${GREETING_PREFIX}${body}${hasSentenceEnd ? '' : '。'}`;
}

export interface SuggestionItem {
  text: string;
  tag: string;
}

export interface ChatTurn {
  sender: '患者' | '病院受付';
  text: string;
}

/** 本人が確定した文の経路。相手に届く文はこのどれかを必ず通る。 */
export const SPEECH_ORIGINS = [
  'typed',
  'ai_reviewed',
  'ai_edited',
  'suggestion',
  'fallback_suggestion',
] as const;

export type SpeechOrigin = (typeof SPEECH_ORIGINS)[number];

/** 通話内容から読み取った予定の下書き。分からない項目は推測せず null のまま本人に見せる。 */
export interface AppointmentDraft {
  title: string;
  /** YYYY-MM-DD（Asia/Tokyo） */
  date: string | null;
  /** HH:mm（24時間表記） */
  startTime: string | null;
  /** HH:mm（24時間表記） */
  endTime: string | null;
  location: string;
  details: string;
}

/**
 * 音声認識の準備状態。
 * ready は認証情報が見つかったことだけを示す。権限不足などの失敗は録音を始めてから分かる。
 */
export type SpeechStatus = 'checking' | 'ready' | 'unavailable';

/** 録音を続けられなかった理由。失敗した音声は届かないので、必ず本人に知らせる。 */
export type RecordingFailureReason = 'start_failed' | 'stream_failed';

/** サーバーからブラウザへ送るメッセージ。 */
export type ServerMessage =
  | ({ type: 'ai_status' } & AiStatus)
  | { type: 'speech_status'; status: SpeechStatus }
  | { type: 'start_call'; intent?: string }
  | { type: 'answer_call'; text: string }
  | { type: 'hospital_speaking_start' }
  | { type: 'hospital_speaking_stop' }
  | { type: 'hospital_recording_failed'; reason: RecordingFailureReason }
  | { type: 'transcript_interim'; text: string }
  | { type: 'transcript_final'; text: string }
  | { type: 'generating_suggestions' }
  | { type: 'suggestions'; suggestions: SuggestionItem[]; ai: AiMeta }
  | {
      type: 'patient_polish_result';
      requestId: string;
      original: string;
      polished: string | null;
      ai: AiMeta;
    }
  | { type: 'patient_speech'; text: string; origin: SpeechOrigin }
  | { type: 'patient_typing_notice'; text: string }
  | { type: 'patient_speaking_status'; isSpeaking: boolean }
  | { type: 'call_ending' }
  | { type: 'end_call'; appointment: AppointmentDraft; ai: AiMeta }
  | { type: 'reset_call' };
