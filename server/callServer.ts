import type { Server } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { z } from 'zod';
import {
  MAX_PATIENT_TEXT_LENGTH,
  SPEECH_ORIGINS,
  TYPING_NOTICE_TEXT,
  buildGreeting,
} from '../src/lib/callProtocol';
import type { ChatTurn, ServerMessage, SpeechStatus } from '../src/lib/callProtocol';
import type { AiAssistant } from './geminiService';

const StartCallSchema = z.object({
  intent: z.string().max(MAX_PATIENT_TEXT_LENGTH),
});

const PolishRequestSchema = z.object({
  requestId: z.string().min(1).max(64),
  text: z.string().trim().min(1).max(MAX_PATIENT_TEXT_LENGTH),
});

const ConfirmedSpeechSchema = z.object({
  text: z.string().trim().min(1).max(MAX_PATIENT_TEXT_LENGTH),
  origin: z.enum(SPEECH_ORIGINS),
});

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

export interface CallServerDeps {
  ai: AiAssistant;
  speech: SpeechRecognizer;
}

function logEvent(severity: 'INFO' | 'WARNING' | 'ERROR', message: string, fields = {}): void {
  const line = JSON.stringify({ severity, message, ...fields });
  if (severity === 'INFO') {
    console.log(line);
  } else {
    console.warn(line);
  }
}

/**
 * 通話のWebSocketを http.Server に取り付ける。
 *
 * 相手に届く文の経路は patient_confirmed_speech だけで、サーバーはその文を書き換えない。
 * AIの整形案は依頼した接続にだけ返すので、本人が確定するまで相手には届かない。
 */
