import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { z } from 'zod';
import {
  CALL_SOCKET_PATH,
  CLOSE_CODE_IDLE,
  CLOSE_CODE_SEAT_TAKEN,
  DEFAULT_SPEECH_VOICE,
  MAX_PATIENT_TEXT_LENGTH,
  PLAYBACK_STATUSES,
  RECORDING_CANCEL_REASONS,
  SPEECH_ENGINES,
  SPEECH_ORIGINS,
  SPEECH_VOICES,
  normalizeInviteCode,
} from '../src/lib/callProtocol';
import {
  CALL_PURPOSES,
  DEFAULT_CALL_PURPOSE,
  MAX_PARTNER_NAME_LENGTH,
  normalizePartnerName,
} from '../src/lib/callPurpose';
import type {
  CallErrorCode,
  CallPhase,
  CallRole,
  ClientMessage,
  ServerMessage,
} from '../src/lib/callProtocol';
import { CallRegistry, DEFAULT_CALL_LIMITS, logEvent } from './callRoom';
import type { CallLimits, CallPeer, CallRoom, SpeechRecognizer } from './callRoom';
import type { AiAssistant } from './geminiService';
import { DISABLED_SYNTHESIZER } from './speechSynthesizer';
import type { SpeechSynthesizer } from './speechSynthesizer';

export type { RecognizeStream, SpeechRecognizer } from './callRoom';

/** 制御メッセージは短く、音声は1回8KiB。それより大きいものは受け取らない。 */
const MAX_WS_PAYLOAD_BYTES = 64 * 1024;

/** 本人の画面に知らせる再生の長さの上限。1文300字を遅めに読んでも収まる長さ。 */
const MAX_PLAYBACK_DURATION_MS = 5 * 60 * 1000;

/**
 * 相手の声を本人へ中継するときに、送りきれずに溜まってよい量（約2秒分）。
 * 本人の回線が遅いと遅れが積み上がるので、超えた分は送らずに捨て、遅れを広げない。字幕はそのまま届く。
 */
const MAX_RELAY_BUFFERED_BYTES = 64 * 1024;

const MessageEnvelopeSchema = z.looseObject({ type: z.string() });

const StartCallSchema = z.object({
  intent: z.string().trim().min(1).max(MAX_PATIENT_TEXT_LENGTH),
  purpose: z.enum(CALL_PURPOSES).default(DEFAULT_CALL_PURPOSE),
  // 長すぎる名前は切り詰めず断る。画面の入力欄にも同じ上限がある。
  partnerName: z.string().max(MAX_PARTNER_NAME_LENGTH).transform(normalizePartnerName).default(''),
  voice: z.enum(SPEECH_VOICES).default(DEFAULT_SPEECH_VOICE),
});

const SpeechPlaybackSchema = z.object({
  seq: z.number().int().positive(),
  status: z.enum(PLAYBACK_STATUSES),
  engine: z.enum(SPEECH_ENGINES).optional(),
  // 再生する音声の長さ。本人の画面の目安にだけ使うので、範囲外なら捨てる。
  durationMs: z.number().int().positive().max(MAX_PLAYBACK_DURATION_MS).optional().catch(undefined),
});

const PartnerAudioListenSchema = z.object({ enabled: z.boolean() });

/**
 * 録音の取り消しと終わりに付く、ログで原因を見分けるための値。古い画面は付けない。
 * 壊れた値は捨てるだけで、録音の操作そのものは断らない（断ると相手の録音が止まらなくなる）。
 */
const PrepMsSchema = z.number().int().nonnegative().max(10 * 60 * 1000).optional().catch(undefined);
const RecordingStopSchema = z.object({
  reason: z.enum(RECORDING_CANCEL_REASONS).optional().catch(undefined),
  prepMs: PrepMsSchema,
});
const SpeechEndSchema = z.object({ prepMs: PrepMsSchema });

const TurnSeqSchema = z.object({ seq: z.number().int().positive() });

const JoinCallSchema = z.union([
  z.object({ inviteCode: z.string().min(1).max(64) }),
  z.object({ seatToken: z.string().min(1).max(128) }),
]);

