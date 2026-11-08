import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  CALL_ROLES,
  DEFAULT_SPEECH_VOICE,
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  MAX_REPLAYS_PER_TURN,
  TYPING_NOTICE_TEXT,
  buildGreeting,
  keepsSuggestions,
} from '../src/lib/callProtocol';
import type {
  AppointmentResult,
  CallClosedReason,
  CallInvite,
  CallPhase,
  CallRole,
  CallSnapshot,
  CallTurn,
  ChatTurn,
  RecordingFailureReason,
  ServerMessage,
  SpeechEngine,
  SpeechOrigin,
  SpeechStatus,
  SpeechVoice,
  PlaybackStatus,
  SuggestionSet,
} from '../src/lib/callProtocol';
import { DEFAULT_CALL_PURPOSE } from '../src/lib/callPurpose';
import type { CallPurpose } from '../src/lib/callPurpose';
import type { AiAssistant } from './geminiService';
import { DISABLED_SYNTHESIZER } from './speechSynthesizer';
import type { SpeechSynthesizer, SynthesisOutcome } from './speechSynthesizer';

/** 発信のときに本人が決める、通話の前提。 */
export interface CallContext {
  purpose: CallPurpose;
  partnerName: string;
  /** 読み上げの声。省くと既定の声。 */
  voice?: SpeechVoice;
}

export const DEFAULT_CALL_CONTEXT: CallContext = { purpose: DEFAULT_CALL_PURPOSE, partnerName: '' };

/** 1つの発言の音声を作り直せる回数（最初の1回を含む）。 */
const MAX_SYNTHESIS_ATTEMPTS = 2;

/** 通話の中で持っておく音声の数。再接続した相手に送り直すために使い、古いものから捨てる。 */
const MAX_STORED_AUDIO = 40;

/** 1つの発言の音声。結果が出るまでは outcome がない。 */
interface TurnAudio {
  promise: Promise<SynthesisOutcome>;
  outcome?: SynthesisOutcome;
  attempts: number;
}

interface SpeechResult {
  results: { alternatives: { transcript: string }[]; isFinal?: boolean }[];
}

/**
 * 音声認識ストリームのうち、ここで使う部分。
 * 同時録音の枠（limitConcurrentStreams）も同じストリームにリスナーを付けるので、外すのは自分が付けたものだけにする。
 */
export interface RecognizeStream {
  writable: boolean;
  write(chunk: Buffer): unknown;
  end(): unknown;
  /**
   * 結果を待たずに打ち切る。SDKのストリームは打ち切ると 'close' を出し、録音の枠が返る。
   * 持たないストリーム（テストの偽物など）は end() で閉じる。
   */
  destroy?(): unknown;
  on(event: 'data', listener: (data: SpeechResult) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'end', listener: () => void): this;
  off(event: 'data', listener: (data: SpeechResult) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  off(event: 'end', listener: () => void): this;
}

/** 開いている認識ストリームと、この通話が付けたリスナーを外す関数。 */
interface Recognition {
  stream: RecognizeStream;
  detach(): void;
}

/** 閉じた後のエラーで EventEmitter が例外を投げないよう、外した代わりに残すリスナー。 */
const ignoreStreamError = () => {};

/** 結果を使わないストリームを閉じる。待たずに打ち切り、録音の枠とSTTの接続をすぐに返す。 */
function abandonStream(stream: RecognizeStream): void {
  if (stream.destroy) {
    stream.destroy();
  } else {
    stream.end();
  }
}

/**
 * 話し終えてから、最終の認識結果を待つ上限。
 * STTは送信を閉じた後に最終結果を返すので、待たないと文末が欠ける。届かなければ途中の結果で確定する。
 */
export const FINAL_TRANSCRIPT_WAIT_MS = 2_000;

/**
 * 1回の発話の認識結果。
 * 間を置いて話すとSTTは前半を確定して次の結果を始めるので、確定した部分を積み上げ、途中の部分だけを置き換える。
 */
class SpeechCapture {
  private finalText = '';
  private interimText = '';

  apply(data: SpeechResult): void {
    if (data.results.length === 0) return;
    let interim = '';
    for (const result of data.results) {
      const transcript = result.alternatives[0]?.transcript ?? '';
      if (result.isFinal) {
        this.finalText += transcript;
      } else {
        interim += transcript;
      }
    }
    this.interimText = interim;
  }

