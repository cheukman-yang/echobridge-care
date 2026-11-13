import type { AiMeta, AiStatus } from './aiMeta';
import { CALL_PURPOSE_PROFILES, DEFAULT_CALL_PURPOSE } from './callPurpose';
import type { CallPurpose } from './callPurpose';
import type { UserLanguage } from './userLanguage';

/** 患者が入力・確定できる文の上限。Geminiへの入力量の上限も兼ねる。 */
export const MAX_PATIENT_TEXT_LENGTH = 300;

export const TYPING_NOTICE_TEXT = '通話内容入力中のためお待ちください';

/** 通話サーバーのWebSocketのパス。 */
export const CALL_SOCKET_PATH = '/ws/call';

/**
 * 相手の画面からサーバーへ送る録音のサンプリングレート。16bit・モノラルのPCM（リトルエンディアン）で送る。
 * Speech-to-Text の認識設定（server/speechRecognizer.ts）も、この値を使う。
 */
export const STT_SAMPLE_RATE_HZ = 16000;

/**
 * 相手の声を本人の画面で鳴らすための中継（バイナリのフレーム）。中身は相手の画面がSTTへ送る音声と同じで、
 * 16bit・モノラル・STT_SAMPLE_RATE_HZ のPCM。届くのは、相手が録音している間で、本人が聞くと選んだ（partner_audio_listen）ときだけ。
 * サーバーは保存もログへの記録もしない。
 */
export const PARTNER_AUDIO_SAMPLE_RATE_HZ = STT_SAMPLE_RATE_HZ;

/** 同じ席に新しい接続が入り、古い接続を閉じたときのクローズコード。 */
export const CLOSE_CODE_SEAT_TAKEN = 4001;

/**
 * 通話に入らないまま一定時間たった接続を閉じたときのクローズコード。
 * Cloud Runは接続が1本でも開いているとインスタンスを止めないので、開いたままのタブで課金が続かないようにする。
 * 画面はすぐにはつなぎ直さず、利用者が操作したときにつなぐ。
 */
export const CLOSE_CODE_IDLE = 4002;

/** 読み間違えやすい I, L, O, U を含まない Crockford Base32。 */
export const INVITE_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 1文字5ビットなので50ビット。手で打てる長さで、総当たりは現実的でない。 */
export const INVITE_CODE_LENGTH = 10;

/**
 * 相手に最初に読み上げる文を作る。
 * 発信前のプレビューとサーバーの読み上げが同じ関数を使うので、本人が見た文と読まれる文は一致する。
 * 本人の文に活用や語尾を足すと意味が崩れるので、文末の句点以外は変更しない。
 */
