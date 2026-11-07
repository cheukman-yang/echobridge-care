import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  CALL_ROLES,
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  TYPING_NOTICE_TEXT,
  buildGreeting,
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
  SpeechOrigin,
  SpeechStatus,
  SuggestionSet,
} from '../src/lib/callProtocol';
import type { AiAssistant } from './geminiService';

interface SpeechResult {
  results: { alternatives: { transcript: string }[] }[];
}

/** 音声認識ストリームのうち、ここで使う部分。 */
export interface RecognizeStream {
  writable: boolean;
  write(chunk: Buffer): unknown;
  end(): unknown;
  on(event: 'data', listener: (data: SpeechResult) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  removeAllListeners(event: string): this;
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
  /** 切れた接続を見つけるPingの間隔。 */
  heartbeatIntervalMs: number;
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
  heartbeatIntervalMs: 30 * 1000,
};

export interface CallRoomDeps {
  ai: AiAssistant;
  speech: SpeechRecognizer;
  limits: CallLimits;
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
  private turns: CallTurn[] = [];
  private nextSeq = 1;
  private hospitalTranscript = '';
  private isHospitalRecording = false;
  private isPatientSpeaking = false;
  private recognizeStream: RecognizeStream | null = null;
  // 新しい番が始まったら増やし、古い番の返答候補を捨てる。
  private suggestionTurn = 0;
  private isGeneratingSuggestions = false;
  private suggestions: SuggestionSet | null = null;
  private appointment: AppointmentResult | null = null;
  private polishRequests = 0;
  private isClosed = false;

  constructor(
    private readonly deps: CallRoomDeps,
    intent: string,
    private readonly onClosed: (room: CallRoom) => void,
  ) {
    const { inviteTtlMs, maxCallDurationMs } = deps.limits;
    this.intent = intent;
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
    const text = buildGreeting(this.intent);
    const seq = this.addTurn({ sender: '患者', text, origin: 'greeting' });
    this.broadcast({ type: 'answer_call', text, seq });
    // 応答の前に患者が切断していても、通話が始まったので片付けの対象ではなくなる。
    this.refreshAbandonTimer();
  }

  startRecording(): void {
    this.hospitalTranscript = '';
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
    this.closeRecognitionStream();
    this.broadcast({ type: 'hospital_speaking_stop' });
  }

  writeAudio(chunk: Buffer): void {
    if (this.isHospitalRecording && this.recognizeStream?.writable) {
      this.recognizeStream.write(chunk);
    }
  }

  async finishHospitalSpeech(): Promise<void> {
    this.isHospitalRecording = false;
    this.closeRecognitionStream();

    const utterance = this.hospitalTranscript.trim();
    this.hospitalTranscript = '';

    if (!utterance) {
      this.broadcast({ type: 'hospital_speaking_stop' });
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
      intent: this.intent,
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
    this.discardSuggestions();
    const seq = this.addTurn({ sender: '患者', text, origin });
    logEvent('INFO', 'patient_speech', { callId: this.id, origin, length: text.length });
    this.broadcast({ type: 'patient_speech', text, origin, seq });
  }

  async polish(requestId: string, text: string): Promise<void> {
    if (this.polishRequests >= this.deps.limits.maxPolishRequestsPerCall) {
      this.sendPolishFailure(requestId, 'rate_limited');
      return;
    }
    this.polishRequests += 1;

    const result = await this.deps.ai.polishText({
      text,
      intent: this.intent,
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

  notifyTyping(): void {
    this.broadcast({ type: 'patient_typing_notice', text: TYPING_NOTICE_TEXT });
  }

  setPatientSpeaking(isSpeaking: boolean): void {
    this.isPatientSpeaking = isSpeaking;
    this.broadcast({ type: 'patient_speaking_status', isSpeaking });
  }

  async end(): Promise<void> {
    this.phase = 'ending';
    this.isHospitalRecording = false;
    this.closeRecognitionStream();
    this.hospitalTranscript = '';
    this.discardSuggestions();
    this.isPatientSpeaking = false;
    this.broadcast({ type: 'call_ending' });

    const result = await this.deps.ai.extractAppointment({
      intent: this.intent,
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
    this.turns = [];
    this.hospitalTranscript = '';
    this.suggestions = null;
    this.appointment = null;
    this.onClosed(this);
    logEvent('INFO', 'call_closed', { callId: this.id, reason });
  }

  private snapshotFor(role: CallRole): CallSnapshot {
    const forPatient = role === 'patient';
    return {
      phase: this.phase,
      turns: [...this.turns],
      peerConnected: this.seats[otherRole(role)].peer !== null,
      isHospitalSpeaking: this.isHospitalRecording,
      isPatientSpeaking: this.isPatientSpeaking,
      isGeneratingSuggestions: forPatient && this.isGeneratingSuggestions,
      suggestions: forPatient ? this.suggestions : null,
      appointment: forPatient ? this.appointment : null,
      invite: forPatient ? this.invite : null,
    };
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
    this.hospitalTranscript = '';
    this.closeRecognitionStream();
    this.sendTo('hospital', { type: 'hospital_recording_failed', reason });
    this.broadcast({ type: 'hospital_speaking_stop' });
  }

  /** 認識ストリームを開く。開けたかどうかを返す。 */
  private openRecognitionStream(): boolean {
    this.closeRecognitionStream();
    try {
      this.recognizeStream = this.deps.speech
        .createStream()
        .on('error', (error: Error) => {
          if (error.message?.includes('Long duration elapsed without audio')) {
            if (this.isHospitalRecording && !this.openRecognitionStream()) {
              this.abortRecording('stream_failed');
            }
            return;
          }
          logEvent('ERROR', 'stt_stream_failed', { callId: this.id, errorName: error.name });
          this.abortRecording('stream_failed');
        })
        .on('data', (data: SpeechResult) => this.handleSpeechData(data));
      return true;
    } catch (error) {
      logEvent('ERROR', 'stt_setup_failed', {
        callId: this.id,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return false;
    }
  }

  private closeRecognitionStream(): void {
    const stream = this.recognizeStream;
    if (!stream) return;
    this.recognizeStream = null;
    stream.removeAllListeners('data');
    stream.removeAllListeners('error');
    // 閉じる途中のエラーでプロセスが落ちないよう、リスナーを残す。
    stream.on('error', () => {});
    stream.end();
  }

  private handleSpeechData(data: SpeechResult): void {
    if (!this.isHospitalRecording) return;
    const transcript = data.results[0]?.alternatives[0]?.transcript;
    if (transcript) {
      this.hospitalTranscript = transcript;
      this.broadcast({ type: 'transcript_interim', text: transcript });
    }
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
  create(intent: string): CallRoom | null {
    if (this.rooms.size >= this.deps.limits.maxActiveCalls) return null;
    const room = new CallRoom(this.deps, intent, (closed) => this.rooms.delete(closed));
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