const PolishRequestIdSchema = z.object({ requestId: z.string().min(1).max(64) });

const PolishRequestSchema = PolishRequestIdSchema.extend({
  text: z.string().trim().min(1).max(MAX_PATIENT_TEXT_LENGTH),
});

const ConfirmedSpeechSchema = z.object({
  text: z.string().trim().min(1).max(MAX_PATIENT_TEXT_LENGTH),
  origin: z.enum(SPEECH_ORIGINS),
});

const PatientSpeakingSchema = z.object({ isSpeaking: z.boolean() });

type RoomMessageType = Exclude<ClientMessage['type'], 'start_call' | 'join_call'>;

const ALL_PHASES: readonly CallPhase[] = ['ringing', 'connected', 'ending', 'ended'];

/**
 * 席のある接続が送れるメッセージ。ここにない組み合わせは処理しない。
 * 画面の表示に頼らず、役割と通話の段階をサーバーで確認する。
 */
const MESSAGE_RULES: Record<
  RoomMessageType,
  { roles: readonly CallRole[]; phases: readonly CallPhase[] }
> = {
  answer_call: { roles: ['hospital'], phases: ['ringing'] },
  hospital_speaking_start: { roles: ['hospital'], phases: ['connected'] },
  hospital_speaking_stop: { roles: ['hospital'], phases: ['connected'] },
  hospital_speech_end: { roles: ['hospital'], phases: ['connected'] },
  // 終了の直前に読み始めた文の結果も、本人の終了画面に反映する。
  speech_playback: { roles: ['hospital'], phases: ['connected', 'ending', 'ended'] },
  // 終了の直前に送られた文も、相手の端末で最後まで読めるようにする。
  speech_audio_request: { roles: ['hospital'], phases: ['connected', 'ending', 'ended'] },
  // 相手の声を聞くかどうか。応答の前から選べるようにし、再接続のたびに送り直してもらう。
  partner_audio_listen: { roles: ['patient'], phases: ALL_PHASES },
  speech_replay_request: { roles: ['patient'], phases: ['connected'] },
  patient_typing_notice: { roles: ['patient'], phases: ['connected'] },
  patient_polish_request: { roles: ['patient'], phases: ['connected'] },
  patient_confirmed_speech: { roles: ['patient'], phases: ['connected'] },
  patient_speaking_status: { roles: ['patient'], phases: ['connected'] },
  end_call: { roles: ['patient', 'hospital'], phases: ['connected'] },
  // リセットは会話の記録を消すので、通話の持ち主である患者だけができる。
  reset_call: { roles: ['patient'], phases: ALL_PHASES },
  leave_call: { roles: ['hospital'], phases: ALL_PHASES },
};

function ruleFor(type: string) {
  return Object.hasOwn(MESSAGE_RULES, type) ? MESSAGE_RULES[type as RoomMessageType] : null;
}

/**
 * ブラウザが付ける Origin を確認し、別のサイトからの接続を断る。
 * Origin がないのはブラウザ以外の接続で、この確認では防げない。通話の操作は席のトークンで守る。
 */
