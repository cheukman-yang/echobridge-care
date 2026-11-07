import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { WebSocketServer } from 'ws';
import { attachCallServer } from '../../server/callServer';
import type { RecognizeStream, SpeechRecognizer } from '../../server/callServer';
import type { GeminiModels } from '../../server/geminiClient';
import { createAiAssistant } from '../../server/geminiService';
import { MAX_PATIENT_TEXT_LENGTH, buildGreeting } from '@/lib/callProtocol';
import type { ServerMessage, SpeechStatus } from '@/lib/callProtocol';
import {
  TEST_MODEL,
  createFakeModels,
  createFakeRunner,
  jsonReply,
  requestsField,
  sentContents,
} from '../helpers/fakeGemini';

const THREE_SUGGESTIONS = {
  suggestions: [
    { text: 'はい、お願いいたします。', tag: '承諾' },
    { text: '別の日時でお願いできますか。', tag: '別日程' },
    { text: '持ち物はありますか。', tag: '確認' },
  ],
};

const EMPTY_APPOINTMENT = {
  title: null,
  date: null,
  startTime: null,
  endTime: null,
  details: null,
};

type MessageType = ServerMessage['type'];
type MessageOf<T extends MessageType> = Extract<ServerMessage, { type: T }>;

class TestClient {
  readonly messages: ServerMessage[] = [];
  private listeners = new Set<() => void>();

  private constructor(private socket: WebSocket) {
    socket.on('message', (raw) => {
      this.messages.push(JSON.parse(raw.toString()) as ServerMessage);
      this.listeners.forEach((listener) => listener());
    });
  }

  static connect(url: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const client = new TestClient(socket);
      socket.once('open', () => resolve(client));
      socket.once('error', reject);
    });
  }

  send(message: object) {
    this.socket.send(JSON.stringify(message));
  }

  sendBinary(chunk: Buffer) {
    this.socket.send(chunk);
  }

  all<T extends MessageType>(type: T): MessageOf<T>[] {
    return this.messages.filter((message): message is MessageOf<T> => message.type === type);
  }

  /** 指定の種類が count 件届くまで待つ。 */
  waitFor<T extends MessageType>(type: T, count = 1): Promise<MessageOf<T>> {
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
      }, 2000);
      this.listeners.add(check);
      check();
    });
  }

  close() {
    this.socket.close();
  }
}

class FakeRecognizeStream extends EventEmitter {
  writable = true;
  written: Buffer[] = [];

  write(chunk: Buffer) {
    this.written.push(chunk);
    return true;
  }

  end() {
    this.writable = false;
  }

  speak(transcript: string) {
    this.emit('data', { results: [{ alternatives: [{ transcript }] }] });
  }
}

class FakeSpeech implements SpeechRecognizer {
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

interface Harness {
  patient: TestClient;
  hospital: TestClient;
  stream: () => FakeRecognizeStream;
}

describe('attachCallServer', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let streams: FakeRecognizeStream[];
  let speech: FakeSpeech;
  let clients: TestClient[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    streams = [];
    clients = [];
  });

  afterEach(async () => {
    clients.forEach((client) => client.close());
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  });