  get text(): string {
    return (this.finalText + this.interimText).trim();
  }

  get hasInterim(): boolean {
    return this.interimText.trim() !== '';
  }
}

/**
 * 送信を閉じ、残りの認識結果が届くのを待つ。エラーや時間切れでも、それまでの結果で進める。
 * 時間内に終わらなければ打ち切る。開いたままだと、同時録音の枠とSTTの接続が残り続ける。
 */
function settleRecognition(stream: RecognizeStream, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ended: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off('end', onEnd);
      stream.off('error', onError);
      if (!ended) abandonStream(stream);
      resolve(ended);
    };
    const onEnd = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.end();
  });
}

export interface SpeechRecognizer {
  readonly status: SpeechStatus;
  /** 状態が変わるたびに呼ぶ。戻り値の関数で購読をやめる。 */
  onStatusChange(listener: (status: SpeechStatus) => void): () => void;
  /** 認識ストリームを作る。作れないときは例外を投げる。 */
  createStream(): RecognizeStream;
}

/** 席に座る接続。WebSocketに依存させず、通話の処理を読みやすくする。 */
export interface CallPeer {
  send(message: ServerMessage): void;
  /** 席から外す。evicted は同じ席に新しい接続が入った場合で、この接続を閉じる。 */
  release(reason: 'call_closed' | 'evicted'): void;
}

export interface CallLimits {
  /** 招待の有効期限。応答がなければ通話を閉じる。 */
  inviteTtlMs: number;
  /** 切断から再接続を待つ時間。 */
  reconnectGraceMs: number;
  /** 通話終了後に、再読み込みに備えて結果を残す時間。 */
  endedRetentionMs: number;
  /** 開いたままの画面で通話が残り続けないようにする上限。 */
  maxCallDurationMs: number;
  /** 同時に存在できる通話の数。 */
  maxActiveCalls: number;
  /** 同時に受け入れるWebSocketの数。 */
  maxConnections: number;
  /** 1接続が1分間に送れる制御メッセージの数。音声は含まない。 */
  maxMessagesPerMinute: number;
  /** 1通話で依頼できるAI整形の回数。 */
  maxPolishRequestsPerCall: number;
  /** 1通話でサーバーが音声にする文字数。超えた分は相手の端末の声で読む。 */
  maxSpeechCharsPerCall: number;
  /** 切れた接続を見つけるPingの間隔。 */
  heartbeatIntervalMs: number;
  /** 通話に入っていない接続を閉じるまでの時間。判定はPingの間隔ごと。 */
  idleConnectionMs: number;
}

export const DEFAULT_CALL_LIMITS: CallLimits = {
  inviteTtlMs: 10 * 60 * 1000,
  reconnectGraceMs: 2 * 60 * 1000,
  endedRetentionMs: 10 * 60 * 1000,
  maxCallDurationMs: 60 * 60 * 1000,
  maxActiveCalls: 50,
  maxConnections: 200,
  maxMessagesPerMinute: 120,
  maxPolishRequestsPerCall: 100,
  maxSpeechCharsPerCall: 5_000,
  heartbeatIntervalMs: 30 * 1000,
  idleConnectionMs: 10 * 60 * 1000,
};

export interface CallRoomDeps {
  ai: AiAssistant;
  speech: SpeechRecognizer;
  limits: CallLimits;
  /** 本人の文の音声合成。省くと使わない（相手の端末の声で読む）。 */
  tts?: SpeechSynthesizer;
}

type TimerName = 'invite' | 'lifetime' | 'abandon' | 'retention';

interface Seat {
  /** 再接続に使う秘密の値。null の席には入れない。 */
  token: string | null;
  peer: CallPeer | null;
}

export function logEvent(
  severity: 'INFO' | 'WARNING' | 'ERROR',
  message: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ severity, message, ...fields });
  if (severity === 'INFO') {
    console.log(line);
  } else {
    console.warn(line);
  }
}

function generateSeatToken(): string {
  return randomBytes(32).toString('base64url');
}

function generateInviteCode(): string {
  return Array.from(
    { length: INVITE_CODE_LENGTH },
    () => INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)],
  ).join('');
}