export function isAllowedOrigin(
  origin: string | undefined,
  host: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** ALLOWED_ORIGINS を読む。開発時はNext.jsの開発サーバーを許可する。 */
export function resolveAllowedOrigins(env: NodeJS.ProcessEnv): string[] {
  const configured = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (configured.length > 0 || env.NODE_ENV === 'production') return configured;
  return ['http://localhost:3000', 'http://127.0.0.1:3000'];
}

function rejectUpgrade(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

interface Connection extends CallPeer {
  room: CallRoom | null;
  role: CallRole | null;
  isAlive: boolean;
  windowStartedAt: number;
  messagesInWindow: number;
  /** 席を持たなくなった時刻。席にいる間は null。 */
  unseatedSince: number | null;
}

export interface CallServerDeps {
  ai: AiAssistant;
  speech: SpeechRecognizer;
  /** 本人の文の音声合成。省くと使わず、相手の端末の声で読む。 */
  tts?: SpeechSynthesizer;
}

export interface CallServerOptions {
  /** 同一オリジンのほかに接続を許可するオリジン。 */
  allowedOrigins?: readonly string[];
  limits?: Partial<CallLimits>;
}

/**
 * 通話のWebSocketを http.Server に取り付ける。
 *
 * 接続した時点では席がなく、できるのは発信と参加だけ。通話の内容は席のある接続にしか送らない。
 * トークンはURLに載せず、接続後の最初のメッセージで受け取る。URLはCloud Runのログに残るため。
 */
export function attachCallServer(
  server: Server,
  deps: CallServerDeps,
  options: CallServerOptions = {},
): WebSocketServer {
  const { ai, speech } = deps;
  const tts = deps.tts ?? DISABLED_SYNTHESIZER;
  const limits: CallLimits = { ...DEFAULT_CALL_LIMITS, ...options.limits };
  const allowedOrigins = options.allowedOrigins ?? [];

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });
  const calls = new CallRegistry({ ai, speech, limits, tts });
  const connections = new Map<WebSocket, Connection>();

  const sendTo = (client: WebSocket, message: ServerMessage) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  };

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const onSocketError = () => socket.destroy();
    socket.on('error', onSocketError);

    const { pathname } = new URL(request.url ?? '/', 'http://localhost');
    if (pathname !== CALL_SOCKET_PATH) {
      rejectUpgrade(socket, '404 Not Found');
      return;
    }
    if (!isAllowedOrigin(request.headers.origin, request.headers.host, allowedOrigins)) {
      logEvent('WARNING', 'ws_origin_rejected');
      rejectUpgrade(socket, '403 Forbidden');
      return;
    }
    if (connections.size >= limits.maxConnections) {
      logEvent('WARNING', 'ws_capacity_reached');
      rejectUpgrade(socket, '503 Service Unavailable');
      return;
    }

    socket.removeListener('error', onSocketError);
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  };
  server.on('upgrade', onUpgrade);

  // 音声認識の状態はサーバー全体の情報で、通話の内容を含まない。発信前の画面にも知らせる。
  const stopWatchingSpeech = speech.onStatusChange((status) => {
    logEvent('INFO', 'speech_status', { status });
    wss.clients.forEach((client) => sendTo(client, { type: 'speech_status', status }));
  });

  // 音声合成を使えるかも同じく全体の情報。相手の画面は、使えないなら音声を待たずに端末の声で読む。
  const stopWatchingTts = tts.onAvailabilityChange((available) => {
    logEvent('INFO', 'tts_status', { available });
    wss.clients.forEach((client) => sendTo(client, { type: 'tts_status', available }));
  });

  // 通信が途切れてもサーバーからは接続中に見えることがあるので、Pingの応答で確かめる。
  const heartbeat = setInterval(() => {
    const now = Date.now();
    connections.forEach((connection, ws) => {
      if (!connection.isAlive) {
        ws.terminate();
        return;
      }
      if (connection.unseatedSince !== null && now - connection.unseatedSince >= limits.idleConnectionMs) {
        logEvent('INFO', 'ws_idle_closed');
        ws.close(CLOSE_CODE_IDLE, 'idle');
        return;
      }
      connection.isAlive = false;
      ws.ping();
    });
  }, limits.heartbeatIntervalMs);
  heartbeat.unref();

  wss.once('close', () => {
    stopWatchingSpeech();
    stopWatchingTts();
    clearInterval(heartbeat);
    server.off('upgrade', onUpgrade);
    calls.closeAll('server_closing');
  });

  wss.on('connection', (ws: WebSocket) => {
    const connection: Connection = {
      room: null,
      role: null,
      isAlive: true,
      windowStartedAt: Date.now(),
      messagesInWindow: 0,
      unseatedSince: Date.now(),
      send: (message) => sendTo(ws, message),
      sendAudio: (chunk) => {
        if (ws.readyState !== WebSocket.OPEN) return false;
        if (ws.bufferedAmount > MAX_RELAY_BUFFERED_BYTES) return false;
        ws.send(chunk, { binary: true });
        return true;
      },
      release: (reason) => {
        connection.room = null;
        connection.role = null;
        connection.unseatedSince = Date.now();
        if (reason === 'evicted') ws.close(CLOSE_CODE_SEAT_TAKEN, 'seat_taken');
      },
    };
    connections.set(ws, connection);

    sendTo(ws, { type: 'ai_status', ...ai.status });
    sendTo(ws, { type: 'speech_status', status: speech.status });
    sendTo(ws, { type: 'tts_status', available: tts.available });

    const reject = (code: CallErrorCode) => sendTo(ws, { type: 'call_error', code });

    const enterRoom = (room: CallRoom, role: CallRole) => {
      connection.room = room;
      connection.role = role;
      connection.unseatedSince = null;
      room.takeSeat(role, connection);
    };

    const handleStartCall = (data: unknown) => {
      const parsed = StartCallSchema.safeParse(data);
      if (!parsed.success) {
        logEvent('WARNING', 'start_call_rejected');
        reject('invalid_message');
        return;
      }
      const { intent, purpose, partnerName, voice } = parsed.data;
      const room = calls.create(intent, { purpose, partnerName, voice });
      if (!room) {
        logEvent('WARNING', 'call_capacity_reached', { activeCalls: calls.activeCalls });
        reject('server_busy');
        return;
      }
      enterRoom(room, 'patient');
    };

    const handleJoinCall = (data: unknown) => {
      const parsed = JoinCallSchema.safeParse(data);
      if (!parsed.success) {
        logEvent('WARNING', 'join_call_rejected');
        reject('invalid_message');
        return;
      }

      if ('inviteCode' in parsed.data) {
        const room = calls.findByInvite(normalizeInviteCode(parsed.data.inviteCode));
        if (!room) {
          logEvent('WARNING', 'join_call_rejected');
          reject('invalid_invite');
          return;
        }
        room.openHospitalSeat();
        enterRoom(room, 'hospital');
        return;
      }

      const seat = calls.findSeat(parsed.data.seatToken);
      if (!seat) {
        logEvent('WARNING', 'join_call_rejected');
        reject('call_not_found');
        return;
      }
      enterRoom(seat.room, seat.role);
    };

    const handlePolishRequest = async (room: CallRoom, data: unknown) => {
      const parsed = PolishRequestSchema.safeParse(data);
      if (!parsed.success) {
        // 依頼元の画面が待ち続けないよう、失敗も返す。
        const requestId = PolishRequestIdSchema.safeParse(data);
        if (requestId.success) room.sendPolishFailure(requestId.data.requestId, 'invalid_request');
        return;
      }
      await room.polish(parsed.data.requestId, parsed.data.text);
    };

    const handleConfirmedSpeech = (room: CallRoom, data: unknown) => {
      const parsed = ConfirmedSpeechSchema.safeParse(data);
      if (!parsed.success) {
        logEvent('WARNING', 'patient_speech_rejected', { callId: room.id });
        reject('invalid_message');
        return;
      }
      room.speak(parsed.data.text, parsed.data.origin);
    };

    const handleRoomMessage = async (room: CallRoom, type: RoomMessageType, data: unknown) => {
      switch (type) {
        case 'answer_call':
          room.answer();
          break;
        case 'hospital_speaking_start':
          room.startRecording();
          break;
        case 'hospital_speaking_stop': {
          const parsed = RecordingStopSchema.safeParse(data);
          room.stopRecording(parsed.success ? parsed.data : {});
          break;
        }
        case 'hospital_speech_end': {
          const parsed = SpeechEndSchema.safeParse(data);
          await room.finishHospitalSpeech(parsed.success ? parsed.data.prepMs : undefined);
          break;
        }
        case 'speech_playback': {
          const parsed = SpeechPlaybackSchema.safeParse(data);
          if (parsed.success) {
            room.reportPlayback(parsed.data.seq, parsed.data.status, parsed.data.engine, parsed.data.durationMs);
          } else {
            reject('invalid_message');
          }
          break;
        }
        case 'partner_audio_listen': {
          const parsed = PartnerAudioListenSchema.safeParse(data);
          if (parsed.success) room.setPartnerAudioListening(parsed.data.enabled);
          else reject('invalid_message');
          break;
        }
        case 'speech_audio_request': {
          const parsed = TurnSeqSchema.safeParse(data);
          if (parsed.success) room.requestSpeechAudio(parsed.data.seq);
          else reject('invalid_message');
          break;
        }
        case 'speech_replay_request': {
          const parsed = TurnSeqSchema.safeParse(data);
          if (!parsed.success) reject('invalid_message');
          else if (!room.replaySpeech(parsed.data.seq)) reject('not_allowed');
          break;
        }
        case 'patient_typing_notice':
          room.notifyTyping();
          break;
        case 'patient_polish_request':
          await handlePolishRequest(room, data);
          break;
        case 'patient_confirmed_speech':
          handleConfirmedSpeech(room, data);
          break;
        case 'patient_speaking_status': {
          const parsed = PatientSpeakingSchema.safeParse(data);
          if (parsed.success) room.setPatientSpeaking(parsed.data.isSpeaking);
          else reject('invalid_message');
          break;
        }
        case 'end_call':
          await room.end();
          break;
        case 'reset_call':
          room.close('reset');
          break;
        case 'leave_call':
          room.leave('hospital');
          break;
      }
    };

    const handleTextMessage = async (raw: string) => {
      const envelope = MessageEnvelopeSchema.safeParse(JSON.parse(raw));
      if (!envelope.success) {
        reject('invalid_message');
        return;
      }
      const data = envelope.data;

      if (data.type === 'start_call' || data.type === 'join_call') {
        if (connection.room) {
          reject('already_in_call');
        } else if (data.type === 'start_call') {
          handleStartCall(data);
        } else {
          handleJoinCall(data);
        }
        return;
      }

      const rule = ruleFor(data.type);
      if (!rule) {
        // 未知の種類は読み上げない。旧クライアントの patient_send もここで止まる。
        logEvent('WARNING', 'ws_unknown_message');
        reject('invalid_message');
        return;
      }

      const { room, role } = connection;
      if (!room || !role) {
        logEvent('WARNING', 'ws_message_without_seat', { messageType: data.type });
        reject('not_in_call');
        return;
      }
      if (!rule.roles.includes(role) || !rule.phases.includes(room.phase)) {
        logEvent('WARNING', 'ws_message_not_allowed', {
          callId: room.id,
          messageType: data.type,
          role,
          phase: room.phase,
        });
        reject('not_allowed');
        return;
      }

      await handleRoomMessage(room, data.type as RoomMessageType, data);
    };

    /** 1分あたりの上限を超えたか。音声は対象にしない。 */
    const isFlooding = () => {
      const now = Date.now();
      if (now - connection.windowStartedAt >= 60_000) {
        connection.windowStartedAt = now;
        connection.messagesInWindow = 0;
      }
      connection.messagesInWindow += 1;
      return connection.messagesInWindow > limits.maxMessagesPerMinute;
    };

    ws.on('pong', () => {
      connection.isAlive = true;
    });

    ws.on('message', async (message: RawData, isBinary: boolean) => {
      // 閉じる途中に届いた分は処理しない。上限超過のログが増え続けるのも防ぐ。
      if (ws.readyState !== WebSocket.OPEN) return;

      if (isBinary) {
        if (connection.role === 'hospital') connection.room?.writeAudio(message as Buffer);
        return;
      }

      if (isFlooding()) {
        logEvent('WARNING', 'ws_rate_limited', { callId: connection.room?.id });
        ws.close(1008, 'rate_limited');
        return;
      }

      try {
        await handleTextMessage(message.toString());
      } catch (error) {
        logEvent('ERROR', 'ws_message_failed', {
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        reject('invalid_message');
      }
    });

    // 不正なフレームや上限を超えたメッセージでも、error を受けないとプロセスごと落ちる。
    ws.on('error', (error: Error) => {
      logEvent('WARNING', 'ws_socket_error', { errorName: error.name });
    });

    ws.on('close', () => {
      connections.delete(ws);
      connection.room?.handleDisconnect(connection);
      connection.room = null;
      connection.role = null;
    });
  });

  return wss;
}