export function attachCallServer(server: Server, deps: CallServerDeps): WebSocketServer {
  const { ai, speech } = deps;
  const wss = new WebSocketServer({ server, path: '/ws/call' });

  const call = {
    hospitalTranscript: '',
    patientIntent: '',
    history: [] as ChatTurn[],
    isHospitalRecording: false,
    // 新しい番が始まったら増やし、古い番の返答候補を捨てる。
    suggestionTurn: 0,
  };

  const sendTo = (client: WebSocket, message: ServerMessage) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  };

  const broadcast = (message: ServerMessage) => {
    wss.clients.forEach((client) => sendTo(client, message));
  };

  const stopWatchingSpeech = speech.onStatusChange((status) => {
    logEvent('INFO', 'speech_status', { status });
    broadcast({ type: 'speech_status', status });
  });
  wss.once('close', stopWatchingSpeech);

  wss.on('connection', (ws: WebSocket) => {
    let recognizeStream: RecognizeStream | null = null;

    sendTo(ws, { type: 'ai_status', ...ai.status });
    sendTo(ws, { type: 'speech_status', status: speech.status });

    const stopRecognitionStream = () => {
      if (!recognizeStream) return;
      recognizeStream.removeAllListeners('data');
      recognizeStream.removeAllListeners('error');
      // 閉じる途中のエラーでプロセスが落ちないよう、リスナーを残す。
      recognizeStream.on('error', () => {});
      recognizeStream.end();
      recognizeStream = null;
    };

    const onSpeechData = (data: SpeechResult) => {
      if (!call.isHospitalRecording) return;
      const transcript = data.results[0]?.alternatives[0]?.transcript;
      if (transcript) {
        call.hospitalTranscript = transcript;
        broadcast({ type: 'transcript_interim', text: transcript });
      }
    };

    /** 録音中に認識が止まったら、話し続けて音声を失わないよう本人に知らせる。途中の文は確定しない。 */
    const abortRecording = () => {
      call.isHospitalRecording = false;
      call.hospitalTranscript = '';
      stopRecognitionStream();
      sendTo(ws, { type: 'hospital_recording_failed', reason: 'stream_failed' });
      broadcast({ type: 'hospital_speaking_stop' });
    };

    /** 認識ストリームを開く。開けたかどうかを返す。 */
    const startRecognitionStream = (): boolean => {
      stopRecognitionStream();
      try {
        recognizeStream = speech
          .createStream()
          .on('error', (error: Error) => {
            if (error.message?.includes('Long duration elapsed without audio')) {
              if (call.isHospitalRecording && !startRecognitionStream()) abortRecording();
              return;
            }
            logEvent('ERROR', 'stt_stream_failed', { errorName: error.name });
            abortRecording();
          })
          .on('data', onSpeechData);
        return true;
      } catch (error) {
        logEvent('ERROR', 'stt_setup_failed', {
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        return false;
      }
    };

    const handlePolishRequest = async (data: unknown) => {
      const parsed = PolishRequestSchema.safeParse(data);
      if (!parsed.success) {
        // 依頼元の画面が待ち続けないよう、失敗も返す。
        const requestId = z.object({ requestId: z.string() }).safeParse(data);
        if (requestId.success) {
          sendTo(ws, {
            type: 'patient_polish_result',
            requestId: requestId.data.requestId,
            original: '',
            polished: null,
            ai: { source: 'fallback', reason: 'invalid_request' },
          });
        }
        return;
      }

      const { requestId, text } = parsed.data;
      const result = await ai.polishText({
        text,
        intent: call.patientIntent,
        history: [...call.history],
      });
      sendTo(ws, {
        type: 'patient_polish_result',
        requestId,
        original: result.original,
        polished: result.polished,
        ai: result.ai,
      });
    };

    const handleConfirmedSpeech = (data: unknown) => {
      const parsed = ConfirmedSpeechSchema.safeParse(data);
      if (!parsed.success) {
        logEvent('WARNING', 'patient_speech_rejected');
        return;
      }
      const { text, origin } = parsed.data;
      // 本人が返答したので、生成中の候補が後から届いても表示しない。
      call.suggestionTurn += 1;
      call.history.push({ sender: '患者', text });
      logEvent('INFO', 'patient_speech', { origin, length: text.length });
      broadcast({ type: 'patient_speech', text, origin });
    };

    const handleHospitalSpeechEnd = async () => {
      call.isHospitalRecording = false;
      stopRecognitionStream();

      const utterance = call.hospitalTranscript.trim();
      call.hospitalTranscript = '';

      if (!utterance) {
        broadcast({ type: 'hospital_speaking_stop' });
        return;
      }

      call.history.push({ sender: '病院受付', text: utterance });
      broadcast({ type: 'transcript_final', text: utterance });
      broadcast({ type: 'generating_suggestions' });

      call.suggestionTurn += 1;
      const turn = call.suggestionTurn;
      const result = await ai.suggestReplies({
        intent: call.patientIntent,
        history: [...call.history],
        latestUtterance: utterance,
      });

      if (turn === call.suggestionTurn) {
        broadcast({ type: 'suggestions', suggestions: result.suggestions, ai: result.ai });
      }
    };

    const handleEndCall = async () => {
      call.isHospitalRecording = false;
      stopRecognitionStream();
      call.suggestionTurn += 1;
      broadcast({ type: 'call_ending' });

      const result = await ai.extractAppointment({
        intent: call.patientIntent,
        history: [...call.history],
      });
      broadcast({ type: 'end_call', appointment: result.appointment, ai: result.ai });

      call.hospitalTranscript = '';
      call.patientIntent = '';
    };

    const handleControlMessage = async (data: { type?: unknown; [key: string]: unknown }) => {
      switch (data.type) {
        case 'start_call': {
          const parsed = StartCallSchema.safeParse(data);
          if (!parsed.success) {
            logEvent('WARNING', 'start_call_rejected');
            break;
          }
          call.patientIntent = parsed.data.intent;
          call.history = [];
          call.isHospitalRecording = false;
          call.suggestionTurn += 1;
          stopRecognitionStream();
          broadcast({ type: 'start_call', intent: call.patientIntent });
          break;
        }

        case 'answer_call': {
          const greeting = buildGreeting(call.patientIntent);
          call.history.push({ sender: '患者', text: greeting });
          broadcast({ type: 'answer_call', text: greeting });
          break;
        }

        case 'hospital_speaking_start':
          call.hospitalTranscript = '';
          call.isHospitalRecording = startRecognitionStream();
          // 画面はこの配信を受け付けの合図にして、届くまで録音中と表示しない。
          if (call.isHospitalRecording) {
            broadcast({ type: 'hospital_speaking_start' });
          } else {
            sendTo(ws, { type: 'hospital_recording_failed', reason: 'start_failed' });
          }
          break;

        case 'hospital_speaking_stop':
          call.isHospitalRecording = false;
          stopRecognitionStream();
          broadcast({ type: 'hospital_speaking_stop' });
          break;

        case 'hospital_speech_end':
        case 'force_finalize':
          await handleHospitalSpeechEnd();
          break;

        case 'patient_typing_notice':
          broadcast({ type: 'patient_typing_notice', text: TYPING_NOTICE_TEXT });
          break;

        case 'patient_polish_request':
          await handlePolishRequest(data);
          break;

        case 'patient_confirmed_speech':
          handleConfirmedSpeech(data);
          break;

        case 'patient_speaking_status':
          broadcast({ type: 'patient_speaking_status', isSpeaking: data.isSpeaking === true });
          break;

        case 'end_call':
          await handleEndCall();
          break;

        case 'reset_call':
          call.isHospitalRecording = false;
          stopRecognitionStream();
          call.hospitalTranscript = '';
          call.patientIntent = '';
          call.history = [];
          call.suggestionTurn += 1;
          broadcast({ type: 'reset_call' });
          break;

        default:
          // 未知の種類は読み上げない。旧クライアントの patient_send もここで止まる。
          logEvent('WARNING', 'ws_unknown_message');
      }
    };

    ws.on('message', async (message: RawData, isBinary: boolean) => {
      if (isBinary) {
        if (call.isHospitalRecording && recognizeStream?.writable) {
          recognizeStream.write(message as Buffer);
        }
        return;
      }

      try {
        await handleControlMessage(JSON.parse(message.toString()));
      } catch (error) {
        logEvent('ERROR', 'ws_message_failed', {
          errorName: error instanceof Error ? error.name : 'unknown',
        });
      }
    });

    ws.on('close', () => {
      if (wss.clients.size === 0) {
        stopRecognitionStream();
        call.hospitalTranscript = '';
        call.isHospitalRecording = false;
      }
    });
  });

  return wss;
}
