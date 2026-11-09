import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { ClientOptions, WebSocketServer } from 'ws';
import { attachCallServer } from '../../server/callServer';
import type {
  CallServerOptions,
  RecognizeStream,
  SpeechRecognizer,
} from '../../server/callServer';
import type { GeminiModels } from '../../server/geminiClient';
import { createAiAssistant } from '../../server/geminiService';
import type { SpeechSynthesizer } from '../../server/speechSynthesizer';
import type { ClientMessage, ServerMessage, SpeechStatus } from '@/lib/callProtocol';
import { createFakeRunner } from './fakeGemini';

export const DEFAULT_INTENT = '内科の予約';

type MessageType = ServerMessage['type'];

/** 発信のときに足せる項目。省くとサーバーの既定値になる。 */
export type CallSetup = Omit<Extract<ClientMessage, { type: 'start_call' }>, 'type' | 'intent'>;
type MessageOf<T extends MessageType> = Extract<ServerMessage, { type: T }>;

/** 本物のWebSocketで通話サーバーへつなぐクライアント。受信を記録する。 */
export class TestClient {
  readonly messages: ServerMessage[] = [];
  /** 受け取ったバイナリのフレーム（本人の席へ中継された相手の声）。 */
  readonly audio: Buffer[] = [];
  /** 閉じたときのクローズコード。 */
  readonly closed: Promise<number>;
  private listeners = new Set<() => void>();

  private constructor(private socket: WebSocket) {
    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        this.audio.push(raw as Buffer);
      } else {
        this.messages.push(JSON.parse(raw.toString()) as ServerMessage);
      }
      this.listeners.forEach((listener) => listener());
    });
    this.closed = new Promise((resolve) => socket.once('close', resolve));
  }

  static connect(url: string, options: ClientOptions = {}): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, options);
      const client = new TestClient(socket);
      socket.once('open', () => resolve(client));
      socket.once('error', reject);
    });
  }

  send(message: object) {
    this.socket.send(JSON.stringify(message));
  }

  sendText(text: string) {
    this.socket.send(text);
  }

  sendBinary(chunk: Buffer) {
    this.socket.send(chunk);
  }

  all<T extends MessageType>(type: T): MessageOf<T>[] {
    return this.messages.filter((message): message is MessageOf<T> => message.type === type);
  }

  /** 指定の種類が count 件届くまで待つ。 */
  waitFor<T extends MessageType>(type: T, count = 1, timeoutMs = 2000): Promise<MessageOf<T>> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = this.all(type);
        if (found.length >= count) {
          clearTimeout(timer);
          this.listeners.delete(check);
          resolve(found[count - 1]);
        }
      };
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`timed out waiting for ${type}`));
      }, timeoutMs);
      this.listeners.add(check);
      check();
    });
  }

  close() {
    this.socket.close();
  }

  /** 通信が途切れた場合のように、終了の手続きなしで切る。 */
  terminate() {
    this.socket.terminate();
  }

  /** 壊れたフレームを送るために、下のTCP接続へ直接書き込む。 */
  writeRaw(data: Buffer) {
    (this.socket as unknown as { _socket: { write(chunk: Buffer): void } })._socket.write(data);
  }
}

export class FakeRecognizeStream extends EventEmitter {
  writable = true;
  written: Buffer[] = [];
  /** 送信を閉じた後に返す最終結果。実際のSTTと同じく、'end' の前に届ける。 */
  finalOnEnd: string | null = null;
  /** false なら、送信を閉じても 'end' を出さない（結果が返ってこない場合）。 */
  endsOnEnd = true;

  write(chunk: Buffer) {
    this.written.push(chunk);
    return true;
  }

  end() {
    if (!this.writable) return;
    this.writable = false;
    if (!this.endsOnEnd) return;
    setImmediate(() => {
      if (this.finalOnEnd !== null) this.speak(this.finalOnEnd, true);
      this.emit('end');
    });
  }

  speak(transcript: string, isFinal = false) {
    this.emit('data', { results: [{ alternatives: [{ transcript }], isFinal }] });
  }
}

