import type { PlaybackStatus, SpeechAudio, SpeechEngine } from './callProtocol';

/**
 * 相手の画面で、本人の文を順に鳴らす仕組み。
 *
 * - 番号の順に1文ずつ鳴らす。先頭の文の音声がまだ届いていなければ、後ろの文が先に届いても待つ
 * - サーバーで合成した音声（cloud）を優先し、作れなかった・時間内に届かなかった・再生できなかった文は端末の声（device）で読む
 * - 端末に日本語の声がなければ読まない。別の言語の声で日本語を読むと、聞き取れない音になる
 * - ブラウザが自動再生を止めたら（blocked）、相手が画面のボタンを押すまで待ち、順番も崩さない
 * - 再生が始まった・終わったことを確かめてから報告する。確かめられなければ「読み上げ済み」にしない
 *
 * ブラウザの部品（audio要素、speechSynthesis）は差し替えられるので、テストでは偽物を使う。
 */

export interface PlaybackEvents {
  onStart(): void;
  onEnd(): void;
  /** blocked: ブラウザが自動再生を止めた。利用者の操作の後なら再生できる。 */
  onError(kind: 'blocked' | 'failed'): void;
}

export interface PlaybackHandle {
  stop(): void;
}

/** サーバーで合成した音声を鳴らす部品。 */
export interface AudioOutput {
  /** 利用者の操作（タップなど）の処理の中で呼ぶ。iPhoneなどは、これがないと後から鳴らせない。 */
  unlock(): void;
  play(audio: SpeechAudio, events: PlaybackEvents): PlaybackHandle;
}

/**
 * 端末の声の状態。
 * - japanese: 日本語の声がある
 * - unknown: 声の一覧がまだ読み込まれていない（ブラウザによっては後から届く）
 * - none: 声はあるが、日本語の声がない
 * - unsupported: 読み上げの機能がない
 */
export type DeviceVoiceSupport = 'japanese' | 'unknown' | 'none' | 'unsupported';

/** 端末の声（speechSynthesis）で読む部品。 */
export interface DeviceVoice {
  support(): DeviceVoiceSupport;
  unlock(): void;
  speak(text: string, events: PlaybackEvents): PlaybackHandle;
  cancelAll(): void;
}

export interface SpeechQueueState {
  /** 鳴らしている、または音声を待っている文の番号。自動案内は null。 */
  seq: number | null;
  phase: 'idle' | 'waiting' | 'playing';
  /** ブラウザが自動再生を止めていて、利用者の操作が必要。 */
  blocked: boolean;
  /** 端末に日本語の声がなく、字幕だけになった文がある。 */
  deviceVoiceMissing: boolean;
}

export interface SpeechQueueOptions {
  output: AudioOutput;
  device: DeviceVoice;
  /** 録音中や再読み込みの直後など、鳴らし始めてはいけない間は true。 */
  isPaused(): boolean;
  onState(state: SpeechQueueState): void;
  /** 本人の発言の再生の結果。自動案内（番号なし）は報告しない。 */
  onReport(seq: number, status: PlaybackStatus, engine: SpeechEngine): void;
  /** 読み終えた、または読めないと分かった。再接続で二度読まないよう覚える。読み直しでは呼ばない。 */
  onSpoken(seq: number): void;
  /** サーバーへ音声を求める。 */
  onNeedAudio(seq: number): void;
}

export interface SpeechRequest {
  text: string;
  /** 通話の記録の番号。自動案内にはない。 */
  seq?: number;
  /** 一緒に届いた音声。 */
  audio?: SpeechAudio;
  /** サーバーが合成した音声が後から届くのを待つか。 */
  expectAudio: boolean;
  /** 読み直し。読み終えても onSpoken を呼ばない。 */
  replay?: boolean;
}

/**
 * 端末の声の読み上げが終わった合図を待つ上限。
 * ブラウザによっては長い文の途中で止まり、終わりの合図が来ない。待ち続けると録音もできなくなる。
 */
export function readingWatchdogMs(text: string): number {
  return Math.max(8_000, text.length * 300 + 4_000);
}

/**
 * サーバーの音声を待つ上限。サーバーの合成の待ち時間（3秒＋40ms/字、最大15秒）に、送る時間を足す。
 * 過ぎたら端末の声で読む。
 */
export function audioWaitMs(text: string): number {
  return Math.min(17_000, 5_000 + text.length * 40);
}

/** 時間切れで読み上げを止めた後、次の文を読むまでの間。止める処理に次の文が巻き込まれないようにする。 */
export const RESUME_AFTER_CANCEL_MS = 300;

/** 読み直し用に持っておく音声の数。 */
const MAX_CACHED_AUDIO = 40;

