/**
 * 開発専用のモックサーバー。Google Cloudの認証がなくても、2つの画面で通話の流れを確かめられる。
 *
 * - 文字起こし（Speech-to-Text）と、返答候補・文の整形・予定の読み取り（Gemini）を台本の結果に置き換える
 * - 通話の中継（招待、席、再接続、本人確認の経路）は本番と同じ attachCallServer を使う
 * - 画面には「モックモード」と表示される（ai_status の backend が mock、結果のモデル名が mock-dev-only）
 *
 * 実際のAIと音声認識の動作確認ではない。デモ動画や提出物で、実際の機能として見せないこと。
 *
 *   npx tsx scripts/mock-server.ts      （start-mock.bat から起動される）
 *
 * 相手が録音すると、マイクの音声の中身に関係なく、台本の次の文が文字起こしとして届く。
 * 台本は本人が発信したときの目的（医療機関／日常の連絡）で選ぶ。音声が1つも届かなければ結果は空になる。
 *
 * 異常系の確認（このサーバーのポート。既定8080）:
 *   GET /__mock/ai?mode=ok|fail|slow           AIを正常・失敗・時間切れにする
 *   GET /__mock/speech?status=ready|unavailable 音声認識の準備状態を変える
 *   GET /__mock/speech?fail=1                   録音中の認識を失敗させる
 *   GET /__mock/state                           今の設定を見る
 */
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { RawData, WebSocket } from 'ws';
import { attachCallServer, resolveAllowedOrigins } from '../server/callServer';
import type { RecognizeStream, SpeechRecognizer } from '../server/callServer';
import { createGeminiRunner, resolveGeminiConfig } from '../server/geminiClient';
import type { GeminiModels } from '../server/geminiClient';
import { createAiAssistant } from '../server/geminiService';
import { MOCK_AI_MODEL } from '../src/lib/aiMeta';
import type { SpeechStatus, SuggestionItem } from '../src/lib/callProtocol';
import { CALL_PURPOSE_PROFILES, DEFAULT_CALL_PURPOSE, isCallPurpose } from '../src/lib/callPurpose';
import type { CallPurpose } from '../src/lib/callPurpose';

const PORT = Number(process.env.PORT) || 8080;

/** 相手役の台本。架空の内容だけを使う。 */
const PARTNER_LINES: Record<CallPurpose, string[]> = {
  medical: [
    'はい、ひまわり医院受付です。初診のご予約ですね。ご希望の日時はありますか。',
    '明日の午後2時半でしたらご案内できます。保険の確認のため、マイナンバーカードをお持ちください。',
    'それでは明日の午後2時半にお待ちしております。住所は本町2丁目3番4号、ひまわりビルの2階です。',
  ],
  general: [
    'もしもし。土曜日の待ち合わせの件だよね。何時にする？',
    'じゃあ土曜日の10時に駅前の改札でどう？',
    'わかった。土曜日の10時に駅前の改札で待ってるね。',
  ],
};

let scenario: CallPurpose = DEFAULT_CALL_PURPOSE;
let cursor = 0;

/** 台本の次の文。最後まで進んだら最後の文を繰り返す。 */
function nextLine(): string {
  const lines = PARTNER_LINES[scenario];
  const line = lines[Math.min(cursor, lines.length - 1)];
  cursor += 1;
  return line;
}

/** ブラウザは約256msごとに音声を送るので、4回（約1秒）ごとに途中結果を出す。 */
const CHUNKS_PER_INTERIM = 4;
const CHARS_PER_INTERIM = 10;

/** SDKのストリームと同じく、送信を閉じると最終結果と 'end' を返し、打ち切ると 'close' を出す。 */
class MockRecognizeStream extends EventEmitter {
  writable = true;
  destroyed = false;
  private chunks = 0;
  private line: string | null = null;

  write(): boolean {
    if (!this.writable) return false;
    this.chunks += 1;
    // 音声が届いて初めて台本を1文使う。すぐ離した録音で台本を進めない。
    this.line ??= nextLine();
    if (this.chunks % CHUNKS_PER_INTERIM === 0) {
      const shown = (this.chunks / CHUNKS_PER_INTERIM) * CHARS_PER_INTERIM;
      this.emitResult(this.line.slice(0, shown), false);
    }
    return true;
  }

  end(): this {
    if (!this.writable) return this;
    this.writable = false;
    setTimeout(() => {
      if (this.destroyed) return;
      if (this.line) this.emitResult(this.line, true);
      this.emit('end');
    }, 200);
    return this;
  }