  async function start(
    models: GeminiModels | null,
    createRecognizeStream: () => RecognizeStream = () => {
      const stream = new FakeRecognizeStream();
      streams.push(stream);
      return stream as unknown as RecognizeStream;
    },
  ): Promise<Harness> {
    server = http.createServer();
    speech = new FakeSpeech(createRecognizeStream);
    wss = attachCallServer(server, {
      ai: createAiAssistant(createFakeRunner(models)),
      speech,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws/call`;
    const patient = await TestClient.connect(url);
    const hospital = await TestClient.connect(url);
    clients = [patient, hospital];
    return { patient, hospital, stream: () => streams[streams.length - 1] };
  }

  /** ブロードキャストの順序を使い、それより前のメッセージが届ききったことを保証する。 */
  async function flush({ patient, hospital }: Harness) {
    const count = hospital.all('patient_speaking_status').length + 1;
    patient.send({ type: 'patient_speaking_status', isSpeaking: false });
    await hospital.waitFor('patient_speaking_status', count);
    await patient.waitFor('patient_speaking_status', count);
  }

  async function hospitalSays(harness: Harness, text: string) {
    const { hospital, stream } = harness;
    hospital.send({ type: 'hospital_speaking_start' });
    await hospital.waitFor('hospital_speaking_start', hospital.all('hospital_speaking_start').length + 1);
    stream().speak(text);
    await hospital.waitFor('transcript_interim', hospital.all('transcript_interim').length + 1);
    hospital.send({ type: 'hospital_speech_end' });
    await hospital.waitFor('transcript_final', hospital.all('transcript_final').length + 1);
  }

  describe('本人の確認なしに読み上げない', () => {
    it('AIの整形結果は依頼した接続にだけ返り、相手には届かない', async () => {
      const harness = await start(
        createFakeModels(() => jsonReply({ polished: 'AIが整えた文です。' })),
      );
      const { patient, hospital } = harness;

      patient.send({ type: 'patient_polish_request', requestId: 'r1', text: 'いいえ' });
      const result = await patient.waitFor('patient_polish_result');
      await flush(harness);

      expect(result).toMatchObject({
        requestId: 'r1',
        original: 'いいえ',
        polished: 'AIが整えた文です。',
        ai: { source: 'gemini', model: TEST_MODEL },
      });
      expect(hospital.all('patient_polish_result')).toEqual([]);
      expect(hospital.all('patient_speech')).toEqual([]);
      expect(patient.all('patient_speech')).toEqual([]);
    });

    it('本人が確定した文を一字も変えずに両方へ届ける', async () => {
      const { patient, hospital } = await start(createFakeModels(() => jsonReply({})));
      const text = 'はい？ もう一度お願いします！';

      patient.send({ type: 'patient_confirmed_speech', text, origin: 'typed' });

      expect(await hospital.waitFor('patient_speech')).toEqual({
        type: 'patient_speech',
        text,
        origin: 'typed',
      });
      expect((await patient.waitFor('patient_speech')).text).toBe(text);
    });

    it('確定の送信ではGeminiを呼ばない', async () => {
      const models = createFakeModels(() => jsonReply({ polished: '別の文' }));
      const { patient, hospital } = await start(models);

      patient.send({ type: 'patient_confirmed_speech', text: 'いいえ', origin: 'typed' });
      await hospital.waitFor('patient_speech');

      expect(models.generateContent).not.toHaveBeenCalled();
    });

    it('書き換えて読み上げていた旧メッセージには反応しない', async () => {
      const harness = await start(createFakeModels(() => jsonReply({ polished: '別の文' })));
      const { patient, hospital } = harness;

      patient.send({ type: 'patient_send', text: 'いいえ' });
      await flush(harness);

      expect(hospital.all('patient_speech')).toEqual([]);
    });

    it.each([
      ['空の文', { text: '   ', origin: 'typed' }],
      ['長すぎる文', { text: 'あ'.repeat(MAX_PATIENT_TEXT_LENGTH + 1), origin: 'typed' }],
      ['経路が不明な文', { text: 'はい', origin: 'server_rewrite' }],
    ])('%sは読み上げない', async (_, payload) => {
      const harness = await start(createFakeModels(() => jsonReply({})));
      const { patient, hospital } = harness;

      patient.send({ type: 'patient_confirmed_speech', ...payload });
      await flush(harness);

      expect(hospital.all('patient_speech')).toEqual([]);
    });

    it('長すぎる整形依頼にも失敗を返し、画面を待たせない', async () => {
      const models = createFakeModels(() => jsonReply({ polished: 'x' }));
      const { patient } = await start(models);

      patient.send({
        type: 'patient_polish_request',
        requestId: 'r2',
        text: 'あ'.repeat(MAX_PATIENT_TEXT_LENGTH + 1),
      });

      expect(await patient.waitFor('patient_polish_result')).toMatchObject({
        requestId: 'r2',
        polished: null,
        ai: { source: 'fallback', reason: 'invalid_request' },
      });
      expect(models.generateContent).not.toHaveBeenCalled();
    });

    it('確定していない整形案は通話の履歴に入らない', async () => {
      const models = createFakeModels((params) =>
        requestsField(params, 'polished')
          ? jsonReply({ polished: '確定されなかったAI案' })
          : jsonReply(EMPTY_APPOINTMENT),
      );
      const { patient } = await start(models);

      patient.send({ type: 'patient_polish_request', requestId: 'r1', text: 'あした' });
      await patient.waitFor('patient_polish_result');
      patient.send({ type: 'patient_confirmed_speech', text: '本人が確定した文', origin: 'typed' });
      await patient.waitFor('patient_speech');
      patient.send({ type: 'end_call' });
      await patient.waitFor('end_call');

      const extraction = sentContents(models.generateContent.mock.calls.at(-1)![0]);
      expect(extraction).toContain('本人が確定した文');
      expect(extraction).not.toContain('確定されなかったAI案');
    });
  });

  describe('通話の基本動作', () => {
    it('発信から応答まで進み、プレビューと同じあいさつを読み上げる', async () => {
      const { patient, hospital } = await start(createFakeModels(() => jsonReply({})));
      const intent = '内科の初診予約をしたいです';

      patient.send({ type: 'start_call', intent });
      expect((await hospital.waitFor('start_call')).intent).toBe(intent);

      hospital.send({ type: 'answer_call' });

      expect((await patient.waitFor('answer_call')).text).toBe(buildGreeting(intent));
      expect((await hospital.waitFor('answer_call')).text).toBe(buildGreeting(intent));
    });

    it('病院の発話を文字にし、Geminiの候補を出所つきで届ける', async () => {
      const models = createFakeModels(() => jsonReply(THREE_SUGGESTIONS));
      const harness = await start(models);
      const { patient } = harness;

      patient.send({ type: 'start_call', intent: '内科の初診予約' });
      await hospitalSays(harness, 'アレルギーはありますか');

      expect((await patient.waitFor('transcript_final')).text).toBe('アレルギーはありますか');
      const message = await patient.waitFor('suggestions');
      expect(message.suggestions).toEqual(THREE_SUGGESTIONS.suggestions);
      expect(message.ai).toEqual({ source: 'gemini', model: TEST_MODEL });

      const contents = sentContents(models.generateContent.mock.calls[0][0]);
      expect(contents).toContain('内科の初診予約');
    });

    it('音声データを認識ストリームへ渡す', async () => {
      const harness = await start(null);
      const { hospital, stream } = harness;

      hospital.send({ type: 'hospital_speaking_start' });
      await hospital.waitFor('hospital_speaking_start');
      hospital.sendBinary(Buffer.from([1, 2, 3, 4]));
      await vi.waitFor(() => expect(stream().written).toHaveLength(1));
    });

    it('閉じた後の音声認識エラーでプロセスを落とさない', async () => {
      const harness = await start(null);
      const { hospital, stream } = harness;

      hospital.send({ type: 'hospital_speaking_start' });
      await hospital.waitFor('hospital_speaking_start');
      const closing = stream();
      hospital.send({ type: 'hospital_speaking_stop' });
      await hospital.waitFor('hospital_speaking_stop');

      expect(() => closing.emit('error', new Error('late failure'))).not.toThrow();
    });

    it('発話が空なら候補を作らない', async () => {
      const models = createFakeModels(() => jsonReply(THREE_SUGGESTIONS));
      const { hospital } = await start(models);

      hospital.send({ type: 'hospital_speaking_start' });
      await hospital.waitFor('hospital_speaking_start');
      hospital.send({ type: 'hospital_speech_end' });
      await hospital.waitFor('hospital_speaking_stop');

      expect(models.generateContent).not.toHaveBeenCalled();
    });

    it('リセットすると全員に伝わり、履歴が消える', async () => {
      const models = createFakeModels(() => jsonReply(EMPTY_APPOINTMENT));
      const { patient, hospital } = await start(models);

      patient.send({ type: 'patient_confirmed_speech', text: '消える文', origin: 'typed' });
      await patient.waitFor('patient_speech');
      hospital.send({ type: 'reset_call' });
      await patient.waitFor('reset_call');
      patient.send({ type: 'end_call' });
      await patient.waitFor('end_call');

      expect(sentContents(models.generateContent.mock.calls.at(-1)![0])).not.toContain('消える文');
    });
  });

  describe('音声認識の準備状態を知らせる', () => {
    it('接続時に状態を知らせる', async () => {
      const { patient, hospital } = await start(null);

      expect(await patient.waitFor('speech_status')).toEqual({ type: 'speech_status', status: 'ready' });
      expect(await hospital.waitFor('speech_status')).toEqual({ type: 'speech_status', status: 'ready' });
    });

    it('状態が変わると全員に知らせ、ログには状態だけを残す', async () => {
      const { patient, hospital } = await start(null);
      await patient.waitFor('speech_status');
      await hospital.waitFor('speech_status');

      speech.changeTo('unavailable');

      expect((await patient.waitFor('speech_status', 2)).status).toBe('unavailable');
      expect((await hospital.waitFor('speech_status', 2)).status).toBe('unavailable');
      expect(logSpy.mock.calls.flat().join('\n')).toContain('speech_status');
    });

    it('サーバーを閉じたら購読をやめる', async () => {
      await start(null);
      expect(speech.listeners.size).toBe(1);

      clients.forEach((client) => client.close());
      wss.close();

      await vi.waitFor(() => expect(speech.listeners.size).toBe(0));
    });
  });

  describe('録音を開始できないとき', () => {
    const notReady = (): RecognizeStream => {
      throw new Error('speech_not_ready');
    };

    it('録音中と扱わず、押した本人にだけ知らせる', async () => {
      const harness = await start(createFakeModels(() => jsonReply({})), notReady);
      const { patient, hospital } = harness;

      hospital.send({ type: 'hospital_speaking_start' });

      expect(await hospital.waitFor('hospital_recording_failed')).toEqual({
        type: 'hospital_recording_failed',
        reason: 'start_failed',
      });
      await flush(harness);
      expect(hospital.all('hospital_speaking_start')).toEqual([]);
      expect(patient.all('hospital_speaking_start')).toEqual([]);
      expect(patient.all('hospital_recording_failed')).toEqual([]);
      expect(warnSpy.mock.calls.flat().join('\n')).toContain('stt_setup_failed');
    });

    it('断った録音の音声は、次の録音に混ざらない', async () => {
      let attempts = 0;
      const harness = await start(null, () => {
        attempts += 1;
        if (attempts === 1) return notReady();
        const stream = new FakeRecognizeStream();
        streams.push(stream);
        return stream as unknown as RecognizeStream;
      });
      const { hospital, stream } = harness;

      hospital.send({ type: 'hospital_speaking_start' });
      await hospital.waitFor('hospital_recording_failed');
      hospital.sendBinary(Buffer.from([1, 2]));
      await flush(harness);

      hospital.send({ type: 'hospital_speaking_start' });
      await hospital.waitFor('hospital_speaking_start');
      hospital.sendBinary(Buffer.from([3, 4]));

      await vi.waitFor(() => expect(stream().written).toHaveLength(1));
      expect([...stream().written[0]]).toEqual([3, 4]);
    });

    it('断った後も通話を続けられる', async () => {
      const { patient, hospital } = await start(createFakeModels(() => jsonReply({})), notReady);

      hospital.send({ type: 'hospital_speaking_start' });
      await hospital.waitFor('hospital_recording_failed');
      patient.send({ type: 'patient_confirmed_speech', text: '聞こえますか', origin: 'typed' });

      expect((await hospital.waitFor('patient_speech')).text).toBe('聞こえますか');
    });
  });

  describe('録音中に音声認識が止まったとき', () => {
    it('本人に知らせ、相手の発話中表示を消す', async () => {
      const harness = await start(null);
      const { patient, hospital, stream } = harness;
      hospital.send({ type: 'hospital_speaking_start' });
      await hospital.waitFor('hospital_speaking_start');

      stream().emit('error', new Error('PERMISSION_DENIED path/to/secret.json'));

      expect(await hospital.waitFor('hospital_recording_failed')).toEqual({
        type: 'hospital_recording_failed',
        reason: 'stream_failed',
      });
      await patient.waitFor('hospital_speaking_stop');
      expect(patient.all('hospital_recording_failed')).toEqual([]);

      const output = warnSpy.mock.calls.flat().join('\n');
      expect(output).toContain('stt_stream_failed');
      expect(output).not.toContain('secret.json');
    });

    it('途中までの文を確定せず、返答候補も作らない', async () => {
      const models = createFakeModels(() => jsonReply(THREE_SUGGESTIONS));
      const harness = await start(models);
      const { patient, hospital, stream } = harness;
      hospital.send({ type: 'hospital_speaking_start' });
      await hospital.waitFor('hospital_speaking_start');
      stream().speak('明日の十時で');
      await patient.waitFor('transcript_interim');

      stream().emit('error', new Error('unavailable'));
      await hospital.waitFor('hospital_recording_failed');
      // 失敗の通知と行き違いに、画面が発話の終わりを送ってきた場合。
      hospital.send({ type: 'hospital_speech_end' });
      await patient.waitFor('hospital_speaking_stop', 2);

      expect(patient.all('transcript_final')).toEqual([]);
      expect(models.generateContent).not.toHaveBeenCalled();
    });

    it('止まった後の音声は認識に渡さない', async () => {
      const harness = await start(null);
      const { hospital, stream } = harness;
      hospital.send({ type: 'hospital_speaking_start' });
      await hospital.waitFor('hospital_speaking_start');
      const failed = stream();
      failed.emit('error', new Error('unavailable'));
      await hospital.waitFor('hospital_recording_failed');

      hospital.sendBinary(Buffer.from([1, 2]));
      await flush(harness);

      expect(failed.written).toEqual([]);
    });

    it('無音で切れただけなら開き直し、録音を続ける', async () => {
      const harness = await start(null);
      const { hospital, stream } = harness;
      hospital.send({ type: 'hospital_speaking_start' });
      await hospital.waitFor('hospital_speaking_start');
      const first = stream();

      first.emit('error', new Error('Long duration elapsed without audio.'));
      hospital.sendBinary(Buffer.from([1, 2]));

      await vi.waitFor(() => expect(stream().written).toHaveLength(1));
      expect(stream()).not.toBe(first);
      expect(hospital.all('hospital_recording_failed')).toEqual([]);
    });

    it('開き直せなければ本人に知らせる', async () => {
      let attempts = 0;
      const harness = await start(null, () => {
        attempts += 1;
        if (attempts > 1) throw new Error('speech_not_ready');
        const stream = new FakeRecognizeStream();
        streams.push(stream);
        return stream as unknown as RecognizeStream;
      });
      const { patient, hospital, stream } = harness;
      hospital.send({ type: 'hospital_speaking_start' });
      await hospital.waitFor('hospital_speaking_start');

      stream().emit('error', new Error('Long duration elapsed without audio.'));

      expect((await hospital.waitFor('hospital_recording_failed')).reason).toBe('stream_failed');
      expect(await patient.waitFor('hospital_speaking_stop')).toBeDefined();
    });
  });

  describe('実AIとフォールバックの区別', () => {
    it('接続時にAIの設定状態を知らせる', async () => {
      const { patient } = await start(null);

      expect(await patient.waitFor('ai_status')).toEqual({
        type: 'ai_status',
        configured: false,
        backend: null,
        model: null,
      });
    });

    it('設定があるときはモデル名を知らせる', async () => {
      const { patient } = await start(createFakeModels(() => jsonReply({})));

      expect(await patient.waitFor('ai_status')).toMatchObject({
        configured: true,
        backend: 'vertex',
        model: TEST_MODEL,
      });
    });

    it('AIが未設定なら定型候補に理由を付ける', async () => {
      const harness = await start(null);

      await hospitalSays(harness, '予約はいつがよろしいですか');
      const message = await harness.patient.waitFor('suggestions');

      expect(message.suggestions).toHaveLength(3);
      expect(message.ai).toEqual({ source: 'fallback', reason: 'not_configured' });
    });

    it('AIが未設定でも通話終了の結果に推測の日時を入れない', async () => {
      const { patient } = await start(null);

      patient.send({ type: 'start_call', intent: '内科の予約' });
      patient.send({ type: 'patient_confirmed_speech', text: '明日の3時でお願いします', origin: 'typed' });
      await patient.waitFor('patient_speech');
      patient.send({ type: 'end_call' });

      expect(await patient.waitFor('call_ending')).toBeDefined();
      const message = await patient.waitFor('end_call');
      expect(message.ai).toEqual({ source: 'fallback', reason: 'not_configured' });
      expect(message.appointment).toMatchObject({ date: null, startTime: null });
    });
  });

  describe('古い返答候補を出さない', () => {
    it('次の発話が来たら、前の発話の候補を捨てる', async () => {
      const resolvers: Array<(value: ReturnType<typeof jsonReply>) => void> = [];
      const models = createFakeModels(
        () => new Promise((resolve) => resolvers.push(resolve)),
      );
      const harness = await start(models);
      const { patient } = harness;

      await hospitalSays(harness, '最初の質問です');
      await vi.waitFor(() => expect(resolvers).toHaveLength(1));
      await hospitalSays(harness, '次の質問です');
      await vi.waitFor(() => expect(resolvers).toHaveLength(2));

      const stale = {
        suggestions: THREE_SUGGESTIONS.suggestions.map((s) => ({ ...s, text: `古い${s.text}` })),
      };
      resolvers[0](jsonReply(stale));
      resolvers[1](jsonReply(THREE_SUGGESTIONS));

      const message = await patient.waitFor('suggestions');
      await harness.patient.waitFor('generating_suggestions', 2);
      await flush(harness);

      expect(message.suggestions).toEqual(THREE_SUGGESTIONS.suggestions);
      expect(patient.all('suggestions')).toHaveLength(1);
    });

    it('本人が先に返答したら、後から届いた候補を出さない', async () => {
      let resolveReply: (value: ReturnType<typeof jsonReply>) => void = () => {};
      const models = createFakeModels(
        () => new Promise((resolve) => { resolveReply = resolve; }),
      );
      const harness = await start(models);
      const { patient, hospital } = harness;

      await hospitalSays(harness, '質問です');
      await vi.waitFor(() => expect(models.generateContent).toHaveBeenCalledTimes(1));
      patient.send({ type: 'patient_confirmed_speech', text: '先に答えます', origin: 'typed' });
      await hospital.waitFor('patient_speech');

      resolveReply(jsonReply(THREE_SUGGESTIONS));
      await new Promise((resolve) => setTimeout(resolve, 20));
      await flush(harness);

      expect(patient.all('suggestions')).toEqual([]);
    });
  });

  describe('ログ', () => {
    it('通話の本文をログに出さない', async () => {
      const secret = '架空の秘密の相談内容';
      const models = createFakeModels((params) => {
        if (requestsField(params, 'polished')) return jsonReply({ polished: `${secret}です。` });
        if (requestsField(params, 'suggestions')) return jsonReply(THREE_SUGGESTIONS);
        return jsonReply(EMPTY_APPOINTMENT);
      });
      const harness = await start(models);
      const { patient } = harness;

      patient.send({ type: 'start_call', intent: secret });
      await hospitalSays(harness, secret);
      await patient.waitFor('suggestions');
      patient.send({ type: 'patient_polish_request', requestId: 'r1', text: secret });
      await patient.waitFor('patient_polish_result');
      patient.send({ type: 'patient_confirmed_speech', text: secret, origin: 'typed' });
      await patient.waitFor('patient_speech');
      patient.send({ type: 'end_call' });
      await patient.waitFor('end_call');

      const output = [...logSpy.mock.calls, ...warnSpy.mock.calls].flat().join('\n');
      expect(output).toContain('patient_speech');
      expect(output).not.toContain(secret);
    });
  });
});