export class FakeSpeech implements SpeechRecognizer {
  status: SpeechStatus = 'ready';
  listeners = new Set<(status: SpeechStatus) => void>();

  constructor(readonly createStream: () => RecognizeStream) {}

  onStatusChange(listener: (status: SpeechStatus) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  changeTo(status: SpeechStatus) {
    this.status = status;
    this.listeners.forEach((listener) => listener(status));
  }
}

export interface CallPair {
  patient: TestClient;
  hospital: TestClient;
}

export interface OpenCall extends CallPair {
  /** 最後に開かれた認識ストリーム。 */
  stream: () => FakeRecognizeStream;
}

/** 本物の http.Server と attachCallServer を動かす。STTとGeminiだけを偽物にする。 */
export class CallTestServer {
  readonly streams: FakeRecognizeStream[] = [];
  readonly clients: TestClient[] = [];
  server!: http.Server;
  wss!: WebSocketServer;
  speech!: FakeSpeech;
  url = '';

  readonly newStream = (): RecognizeStream => {
    const stream = new FakeRecognizeStream();
    this.streams.push(stream);
    return stream as unknown as RecognizeStream;
  };

  async listen(
    models: GeminiModels | null,
    createRecognizeStream: () => RecognizeStream = this.newStream,
    options?: CallServerOptions,
    tts?: SpeechSynthesizer,
  ) {
    this.server = http.createServer();
    this.speech = new FakeSpeech(createRecognizeStream);
    this.wss = attachCallServer(
      this.server,
      { ai: createAiAssistant(createFakeRunner(models)), speech: this.speech, tts },
      options,
    );
    await new Promise<void>((resolve) => this.server.listen(0, resolve));
    this.url = `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}/ws/call`;
  }

  async connect(options?: ClientOptions): Promise<TestClient> {
    const client = await TestClient.connect(this.url, options);
    this.clients.push(client);
    return client;
  }

  /** 患者が発信し、招待を受け取るところまで進める。setup で目的と相手の名前を足せる。 */
  async placeCall(intent = DEFAULT_INTENT, setup: CallSetup = {}) {
    const patient = await this.connect();
    patient.send({ type: 'start_call', intent, ...setup });
    const joined = await patient.waitFor('call_joined');
    return { patient, joined, inviteCode: joined.snapshot.invite!.code };
  }

  /** 発信から病院の応答まで進める。 */
  async openCall(intent = DEFAULT_INTENT, setup: CallSetup = {}): Promise<OpenCall> {
    const { patient, inviteCode } = await this.placeCall(intent, setup);
    const hospital = await this.connect();
    hospital.send({ type: 'join_call', inviteCode });
    await hospital.waitFor('call_joined');
    hospital.send({ type: 'answer_call' });
    await patient.waitFor('answer_call');
    await hospital.waitFor('answer_call');
    return { patient, hospital, stream: () => this.streams[this.streams.length - 1] };
  }

  /** ブロードキャストの順序を使い、それより前のメッセージが届ききったことを保証する。 */
  async flush({ patient, hospital }: CallPair) {
    const count = hospital.all('patient_speaking_status').length + 1;
    patient.send({ type: 'patient_speaking_status', isSpeaking: false });
    await hospital.waitFor('patient_speaking_status', count);
    await patient.waitFor('patient_speaking_status', count);
  }

  /** 病院の発話を1回分進める。 */
  async hospitalSays(call: OpenCall, text: string) {
    const { hospital, stream } = call;
    hospital.send({ type: 'hospital_speaking_start' });
    await hospital.waitFor('hospital_speaking_start', hospital.all('hospital_speaking_start').length + 1);
    stream().speak(text);
    await hospital.waitFor('transcript_interim', hospital.all('transcript_interim').length + 1);
    hospital.send({ type: 'hospital_speech_end' });
    await hospital.waitFor('transcript_final', hospital.all('transcript_final').length + 1);
  }

  async close() {
    this.clients.forEach((client) => client.close());
    this.wss.close();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
