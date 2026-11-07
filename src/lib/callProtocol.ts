import type { AiMeta, AiStatus } from './aiMeta';

/** 患者が入力・確定できる文の上限。Geminiへの入力量の上限も兼ねる。 */
export const MAX_PATIENT_TEXT_LENGTH = 300;

/** デモの架電先。AIの推測ではなく、シナリオで決まっている値。 */
export const DEMO_CLINIC_LOCATION = 'ひまわり医院 (受付)';

export const TYPING_NOTICE_TEXT = '通話内容入力中のためお待ちください';

/** 通話サーバーのWebSocketのパス。 */
export const CALL_SOCKET_PATH = '/ws/call';

/** 同じ席に新しい接続が入り、古い接続を閉じたときのクローズコード。 */
export const CLOSE_CODE_SEAT_TAKEN = 4001;

/** 読み間違えやすい I, L, O, U を含まない Crockford Base32。 */
export const INVITE_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 1文字5ビットなので50ビット。手で打てる長さで、総当たりは現実的でない。 */
export const INVITE_CODE_LENGTH = 10;

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

/** 手入力の揺れをなくす。全角や区切りを取り除き、紛らわしい文字を読み替える。 */
export function normalizeInviteCode(input: string): string {
  return input
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** 読み上げや手入力がしやすいよう、中央で区切って表示する。 */
export function formatInviteCode(code: string): string {
  const middle = Math.ceil(code.length / 2);
  return `${code.slice(0, middle)}-${code.slice(middle)}`;
}

/**
 * 病院役に渡す招待リンクを作る。
 * URLのフラグメントはサーバーへ送られないので、コードがアクセスログやRefererに残らない。
 */
export function buildInviteUrl(origin: string, code: string): string {
  return `${origin}/hospital#invite=${code}`;
}

/** URLのフラグメントから招待コードを取り出す。 */
export function parseInviteFromHash(hash: string): string | null {
  const code = new URLSearchParams(hash.replace(/^#/, '')).get('invite');
  return code ? normalizeInviteCode(code) : null;
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

export const CALL_ROLES = ['patient', 'hospital'] as const;

export type CallRole = (typeof CALL_ROLES)[number];

/** 通話の段階。ringing の間だけ招待が有効で、ended の後は結果の確認だけができる。 */
export type CallPhase = 'ringing' | 'connected' | 'ending' | 'ended';

/** 通話の記録の1行。seq は通話の中で増え続け、再接続時の読み上げ漏れの判定に使う。 */
export interface CallTurn extends ChatTurn {
  seq: number;
  origin?: SpeechOrigin | 'greeting';
}

export interface CallInvite {
  code: string;
  /** 期限の時刻（UNIXミリ秒） */
  expiresAt: number;
}

export interface SuggestionSet {
  suggestions: SuggestionItem[];
  ai: AiMeta;
}

export interface AppointmentResult {
  appointment: AppointmentDraft;
  ai: AiMeta;
}

/**
 * 参加した時点の通話の状態。
 * 切断中に届かなかったメッセージも、再読み込みで消えた画面も、これで元に戻す。
 * suggestions、appointment、invite は患者の席にだけ入る。
 */
export interface CallSnapshot {
  phase: CallPhase;
  turns: CallTurn[];
  peerConnected: boolean;
  isHospitalSpeaking: boolean;
  isPatientSpeaking: boolean;
  isGeneratingSuggestions: boolean;
  suggestions: SuggestionSet | null;
  appointment: AppointmentResult | null;
  invite: CallInvite | null;
}

/** 通話に参加できなかった、またはメッセージを受け付けなかった理由。 */
export type CallErrorCode =
  | 'invalid_invite'
  | 'call_not_found'
  | 'server_busy'
  | 'already_in_call'
  | 'not_in_call'
  | 'not_allowed'
  | 'invalid_message';

/** 通話が閉じられた理由。閉じた通話の席と招待は使えなくなる。 */
export type CallClosedReason =
  | 'reset'
  | 'invite_expired'
  | 'abandoned'
  | 'time_limit'
  | 'retention_expired'
  | 'server_closing';

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
  | { type: 'call_joined'; role: CallRole; seatToken: string; snapshot: CallSnapshot }
  | { type: 'call_error'; code: CallErrorCode }
  | { type: 'call_closed'; reason: CallClosedReason }
  | { type: 'peer_status'; connected: boolean }
  | { type: 'answer_call'; text: string; seq: number }
  | { type: 'hospital_speaking_start' }
  | { type: 'hospital_speaking_stop' }
  | { type: 'hospital_recording_failed'; reason: RecordingFailureReason }
  | { type: 'transcript_interim'; text: string }
  | { type: 'transcript_final'; text: string; seq: number }
  | { type: 'generating_suggestions' }
  | { type: 'suggestions'; suggestions: SuggestionItem[]; ai: AiMeta }
  | {
      type: 'patient_polish_result';
      requestId: string;
      original: string;
      polished: string | null;
      ai: AiMeta;
    }
  | { type: 'patient_speech'; text: string; origin: SpeechOrigin; seq: number }
  | { type: 'patient_typing_notice'; text: string }
  | { type: 'patient_speaking_status'; isSpeaking: boolean }
  | { type: 'call_ending' }
  | { type: 'end_call'; appointment: AppointmentDraft; ai: AiMeta };

/** ブラウザからサーバーへ送るメッセージ。席のない接続が送れるのは start_call と join_call だけ。 */
export type ClientMessage =
  | { type: 'start_call'; intent: string }
  | { type: 'join_call'; inviteCode: string }
  | { type: 'join_call'; seatToken: string }
  | { type: 'answer_call' }
  | { type: 'hospital_speaking_start' }
  | { type: 'hospital_speaking_stop' }
  | { type: 'hospital_speech_end' }
  | { type: 'patient_typing_notice' }
  | { type: 'patient_polish_request'; requestId: string; text: string }
  | { type: 'patient_confirmed_speech'; text: string; origin: SpeechOrigin }
  | { type: 'patient_speaking_status'; isSpeaking: boolean }
  | { type: 'end_call' }
  | { type: 'reset_call' }
  | { type: 'leave_call' };