export function buildGreeting(intent: string, purpose: CallPurpose = DEFAULT_CALL_PURPOSE): string {
  const prefix = CALL_PURPOSE_PROFILES[purpose].greetingPrefix;
  const body = intent.trim();
  if (!body) return prefix;
  const hasSentenceEnd = /[。．.！!？?]$/.test(body);
  return `${prefix}${body}${hasSentenceEnd ? '' : '。'}`;
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

/** 相手が参加する画面のパス。以前の `/hospital` は next.config の転送でここへ来る。 */
export const JOIN_PATH = '/join';

/**
 * 相手に渡す招待リンクを作る。
 * URLのフラグメントはサーバーへ送られないので、コードがアクセスログやRefererに残らない。
 */
export function buildInviteUrl(origin: string, code: string): string {
  return `${origin}${JOIN_PATH}#invite=${code}`;
}

/** URLのフラグメントから招待コードを取り出す。 */
export function parseInviteFromHash(hash: string): string | null {
  const code = new URLSearchParams(hash.replace(/^#/, '')).get('invite');
  return code ? normalizeInviteCode(code) : null;
}

export interface SuggestionItem {
  /** 相手（受付・医師）へ日本語で読み上げ・提示する文。 */
  text: string;
  /** English選択時にボタン主表示として出す英語テキスト。未指定なら text を使う。 */
  displayText?: string;
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
  'quick_phrase',
  // 本人が自分の端末に登録した文。表示した文をそのまま送る。
  'custom_phrase',
] as const;

export type SpeechOrigin = (typeof SPEECH_ORIGINS)[number];

/**
 * 送っても返答候補を残す経路。「少々お待ちください」や自己紹介のように会話をつなぐ文なので、
 * 相手の直前の発言への候補は、送った後もそのまま使える。
 */
export function keepsSuggestions(origin: SpeechOrigin): boolean {
  return origin === 'quick_phrase' || origin === 'custom_phrase';
}

/**
 * 相手の端末での読み上げの状態。相手の画面が報告する。
 * 届いたことと、相手が聞けたことは別なので、本人の画面で区別して見せる。
 * - blocked: ブラウザが自動再生を止めた。相手が画面のボタンを押すと流れる
 * - failed: 再生できなかった、または再生が始まったことを確かめられなかった
 */
export const PLAYBACK_STATUSES = ['started', 'ended', 'failed', 'blocked'] as const;

export type PlaybackStatus = (typeof PLAYBACK_STATUSES)[number];

/**
 * 相手の端末で鳴らした声の出どころ。
 * - cloud: サーバーで合成した音声（Cloud Text-to-Speech）
 * - device: 相手の端末のブラウザの読み上げ（speechSynthesis）
 */
export const SPEECH_ENGINES = ['cloud', 'device'] as const;

export type SpeechEngine = (typeof SPEECH_ENGINES)[number];

/** 本人が発信のときに選ぶ読み上げの声。サーバーが実際の声の名前に置き換える。 */
export const SPEECH_VOICES = ['female', 'male'] as const;

export type SpeechVoice = (typeof SPEECH_VOICES)[number];

export const DEFAULT_SPEECH_VOICE: SpeechVoice = 'female';

export function isSpeechVoice(value: unknown): value is SpeechVoice {
  return typeof value === 'string' && (SPEECH_VOICES as readonly string[]).includes(value);
}

/**
 * サーバーで音声を作れなかった理由。作れなかった文は、相手の端末の声で読む。
 * - unavailable: 音声合成を使えない（認証・APIの無効・権限・開発用のモック）
 * - timeout: 時間内に返らなかった
 * - quota: 1通話または1日の文字数の上限に達した
 * - error: そのほかの失敗
 */
export type SynthesisFailureReason = 'unavailable' | 'timeout' | 'quota' | 'error';

export type SynthesisStatus = 'ready' | 'failed';

/** サーバーで合成した音声。base64のまま再生する。 */
export interface SpeechAudio {
  audio: string;
  mimeType: string;
}

/** 本人が同じ文を相手の端末で読み直してもらえる回数（1文あたり）。 */
export const MAX_REPLAYS_PER_TURN = 3;

export type AppointmentField =
  | 'title'
  | 'date'
  | 'startTime'
  | 'endTime'
  | 'location'
  | 'address'
  | 'details';

/**
 * AIが読み取った日時を採用しなかった理由。採用しなかった項目は空欄にし、理由を本人に見せる。
 * - weekday_mismatch: 会話の日付と曜日が合わない
 * - date_mismatch: 読み取った日付が、会話の言葉（「明日」「12日」など）と合わない
 * - past_date: 今日より前の日付
 * - not_in_conversation: 根拠になる言葉が会話の中に見つからない
 * - unclear_time: 会話の言葉（「お昼ごろ」など）から時刻を決められない
 * - time_mismatch: 読み取った時刻が、会話の言葉（「午後2時半」など）と合わない
 * - end_before_start: 終了時刻が開始時刻より前
 */
export type AppointmentIssueCode =
  | 'weekday_mismatch'
  | 'date_mismatch'
  | 'past_date'
  | 'not_in_conversation'
  | 'unclear_time'
  | 'time_mismatch'
  | 'end_before_start';

export interface AppointmentIssue {
  field: 'date' | 'startTime' | 'endTime';
  code: AppointmentIssueCode;
  /** 会話での言い方。会話の中にあることを確かめた文だけを入れる。 */
  said?: string;
  /** AIが読み取った値（YYYY-MM-DD か HH:mm）。採用はしていない。 */
  value?: string;
}

/** 通話内容から読み取った予定の下書き。分からない項目は推測せず null のまま本人に見せる。 */
export interface AppointmentDraft {
  /**
   * Geminiが値を返した項目。ここにない項目は、既定値（発信のときの入力）か空欄。
   * 画面でAIの値と本人の入力を区別するために使う。古いサーバーの応答では undefined。
   */
  aiFields?: AppointmentField[];
  title: string;
  /** YYYY-MM-DD（Asia/Tokyo） */
  date: string | null;
  /** HH:mm（24時間表記） */
  startTime: string | null;
  /** HH:mm（24時間表記） */
  endTime: string | null;
  /** 施設・店・駅・待ち合わせ場所の名前。 */
  location: string;
  /** 会話で話された住所。話されていなければ空文字。 */
  address: string;
  details: string;
  /**
   * 日時の根拠として会話から抜き出した言葉（「明日」「午後2時半」など）。
   * 会話の中にあることを確かめたものだけ。本人が値と見比べるために出す。
   */
  spoken?: { date?: string; time?: string };
  /** AIの日時を採用しなかった理由。なければ undefined か空。 */
  issues?: AppointmentIssue[];
}

export const CALL_ROLES = ['patient', 'hospital'] as const;

export type CallRole = (typeof CALL_ROLES)[number];

/** 通話の段階。ringing の間だけ招待が有効で、ended の後は結果の確認だけができる。 */
export type CallPhase = 'ringing' | 'connected' | 'ending' | 'ended';

/** 通話の記録の1行。seq は通話の中で増え続け、再接続時の読み上げ漏れの判定に使う。 */
export interface CallTurn extends ChatTurn {
  seq: number;
  origin?: SpeechOrigin | 'greeting';
  /** 本人の発言だけにある。相手の端末から報告がまだなければ undefined。 */
  playback?: PlaybackStatus;
  /** 相手の端末で鳴らした声の出どころ。playback と一緒に届く。 */
  playbackEngine?: SpeechEngine;
  /** 本人の発言だけにある。サーバーでの音声の合成の結果。まだなら undefined。 */
  synthesis?: SynthesisStatus;
  synthesisReason?: SynthesisFailureReason;
  /** 本人の発言だけにある。読み直しを頼んだ回数。上限（MAX_REPLAYS_PER_TURN）に達したら本人の画面はボタンを出さない。 */
  replays?: number;
}

export interface CallInvite {
  code: string;
  /** 期限の時刻（UNIXミリ秒） */
  expiresAt: number;
}

export interface SuggestionSet {
  suggestions: SuggestionItem[];
  partnerTranslation?: string;
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
  purpose: CallPurpose;
  /** 本人が入力した相手の名前。なければ空文字。 */
  partnerName: string;
  /** 患者が選択した表示・入力言語（既定は 'ja'）。 */
  userLanguage?: UserLanguage;
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

/**
 * 相手の画面が録音を取り消した理由。画面の動きには使わず、実機で録音できなかったときにサーバーのログで原因を見分ける。
 * - not_ready: マイクの準備ができる前に止めた（STTには何も届いていない）
 * - no_audio: 録音中と表示したのに、マイクの音が1つも届かなかった
 * - mic_*: マイクを開けなかった（許可・端末・ほかのアプリなど）
 */
export const RECORDING_CANCEL_REASONS = [
  'not_ready',
  'no_audio',
  'mic_denied',
  'mic_missing',
  'mic_busy',
  'mic_insecure',
  'mic_unsupported',
  'mic_failed',
] as const;
export type RecordingCancelReason = (typeof RECORDING_CANCEL_REASONS)[number];

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
  /** 録音できたのに文字にならなかった。話した相手の席にだけ送る。 */
  | { type: 'transcript_empty' }
  | { type: 'generating_suggestions' }
  | { type: 'suggestions'; suggestions: SuggestionItem[]; partnerTranslation?: string; ai: AiMeta }
  | {
      type: 'patient_polish_result';
      requestId: string;
      original: string;
      polished: string | null;
      englishNote?: string;
      ai: AiMeta;
    }
  | { type: 'patient_speech'; text: string; origin: SpeechOrigin; seq: number }
  | { type: 'speech_playback'; seq: number; status: PlaybackStatus; engine?: SpeechEngine; durationMs?: number }
  /**
   * サーバーで音声を合成できるか。サーバー全体の情報で、通話の内容を含まない。
   * 使えないと分かっていれば、相手の画面は音声を待たずに端末の声で読む。
   */
  | { type: 'tts_status'; available: boolean }
  /** 本人の発言の音声。相手の席にだけ送る。文は先に patient_speech で届いている。 */
  | ({ type: 'speech_audio'; seq: number } & SpeechAudio)
  /** 本人の発言の音声を作れなかった。相手の席にだけ送る。相手は端末の声で読む。 */
  | { type: 'speech_audio_failed'; seq: number; reason: SynthesisFailureReason }
  /** 音声の合成の結果。本人の席にだけ送る。相手が聞けたかどうかは speech_playback で分かる。 */
  | { type: 'speech_synthesis'; seq: number; status: SynthesisStatus; reason?: SynthesisFailureReason }
  /** 本人が同じ文をもう一度読み上げるよう頼んだ。相手の席にだけ送る。 */
  | { type: 'speech_replay'; seq: number }
  /** 相手の席には、合成済みの音声があれば一緒に送る。 */
  | ({ type: 'patient_typing_notice'; text: string } & Partial<SpeechAudio>)
  | { type: 'patient_speaking_status'; isSpeaking: boolean }
  | { type: 'call_ending' }
  | { type: 'end_call'; appointment: AppointmentDraft; ai: AiMeta };

/** ブラウザからサーバーへ送るメッセージ。席のない接続が送れるのは start_call と join_call だけ。 */
export type ClientMessage =
  | {
      type: 'start_call';
      intent: string;
      purpose?: CallPurpose;
      partnerName?: string;
      voice?: SpeechVoice;
      userLanguage?: UserLanguage;
    }
  | { type: 'join_call'; inviteCode: string }
  | { type: 'join_call'; seatToken: string }
  | { type: 'answer_call' }
  | { type: 'hospital_speaking_start' }
  /**
   * 録音を取り消す（認識の結果を待たない）。reason と prepMs はログで原因を見分けるためだけに使う。
   * prepMs は押してからマイクの準備ができるまでの時間。準備ができる前に止めたときは、押してから止めるまでの時間。
   */
  | { type: 'hospital_speaking_stop'; reason?: RecordingCancelReason; prepMs?: number }
  /** 話し終えた。認識の結果を待って発話にする。prepMs は押してからマイクの準備ができるまでの時間（ログ用）。 */
  | { type: 'hospital_speech_end'; prepMs?: number }
  /** durationMs は、相手の端末で鳴らす音声の長さ（Google音声の started だけ）。本人の画面で残り時間の目安に使う。 */
  | { type: 'speech_playback'; seq: number; status: PlaybackStatus; engine?: SpeechEngine; durationMs?: number }
  /** 本人が、相手の声を自分の端末で聞くかを選ぶ。席に入るたびに送り直す（サーバーは接続ごとに忘れる）。 */
  | { type: 'partner_audio_listen'; enabled: boolean }
  /** 相手の画面が、まだ受け取っていない本人の発言の音声を求める（再接続・再読み込みの後など）。 */
  | { type: 'speech_audio_request'; seq: number }
  /** 本人が、自分の文を相手の端末でもう一度読み上げるよう頼む。新しい発言にはしない。 */
  | { type: 'speech_replay_request'; seq: number }
  | { type: 'patient_typing_notice' }
  | { type: 'patient_polish_request'; requestId: string; text: string }
  | { type: 'patient_confirmed_speech'; text: string; origin: SpeechOrigin }
  | { type: 'patient_speaking_status'; isSpeaking: boolean }
  | { type: 'end_call' }
  | { type: 'reset_call' }
  | { type: 'leave_call' };