/** 長さが違っても比較できるよう、ハッシュをそろえてから一定時間で比べる。 */
function secureEquals(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function otherRole(role: CallRole): CallRole {
  return role === 'patient' ? 'hospital' : 'patient';
}

/**
 * 通話1件分の状態。
 *
 * 相手に届く文の経路は speak だけで、サーバーはその文を書き換えない。
 * AIの整形案と返答候補は患者にだけ返すので、本人が確定するまで相手には届かない。
 *
 * メッセージの送り先はこの通話の席だけなので、別の通話へは届かない。
 * AIの結果を待っている間に通話が閉じたら、isClosed を見て結果を捨てる。
 */
export class CallRoom {
  /** ログで通話を見分けるためのID。これだけでは参加できない。 */
  readonly id = randomUUID();
  phase: CallPhase = 'ringing';

  private readonly seats: Record<CallRole, Seat> = {
    patient: { token: generateSeatToken(), peer: null },
    hospital: { token: null, peer: null },
  };
  private readonly timers = new Map<TimerName, NodeJS.Timeout>();
  private invite: CallInvite | null;
  private intent: string;
  private readonly purpose: CallPurpose;
  private partnerName: string;
  private turns: CallTurn[] = [];
  private nextSeq = 1;
  private speechCapture: SpeechCapture | null = null;
  private isHospitalRecording = false;
  private isPatientSpeaking = false;
  private recognition: Recognition | null = null;
  // 新しい番が始まったら増やし、古い番の返答候補を捨てる。
  private suggestionTurn = 0;
  private isGeneratingSuggestions = false;
  private suggestions: SuggestionSet | null = null;
  private appointment: AppointmentResult | null = null;
  private polishRequests = 0;
  private isClosed = false;
  private readonly voice: SpeechVoice;
  // 発言の番号ごとの音声。相手が再接続したら、ここから送り直す。通話を閉じたら消す。
  private speechAudio = new Map<number, TurnAudio>();
  // あいさつは本人が発信前に確認した文なので、相手が着信画面を開いた時点で作り始める。
  private greetingAudio: Promise<SynthesisOutcome> | null = null;
  private synthesizedChars = 0;
  private replays = new Map<number, number>();

  constructor(
    private readonly deps: CallRoomDeps,
    intent: string,
    private readonly onClosed: (room: CallRoom) => void,
    context: CallContext = DEFAULT_CALL_CONTEXT,
  ) {
    const { inviteTtlMs, maxCallDurationMs } = deps.limits;
    this.intent = intent;
    this.purpose = context.purpose;
    this.partnerName = context.partnerName;
    this.voice = context.voice ?? DEFAULT_SPEECH_VOICE;
    this.invite = { code: generateInviteCode(), expiresAt: Date.now() + inviteTtlMs };
    this.setTimer('invite', inviteTtlMs, () => this.close('invite_expired'));
    this.setTimer('lifetime', maxCallDurationMs, () => this.close('time_limit'));
    logEvent('INFO', 'call_created', { callId: this.id });
  }

  roleForToken(token: string): CallRole | null {
    const role = CALL_ROLES.find((candidate) => {
      const seatToken = this.seats[candidate].token;
      return seatToken !== null && secureEquals(seatToken, token);
    });
    return role ?? null;
  }

  matchesInvite(code: string): boolean {
    return this.invite !== null && secureEquals(this.invite.code, code);
  }

  /**
   * 招待で病院の席を作る。前の席のトークンは無効になる。
   * 招待は応答するまで残すので、タブを閉じてもリンクを開き直せる。応答後は使えない。
   */
  openHospitalSeat(): void {
    this.seats.hospital.token = generateSeatToken();
  }

  /** 席に接続を入れ、通話の現在の状態を渡す。前の接続が残っていれば追い出す。 */
  takeSeat(role: CallRole, peer: CallPeer): void {
    const seat = this.seats[role];
    const previous = seat.peer;
    if (previous) {
      this.stopActivity(role);
      seat.peer = null;
      previous.release('evicted');
    }

    seat.peer = peer;
    peer.send({
      type: 'call_joined',
      role,
      seatToken: seat.token as string,
      snapshot: this.snapshotFor(role),
    });
    if (!previous) this.sendTo(otherRole(role), { type: 'peer_status', connected: true });
    if (role === 'hospital' && this.phase === 'ringing') this.prepareGreetingAudio();
    this.refreshAbandonTimer();
    logEvent('INFO', 'call_joined', { callId: this.id, role });
  }

  /** 接続が切れた。席は残すので、トークンを持っていれば戻れる。 */
  handleDisconnect(peer: CallPeer): void {
    const role = CALL_ROLES.find((candidate) => this.seats[candidate].peer === peer);
    if (role) this.vacate(role);
  }

  /** 本人の操作で席を手放す。トークンも無効にする。招待が残っていれば別の人が入れる。 */
  leave(role: CallRole): void {
    const peer = this.seats[role].peer;
    this.seats[role].token = null;
    this.vacate(role);
    peer?.release('call_closed');
    logEvent('INFO', 'call_left', { callId: this.id, role });
  }

  answer(): void {
    this.phase = 'connected';
    this.invite = null;
    this.clearTimer('invite');
    const text = buildGreeting(this.intent, this.purpose);
    const seq = this.addTurn({ sender: '患者', text, origin: 'greeting' });
    this.broadcast({ type: 'answer_call', text, seq });
    this.startSynthesis(seq, text, this.greetingAudio ?? undefined);
    this.greetingAudio = null;
    // 応答の前に患者が切断していても、通話が始まったので片付けの対象ではなくなる。
    this.refreshAbandonTimer();
  }

  startRecording(): void {
    this.speechCapture = new SpeechCapture();
    this.isHospitalRecording = this.openRecognitionStream();
    // 画面はこの配信を受け付けの合図にして、届くまで録音中と表示しない。
    if (this.isHospitalRecording) {
      this.broadcast({ type: 'hospital_speaking_start' });
    } else {
      this.sendTo('hospital', { type: 'hospital_recording_failed', reason: 'start_failed' });
    }
  }

  stopRecording(): void {
    this.isHospitalRecording = false;
    this.speechCapture = null;
    this.closeRecognitionStream();
    this.broadcast({ type: 'hospital_speaking_stop' });
  }

  writeAudio(chunk: Buffer): void {
    const stream = this.recognition?.stream;
    if (this.isHospitalRecording && stream?.writable) {
      stream.write(chunk);
    }
  }

  async finishHospitalSpeech(): Promise<void> {
    const capture = this.speechCapture;
    const recognition = this.recognition;
    this.speechCapture = null;
    this.recognition = null;
    this.isHospitalRecording = false;

    if (recognition) {
      const startedAt = Date.now();
      const ended = await settleRecognition(recognition.stream, FINAL_TRANSCRIPT_WAIT_MS);
      // 待ち終えた後に遅れて届く結果は、確定した発話に足さない。
      recognition.detach();
      // 本文は残さない。待ち時間と、途中の結果のまま確定したかだけを記録する。
      logEvent('INFO', 'stt_settled', {
        callId: this.id,
        waitMs: Date.now() - startedAt,
        ended,
        usedInterim: capture?.hasInterim ?? false,
      });
    }
    // 待っている間に通話が終わったら、発話として扱わない。
    if (this.isClosed || this.phase !== 'connected') return;

    const utterance = capture?.text ?? '';

    if (!utterance) {
      this.broadcast({ type: 'hospital_speaking_stop' });
      // 話したのに何も表示されないと、相手は届いたと思い込む。録音が失敗した後の終わりの合図では知らせない。
      if (recognition) this.sendTo('hospital', { type: 'transcript_empty' });
      return;
    }

    const seq = this.addTurn({ sender: '病院受付', text: utterance });
    this.broadcast({ type: 'transcript_final', text: utterance, seq });

    this.suggestionTurn += 1;
    const turn = this.suggestionTurn;
    this.isGeneratingSuggestions = true;
    this.suggestions = null;
    this.sendTo('patient', { type: 'generating_suggestions' });

    const result = await this.deps.ai.suggestReplies({
      ...this.aiContext(),
      history: this.conversation(),
      latestUtterance: utterance,
    });

    if (this.isClosed || turn !== this.suggestionTurn) return;
    this.isGeneratingSuggestions = false;
    this.suggestions = { suggestions: result.suggestions, ai: result.ai };
    this.sendTo('patient', { type: 'suggestions', ...this.suggestions });
  }

  /** 本人が確定した文を相手に届ける唯一の経路。文は書き換えない。 */
  speak(text: string, origin: SpeechOrigin): void {
    // 本人が返答したので、生成中の候補が後から届いても表示しない。
    // 即答フレーズと登録した文は会話をつなぐ文なので、候補はそのまま使えるよう残す。
    if (!keepsSuggestions(origin)) this.discardSuggestions();
    const seq = this.addTurn({ sender: '患者', text, origin });
    logEvent('INFO', 'patient_speech', { callId: this.id, origin, length: text.length });
    this.broadcast({ type: 'patient_speech', text, origin, seq });
    // 文は先に届け、音声は後から送る。相手の画面は番号の順に待って読むので、順序は崩れない。
    this.startSynthesis(seq, text);
  }

  /**
   * 相手の画面が、まだ受け取っていない音声を求めた（再接続・再読み込みの後など）。
   * 作り終えた音声があれば送り直し、失敗していれば一度だけ作り直す。結果は相手の席にだけ返す。
   */
  requestSpeechAudio(seq: number): void {
    const turn = this.patientTurn(seq);
    if (!turn) return;
    const entry = this.speechAudio.get(seq);
    const outcome = entry?.outcome;
    const canRetry = !entry || (outcome !== undefined && !outcome.ok && outcome.reason !== 'quota');
    if (entry && (!canRetry || entry.attempts >= MAX_SYNTHESIS_ATTEMPTS)) {
      void entry.promise.then((result) => {
        if (!this.isClosed && this.speechAudio.get(seq) === entry) this.sendAudioToHospital(seq, result);
      });
      return;
    }
    this.startSynthesis(seq, turn.text, undefined, (entry?.attempts ?? 0) + 1);
  }

  /**
   * 本人が、自分の文を相手の端末でもう一度読み上げるよう頼んだ。新しい発言にはしない。
   * 回数に上限を設け、押し続けても相手の端末で鳴り続けないようにする。
   */
  replaySpeech(seq: number): boolean {
    const turn = this.patientTurn(seq);
    const count = this.replays.get(seq) ?? 0;
    if (!turn || count >= MAX_REPLAYS_PER_TURN) return false;
    this.replays.set(seq, count + 1);
    turn.playback = undefined;
    turn.playbackEngine = undefined;
    this.sendTo('hospital', { type: 'speech_replay', seq });
    return true;
  }

  /**
   * 相手の端末が読み上げた結果を本人に知らせる。本人の発言でない番号は無視する。
   * 読み終えた後に始まりの報告が遅れて届いても、終わった状態を戻さない。
   */
  reportPlayback(seq: number, status: PlaybackStatus, engine?: SpeechEngine): void {
    const turn = this.patientTurn(seq);
    if (!turn) return;
    const isFinal = turn.playback === 'ended' || turn.playback === 'failed';
    if ((status === 'started' || status === 'blocked') && isFinal) return;
    turn.playback = status;
    turn.playbackEngine = engine;
    this.sendTo('patient', { type: 'speech_playback', seq, status, ...(engine ? { engine } : {}) });
    if (status === 'failed' || status === 'blocked') {
      logEvent('WARNING', 'playback_failed', { callId: this.id, status, engine });
    }
  }

  async polish(requestId: string, text: string): Promise<void> {
    if (this.polishRequests >= this.deps.limits.maxPolishRequestsPerCall) {
      this.sendPolishFailure(requestId, 'rate_limited');
      return;
    }
    this.polishRequests += 1;

    const result = await this.deps.ai.polishText({
      ...this.aiContext(),
      text,
      history: this.conversation(),
    });

    if (this.isClosed) return;
    this.sendTo('patient', {
      type: 'patient_polish_result',
      requestId,
      original: result.original,
      polished: result.polished,
      ai: result.ai,
    });
  }

  /** 依頼の内容を使えないことを本人に返し、画面を待たせない。 */
  sendPolishFailure(requestId: string, reason: 'invalid_request' | 'rate_limited'): void {
    this.sendTo('patient', {
      type: 'patient_polish_result',
      requestId,
      original: '',
      polished: null,
      ai: { source: 'fallback', reason },
    });
  }

  /**
   * 「入力中です」の自動案内。決まった文なので、作り置きの音声があれば一緒に送る。
   * 音声を待つと、直後に送った本人の文より後に届いて順序が逆になるので、待たない。
   */
  notifyTyping(): void {
    const text = TYPING_NOTICE_TEXT;
    const audio = this.tts.cachedAudio(text, this.voice);
    this.sendTo('patient', { type: 'patient_typing_notice', text });
    this.sendTo('hospital', { type: 'patient_typing_notice', text, ...(audio ?? {}) });
    // 作り置きがなければ次のために作る。決まった文は通話ごとの上限に数えない。
    if (!audio && this.tts.available) void this.tts.synthesize(text, this.voice);
  }

  setPatientSpeaking(isSpeaking: boolean): void {
    this.isPatientSpeaking = isSpeaking;
    this.broadcast({ type: 'patient_speaking_status', isSpeaking });
  }

  async end(): Promise<void> {
    this.phase = 'ending';
    this.isHospitalRecording = false;
    this.closeRecognitionStream();
    this.speechCapture = null;
    this.discardSuggestions();
    this.isPatientSpeaking = false;
    this.broadcast({ type: 'call_ending' });

    const result = await this.deps.ai.extractAppointment({
      ...this.aiContext(),
      history: this.conversation(),
    });

    if (this.isClosed) return;
    this.phase = 'ended';
    this.intent = '';
    // 読み取った予定は本人のものなので、病院の席には送らない。
    this.appointment = { appointment: result.appointment, ai: result.ai };
    this.sendTo('patient', { type: 'end_call', ...this.appointment });
    this.setTimer('retention', this.deps.limits.endedRetentionMs, () =>
      this.close('retention_expired'),
    );
  }

  /**
   * 通話を閉じる。タイマーと音声認識を止め、本文を残さない。
   * 一覧から外れるので、席のトークンと招待はここで使えなくなる。
   */
  close(reason: CallClosedReason): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
    this.isHospitalRecording = false;
    this.closeRecognitionStream();

    CALL_ROLES.forEach((role) => {
      const seat = this.seats[role];
      const peer = seat.peer;
      seat.peer = null;
      peer?.send({ type: 'call_closed', reason });
      peer?.release('call_closed');
    });

    this.invite = null;
    this.intent = '';
    this.partnerName = '';
    this.turns = [];
    this.speechCapture = null;
    this.suggestions = null;
    this.appointment = null;
    this.speechAudio.clear();
    this.greetingAudio = null;
    this.onClosed(this);
    logEvent('INFO', 'call_closed', { callId: this.id, reason });
  }

  private snapshotFor(role: CallRole): CallSnapshot {
    const forPatient = role === 'patient';
    return {
      phase: this.phase,
      purpose: this.purpose,
      partnerName: this.partnerName,
      turns: this.turns.map((turn) => ({ ...turn })),
      peerConnected: this.seats[otherRole(role)].peer !== null,
      isHospitalSpeaking: this.isHospitalRecording,
      isPatientSpeaking: this.isPatientSpeaking,
      isGeneratingSuggestions: forPatient && this.isGeneratingSuggestions,
      suggestions: forPatient ? this.suggestions : null,
      appointment: forPatient ? this.appointment : null,
      invite: forPatient ? this.invite : null,
    };
  }

  private get tts(): SpeechSynthesizer {
    return this.deps.tts ?? DISABLED_SYNTHESIZER;
  }

  private patientTurn(seq: number): CallTurn | null {
    const turn = this.turns.find((candidate) => candidate.seq === seq);
    return turn && turn.sender === '患者' ? turn : null;
  }

  private prepareGreetingAudio(): void {
    if (this.greetingAudio || !this.tts.available) return;
    this.greetingAudio = this.synthesizeText(buildGreeting(this.intent, this.purpose));
  }

  /**
   * 文を音声にする。作り置きのある決まった文は通話ごとの上限に数えない。
   * 使えない・上限を超えたときは、待たずに失敗を返す。
   */
  private synthesizeText(text: string): Promise<SynthesisOutcome> {
    const tts = this.tts;
    if (!tts.available) return Promise.resolve({ ok: false, reason: 'unavailable' });
    const cached = tts.cachedAudio(text, this.voice);
    if (cached) return Promise.resolve({ ok: true, cached: true, ...cached });
    if (this.synthesizedChars + text.length > this.deps.limits.maxSpeechCharsPerCall) {
      logEvent('WARNING', 'tts_call_limit_reached', { callId: this.id });
      return Promise.resolve({ ok: false, reason: 'quota' });
    }
    this.synthesizedChars += text.length;
    return tts.synthesize(text, this.voice);
  }

  /** 発言の音声を作り始め、できたら相手に送り、本人に結果を知らせる。 */
  private startSynthesis(
    seq: number,
    text: string,
    existing?: Promise<SynthesisOutcome>,
    attempts = 1,
  ): void {
    const entry: TurnAudio = { promise: existing ?? this.synthesizeText(text), attempts };
    this.speechAudio.set(seq, entry);
    while (this.speechAudio.size > MAX_STORED_AUDIO) {
      const oldest = this.speechAudio.keys().next().value as number;
      this.speechAudio.delete(oldest);
    }
    void entry.promise.then((outcome) => {
      entry.outcome = outcome;
      if (this.isClosed || this.speechAudio.get(seq) !== entry) return;
      const turn = this.patientTurn(seq);
      if (turn) {
        turn.synthesis = outcome.ok ? 'ready' : 'failed';
        turn.synthesisReason = outcome.ok ? undefined : outcome.reason;
      }
      this.sendTo('patient', {
        type: 'speech_synthesis',
        seq,
        status: outcome.ok ? 'ready' : 'failed',
        ...(outcome.ok ? {} : { reason: outcome.reason }),
      });
      this.sendAudioToHospital(seq, outcome);
    });
  }

  private sendAudioToHospital(seq: number, outcome: SynthesisOutcome): void {
    if (outcome.ok) {
      this.sendTo('hospital', { type: 'speech_audio', seq, audio: outcome.audio, mimeType: outcome.mimeType });
    } else {
      this.sendTo('hospital', { type: 'speech_audio_failed', seq, reason: outcome.reason });
    }
  }

  private sendTo(role: CallRole, message: ServerMessage): void {
    this.seats[role].peer?.send(message);
  }

  private broadcast(message: ServerMessage): void {
    CALL_ROLES.forEach((role) => this.sendTo(role, message));
  }

  private addTurn(turn: Omit<CallTurn, 'seq'>): number {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    this.turns.push({ ...turn, seq });
    return seq;
  }

  private aiContext() {
    return { intent: this.intent, purpose: this.purpose, partnerName: this.partnerName };
  }

  /** AIには発言者と本文だけを渡す。 */
  private conversation(): ChatTurn[] {
    return this.turns.map(({ sender, text }) => ({ sender, text }));
  }

  private discardSuggestions(): void {
    this.suggestionTurn += 1;
    this.isGeneratingSuggestions = false;
    this.suggestions = null;
  }

  private vacate(role: CallRole): void {
    this.stopActivity(role);
    this.seats[role].peer = null;
    this.sendTo(otherRole(role), { type: 'peer_status', connected: false });
    this.refreshAbandonTimer();
  }

  /** いなくなった席の「話している」状態を解除する。残すと相手の入力やPTTが止まったままになる。 */
  private stopActivity(role: CallRole): void {
    if (role === 'hospital' && this.isHospitalRecording) {
      this.abortRecording('stream_failed');
    }
    if (role === 'patient' && this.isPatientSpeaking) {
      this.setPatientSpeaking(false);
    }
  }

  /** 録音中に認識が止まったら、話し続けて音声を失わないよう本人に知らせる。途中の文は確定しない。 */
  private abortRecording(reason: RecordingFailureReason): void {
    this.isHospitalRecording = false;
    this.speechCapture = null;
    this.closeRecognitionStream();
    this.sendTo('hospital', { type: 'hospital_recording_failed', reason });
    this.broadcast({ type: 'hospital_speaking_stop' });
  }

  /** 認識ストリームを開く。開けたかどうかを返す。 */
  private openRecognitionStream(): boolean {
    this.closeRecognitionStream();
    // 開き直しても同じ発話の結果に積み上げる。
    const capture = this.speechCapture;
    let stream: RecognizeStream;
    try {
      stream = this.deps.speech.createStream();
    } catch (error) {
      logEvent('ERROR', 'stt_setup_failed', {
        callId: this.id,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return false;
    }

    const onError = (error: Error) => {
      // 話し終えて結果を待っているストリームの失敗は、settleRecognition が受け取る。
      if (stream !== this.recognition?.stream) return;
      if (error.message?.includes('Long duration elapsed without audio')) {
        if (this.isHospitalRecording && !this.openRecognitionStream()) {
          this.abortRecording('stream_failed');
        }
        return;
      }
      logEvent('ERROR', 'stt_stream_failed', { callId: this.id, errorName: error.name });
      this.abortRecording('stream_failed');
    };
    const onData = (data: SpeechResult) => this.handleSpeechData(capture, data);
    let detached = false;
    stream.on('error', onError);
    stream.on('data', onData);
    this.recognition = {
      stream,
      // 枠を返すリスナーなど、ほかの処理が付けたリスナーは残す。
      detach: () => {
        if (detached) return;
        detached = true;
        stream.off('data', onData);
        stream.off('error', onError);
        stream.on('error', ignoreStreamError);
      },
    };
    return true;
  }

  /** 録音をやめたストリームを閉じる。結果は使わないので、待たずに打ち切る。 */
  private closeRecognitionStream(): void {
    const recognition = this.recognition;
    if (!recognition) return;
    this.recognition = null;
    recognition.detach();
    abandonStream(recognition.stream);
  }

  /** 話し終えた後に届いた結果も発話には加える。画面へ送るのは録音中の発話だけ。 */
  private handleSpeechData(capture: SpeechCapture | null, data: SpeechResult): void {
    if (!capture) return;
    capture.apply(data);
    if (!this.isHospitalRecording || capture !== this.speechCapture) return;
    const text = capture.text;
    if (text) this.broadcast({ type: 'transcript_interim', text });
  }

  /**
   * 誰も戻らない通話を片付ける。
   * 発信前に患者がいなくなった場合と、両方がいなくなった場合に、猶予の後で閉じる。
   */
  private refreshAbandonTimer(): void {
    const patientGone = this.seats.patient.peer === null;
    const hospitalGone = this.seats.hospital.peer === null;
    if (patientGone && (hospitalGone || this.phase === 'ringing')) {
      if (!this.timers.has('abandon')) {
        this.setTimer('abandon', this.deps.limits.reconnectGraceMs, () => this.close('abandoned'));
      }
    } else {
      this.clearTimer('abandon');
    }
  }

  private setTimer(name: TimerName, delayMs: number, action: () => void): void {
    this.clearTimer(name);
    const timer = setTimeout(action, delayMs);
    // テストやサーバーの終了を止めない。
    timer.unref();
    this.timers.set(name, timer);
  }

  private clearTimer(name: TimerName): void {
    const timer = this.timers.get(name);
    if (timer) clearTimeout(timer);
    this.timers.delete(name);
  }
}

/** 進行中の通話の一覧。同時に動く通話は少ないので、探すときは順に比べる。 */
export class CallRegistry {
  private readonly rooms = new Set<CallRoom>();

  constructor(private readonly deps: CallRoomDeps) {}

  get activeCalls(): number {
    return this.rooms.size;
  }

  /** 通話を作る。上限に達していれば null を返す。 */
  create(intent: string, context: CallContext = DEFAULT_CALL_CONTEXT): CallRoom | null {
    if (this.rooms.size >= this.deps.limits.maxActiveCalls) return null;
    const room = new CallRoom(this.deps, intent, (closed) => this.rooms.delete(closed), context);
    this.rooms.add(room);
    return room;
  }

  findByInvite(code: string): CallRoom | null {
    return [...this.rooms].find((room) => room.matchesInvite(code)) ?? null;
  }

  findSeat(token: string): { room: CallRoom; role: CallRole } | null {
    for (const room of this.rooms) {
      const role = room.roleForToken(token);
      if (role) return { room, role };
    }
    return null;
  }

  closeAll(reason: CallClosedReason): void {
    [...this.rooms].forEach((room) => room.close(reason));
  }
}