  destroy(error?: Error): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.writable = false;
    queueMicrotask(() => {
      if (error) this.emit('error', error);
      this.emit('close');
    });
    return this;
  }

  private emitResult(transcript: string, isFinal: boolean): void {
    this.emit('data', { results: [{ alternatives: [{ transcript }], isFinal }] });
  }
}

let speechStatus: SpeechStatus = 'ready';
const statusListeners = new Set<(status: SpeechStatus) => void>();
const openStreams = new Set<MockRecognizeStream>();

const speech: SpeechRecognizer = {
  get status() {
    return speechStatus;
  },
  onStatusChange(listener) {
    statusListeners.add(listener);
    return () => {
      statusListeners.delete(listener);
    };
  },
  createStream() {
    if (speechStatus !== 'ready') throw new Error('speech_not_ready');
    const stream = new MockRecognizeStream();
    openStreams.add(stream);
    const forget = () => openStreams.delete(stream);
    stream.once('end', forget);
    stream.once('close', forget);
    return stream as unknown as RecognizeStream;
  },
};

type AiMode = 'ok' | 'fail' | 'slow';
let aiMode: AiMode = 'ok';
const MOCK_LATENCY_MS = 600;
/** 本番のタイムアウト（返答候補8秒、予定20秒）を超える待ち。 */
const SLOW_LATENCY_MS = 30_000;

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

function mockSuggestions(latest: string, purpose: CallPurpose): SuggestionItem[] {
  const waitForInput = { text: '少々お待ちください。ただいま入力いたします。', tag: '待ってもらう' };
  if (purpose === 'medical') {
    if (/日時|いつ|ご希望/.test(latest)) {
      return [
        { text: '明日の午後はいかがでしょうか。', tag: '提案' },
        waitForInput,
        { text: '一番早い日時を教えていただけますか。', tag: '確認' },
      ];
    }
    if (/マイナンバー|保険|お持ち/.test(latest)) {
      return [
        { text: '承知しました。マイナンバーカードを持って行きます。', tag: '承諾' },
        { text: '資格確認書でも大丈夫でしょうか。', tag: '代わり' },
        { text: 'ほかに持って行くものはありますか。', tag: '確認' },
      ];
    }
    return [
      { text: 'はい、よろしくお願いします。', tag: '承諾' },
      waitForInput,
      { text: 'もう一度教えていただけますか。', tag: '確認' },
    ];
  }
  if (/何時|いつ/.test(latest)) {
    return [
      { text: '10時はどうですか。', tag: '提案' },
      waitForInput,
      { text: 'どこで会いますか。', tag: '確認' },
    ];
  }
  return [
    { text: 'うん、それで大丈夫です。', tag: '承諾' },
    { text: '少し遅れるかもしれません。', tag: '代わり' },
    { text: 'もう一度言ってもらえますか。', tag: '確認' },
  ];
}