interface Item {
  text: string;
  seq?: number;
  replay: boolean;
  /** undefined: 届くのを待っている / null: 端末の声で読む */
  audio: SpeechAudio | null | undefined;
  waitTimer: ReturnType<typeof setTimeout> | null;
  blockedReported: boolean;
}

interface Playing {
  item: Item;
  engine: SpeechEngine;
  started: boolean;
  finished: boolean;
  handle: PlaybackHandle | null;
  watchdog: ReturnType<typeof setTimeout> | null;
}

export class SpeechPlaybackQueue {
  private items: Item[] = [];
  private current: Playing | null = null;
  private blocked = false;
  private cooldown: ReturnType<typeof setTimeout> | null = null;
  private deviceVoiceMissing = false;
  private readonly audioBySeq = new Map<number, SpeechAudio>();
  private lastState: SpeechQueueState = { seq: null, phase: 'idle', blocked: false, deviceVoiceMissing: false };

  constructor(private readonly options: SpeechQueueOptions) {}

  /** 今鳴らしているか。鳴らしている間はマイクの音声を送らない。 */
  get isPlaying(): boolean {
    return this.current !== null;
  }

  enqueue(request: SpeechRequest): void {
    const cached = request.seq !== undefined ? this.audioBySeq.get(request.seq) : undefined;
    const audio = request.audio ?? cached;
    if (request.audio && request.seq !== undefined) this.remember(request.seq, request.audio);
    this.items.push({
      text: request.text,
      seq: request.seq,
      replay: request.replay ?? false,
      audio: audio ?? (request.expectAudio ? undefined : null),
      waitTimer: null,
      blockedReported: false,
    });
    this.process();
  }

  /** 読み直す。同じ文が並んでいれば足さない。 */
  replay(seq: number, text: string, expectAudio: boolean): void {
    if (this.items.some((item) => item.seq === seq)) return;
    const hasAudio = this.audioBySeq.has(seq);
    this.enqueue({ text, seq, expectAudio, replay: true });
    if (!hasAudio && expectAudio) this.options.onNeedAudio(seq);
  }

  provideAudio(seq: number, audio: SpeechAudio): void {
    this.remember(seq, audio);
    for (const item of this.items) {
      if (item.seq === seq && item.audio === undefined) {
        item.audio = audio;
        this.clearWait(item);
      }
    }
    this.process();
  }

  /** サーバーが音声を作れなかった。端末の声で読む。 */
  audioFailed(seq: number): void {
    for (const item of this.items) {
      if (item.seq === seq && item.audio === undefined) {
        item.audio = null;
        this.clearWait(item);
      }
    }
    this.process();
  }

  /** 音声を待っている文を、サーバーへもう一度求める（再接続の後）。 */
  requestPendingAudio(): void {
    const requested = new Set<number>();
    for (const item of this.items) {
      if (item.seq !== undefined && item.audio === undefined && !requested.has(item.seq)) {
        requested.add(item.seq);
        this.options.onNeedAudio(item.seq);
      }
    }
  }

  /**
   * 利用者の操作の中で呼ぶ。止められていた再生をやり直す。
   * 同じ操作の中で鳴らし始めるので、iPhoneでも再生が許される。
   */
  unlock(): void {
    this.options.output.unlock();
    this.options.device.unlock();
    this.blocked = false;
    this.process();
  }

  /** 録音が終わった、再開できるようになったなど、鳴らし始められるかもしれないときに呼ぶ。 */
  process(): void {
    this.advance();
    this.emit();
  }

  clear(): void {
    const playing = this.current;
    if (playing) this.abandon(playing);
    this.items.forEach((item) => this.clearWait(item));
    this.items = [];
    this.blocked = false;
    if (this.cooldown) {
      clearTimeout(this.cooldown);
      this.cooldown = null;
    }
    this.audioBySeq.clear();
    this.deviceVoiceMissing = false;
    this.options.device.cancelAll();
    this.emit();
  }

  private advance(): void {
    if (this.current || this.blocked || this.cooldown || this.items.length === 0) return;
    if (this.options.isPaused()) return;
    const item = this.items[0];
    if (item.audio === undefined) {
      this.startWaiting(item);
      return;
    }
    if (item.audio) {
      const audio = item.audio;
      this.start(item, 'cloud', (events) => this.options.output.play(audio, events));
      return;
    }
    const support = this.options.device.support();
    if (support === 'none' || support === 'unsupported') {
      // 別の言語の声で読ませない。字幕には出ているので、相手は文字で受け取れる。
      this.deviceVoiceMissing = true;
      this.complete(item, 'failed', 'device');
      return;
    }
    this.start(item, 'device', (events) => this.options.device.speak(item.text, events));
  }

  private startWaiting(item: Item): void {
    if (item.waitTimer) return;
    item.waitTimer = setTimeout(() => {
      item.waitTimer = null;
      if (item.audio !== undefined) return;
      item.audio = null;
      this.process();
    }, audioWaitMs(item.text));
  }

  private clearWait(item: Item): void {
    if (item.waitTimer) {
      clearTimeout(item.waitTimer);
      item.waitTimer = null;
    }
  }

  private start(item: Item, engine: SpeechEngine, run: (events: PlaybackEvents) => PlaybackHandle): void {
    const playing: Playing = { item, engine, started: false, finished: false, handle: null, watchdog: null };
    this.current = playing;
    const events: PlaybackEvents = {
      onStart: () => {
        if (playing.finished || playing.started) return;
        playing.started = true;
        if (item.seq !== undefined) this.options.onReport(item.seq, 'started', engine);
        this.emit();
      },
      onEnd: () => this.finish(playing, 'ended'),
      onError: (kind) => {
        if (playing.finished) return;
        if (kind === 'blocked') {
          // 先頭のまま残し、利用者の操作で鳴らし直す。後ろの文を先に鳴らさない。
          this.abandon(playing);
          this.blocked = true;
          if (item.seq !== undefined && !item.blockedReported) {
            item.blockedReported = true;
            this.options.onReport(item.seq, 'blocked', engine);
          }
          this.emit();
          return;
        }
        if (engine === 'cloud') {
          // 音声を再生できなかったので、同じ文を端末の声で読む。
          this.abandon(playing);
          item.audio = null;
          this.process();
          return;
        }
        this.finish(playing, 'failed');
      },
    };
    playing.watchdog = setTimeout(() => this.timeOut(playing), readingWatchdogMs(item.text));
    const handle = run(events);
    playing.handle = handle;
    if (playing.finished) handle.stop();
  }

  /** 先頭の文を終える。 */
  private finish(playing: Playing, status: PlaybackStatus): void {
    if (playing.finished) return;
    playing.finished = true;
    if (playing.watchdog) clearTimeout(playing.watchdog);
    this.current = null;
    this.complete(playing.item, status, playing.engine);
  }

  private complete(item: Item, status: PlaybackStatus, engine: SpeechEngine): void {
    if (this.items[0] === item) this.items.shift();
    this.clearWait(item);
    if (item.seq !== undefined) {
      if (!item.replay) this.options.onSpoken(item.seq);
      this.options.onReport(item.seq, status, engine);
    }
    this.process();
  }

  /** 今の再生を止める。文は先頭に残す。 */
  private abandon(playing: Playing): void {
    playing.finished = true;
    if (playing.watchdog) clearTimeout(playing.watchdog);
    playing.handle?.stop();
    if (this.current === playing) this.current = null;
  }

  /**
   * 終わりの合図が来ない。再生を実際に止めてから先へ進む。止めないと次の文が始まらず、録音の音声も捨てられる。
   * 始まりの合図もなければ、聞こえていないとみなす。サーバーの音声なら端末の声で読み直す。
   */
  private timeOut(playing: Playing): void {
    if (playing.finished) return;
    this.abandon(playing);
    const { item, engine, started } = playing;
    if (engine === 'cloud' && !started) {
      item.audio = null;
    } else {
      if (this.items[0] === item) this.items.shift();
      if (item.seq !== undefined) {
        if (!item.replay) this.options.onSpoken(item.seq);
        // 始まった後に止まったなら、聞けた部分があるかもしれない。「読み上げ済み」とも「失敗」とも報告しない。
        if (!started) this.options.onReport(item.seq, 'failed', engine);
      }
    }
    this.cooldown = setTimeout(() => {
      this.cooldown = null;
      this.process();
    }, RESUME_AFTER_CANCEL_MS);
    this.emit();
  }

  private remember(seq: number, audio: SpeechAudio): void {
    this.audioBySeq.delete(seq);
    this.audioBySeq.set(seq, audio);
    while (this.audioBySeq.size > MAX_CACHED_AUDIO) {
      const oldest = this.audioBySeq.keys().next().value as number;
      this.audioBySeq.delete(oldest);
    }
  }

  private emit(): void {
    const head = this.items[0];
    const waiting =
      !this.current && !this.blocked && head !== undefined && head.audio === undefined && !this.options.isPaused();
    const state: SpeechQueueState = {
      seq: this.current ? (this.current.item.seq ?? null) : waiting ? (head.seq ?? null) : null,
      phase: this.current ? 'playing' : waiting ? 'waiting' : 'idle',
      blocked: this.blocked,
      deviceVoiceMissing: this.deviceVoiceMissing,
    };
    const last = this.lastState;
    if (
      last.seq === state.seq &&
      last.phase === state.phase &&
      last.blocked === state.blocked &&
      last.deviceVoiceMissing === state.deviceVoiceMissing
    ) {
      return;
    }
    this.lastState = state;
    this.options.onState(state);
  }
}