/** 文末をそろえ、丁寧な前置きを付けるだけ。意味は変えない。 */
function mockPolish(text: string): string {
  const trimmed = text.trim();
  const isQuestion = /[？?]$/.test(trimmed);
  const body = trimmed.replace(/[。．.！!？?]+$/, '');
  return `恐れ入りますが、${body}${isQuestion ? '？' : '。'}`;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function nextWeekday(date: string, weekday: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const current = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return addDays(date, (weekday - current + 7) % 7 || 7);
}

/** 会話に出た最後の時刻（HH:mm）と、その言い方。 */
function lastTime(text: string): { text: string; time: string } | null {
  const matches = [...text.matchAll(/(午前|午後)?\s*(\d{1,2})時(半|(\d{1,2})分)?/g)];
  const last = matches.at(-1);
  if (!last) return null;
  let hour = Number(last[2]);
  if (last[1] === '午後' && hour < 12) hour += 12;
  const minute = last[3] === '半' ? 30 : Number(last[4] ?? 0);
  if (hour > 23 || minute > 59) return null;
  return { text: last[0].trim(), time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

/**
 * 台本の会話から予定を作る。AIではないので、決まった言い回しだけを読む。
 * 本物のGeminiと同じく日時の根拠の言葉（dateText / timeText）も返し、サーバーが会話と照合する。
 */
function mockAppointment(input: Record<string, unknown>) {
  const turns = Array.isArray(input['会話']) ? (input['会話'] as { text?: unknown }[]) : [];
  const text = turns.map((turn) => String(turn.text ?? '')).join('\n');
  const today = String(input['現在日時'] ?? '').slice(0, 10);
  const hasToday = /^\d{4}-\d{2}-\d{2}$/.test(today);
  let date: string | null = null;
  let dateText: string | null = null;
  const saturday = /土曜日?/.exec(text)?.[0];
  if (hasToday && /明後日/.test(text)) [date, dateText] = [addDays(today, 2), '明後日'];
  else if (hasToday && /明日/.test(text)) [date, dateText] = [addDays(today, 1), '明日'];
  else if (hasToday && saturday) [date, dateText] = [nextWeekday(today, 6), saturday];
  const time = lastTime(text);
  const details = [
    /マイナンバーカード/.test(text) && 'マイナンバーカードを持参',
    /ひまわりビルの2階/.test(text) && 'ひまわりビルの2階',
  ].filter(Boolean);
  return {
    title: null,
    dateText,
    date,
    timeText: time?.text ?? null,
    startTime: time?.time ?? null,
    endTime: null,
    location: /駅前の改札/.test(text) ? '駅前の改札' : /ひまわり医院/.test(text) ? 'ひまわり医院' : null,
    address: /住所は([^、。]+)/.exec(text)?.[1] ?? null,
    details: details.length > 0 ? details.join('。') : null,
  };
}

const reply = (data: unknown) => ({ text: JSON.stringify(data), promptFeedback: undefined, candidates: undefined });

const models: GeminiModels = {
  async generateContent(params) {
    await wait(aiMode === 'slow' ? SLOW_LATENCY_MS : MOCK_LATENCY_MS, params.config?.abortSignal);
    if (aiMode === 'fail') throw Object.assign(new Error('mock failure'), { status: 503 });

    const schema = params.config?.responseSchema as { properties?: Record<string, unknown> } | undefined;
    const input = JSON.parse(String(params.contents)) as Record<string, unknown>;
    const instruction = String(params.config?.systemInstruction ?? '');
    const purpose: CallPurpose = instruction.includes(CALL_PURPOSE_PROFILES.general.label) ? 'general' : 'medical';

    if (schema?.properties && 'suggestions' in schema.properties) {
      return reply({ suggestions: mockSuggestions(String(input['相手の最新の発言'] ?? ''), purpose) });
    }
    if (schema?.properties && 'polished' in schema.properties) {
      return reply({ polished: mockPolish(String(input['整形する入力'] ?? '')) });
    }
    return reply(mockAppointment(input));
  },
};

function state() {
  return { ai: aiMode, speech: speechStatus, scenario, nextLine: cursor, openStreams: openStreams.size };
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const send = (status: number, body: unknown) =>
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));

  if (url.pathname === '/__mock/ai') {
    const mode = url.searchParams.get('mode');
    if (mode === 'ok' || mode === 'fail' || mode === 'slow') aiMode = mode;
    send(200, state());
    return;
  }
  if (url.pathname === '/__mock/speech') {
    const status = url.searchParams.get('status');
    if (status === 'ready' || status === 'unavailable') {
      speechStatus = status;
      statusListeners.forEach((listener) => listener(status));
    }
    if (url.searchParams.get('fail') === '1') {
      openStreams.forEach((stream) => stream.destroy(new Error('mock stream failure')));
    }
    send(200, state());
    return;
  }
  if (url.pathname === '/__mock/state') {
    send(200, state());
    return;
  }
  send(404, { error: 'not_found' });
});

const config = {
  ...resolveGeminiConfig({}),
  backend: 'mock' as const,
  model: MOCK_AI_MODEL,
  problem: undefined,
};

const wss = attachCallServer(
  server,
  { ai: createAiAssistant(createGeminiRunner(config, models)), speech },
  { allowedOrigins: resolveAllowedOrigins(process.env) },
);

// 台本を選ぶため、発信の目的だけを読む。通話の処理は本番と同じ attachCallServer が行う。
wss.on('connection', (ws: WebSocket) => {
  ws.on('message', (raw: RawData, isBinary: boolean) => {
    if (isBinary) return;
    try {
      const message = JSON.parse(raw.toString()) as { type?: unknown; purpose?: unknown };
      if (message.type !== 'start_call') return;
      scenario = isCallPurpose(message.purpose) ? message.purpose : DEFAULT_CALL_PURPOSE;
      cursor = 0;
    } catch {
      // 読めないメッセージは本体の処理が断る。
    }
  });
});

server.listen(PORT, () => {
  console.log(`> EchoBridge MOCK server on port ${PORT} (development only: no Gemini, no Speech-to-Text)`);
});
