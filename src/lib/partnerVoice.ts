import { PARTNER_AUDIO_SAMPLE_RATE_HZ } from './callProtocol';

/**
 * 本人の画面で、相手の声（サーバーが中継する録音の音声）を鳴らす。
 *
 * 2026-11-09の判断（local-dev/notes/DECISIONS.md）:
 * - WebRTCは使わない。相手の画面はもうSTTのために16kHzのPCMをWebSocketで送っているので、同じ音声を本人へ中継する。
 *   新しい接続（シグナリング、TURN）がいらず、聞こえる音声と字幕のもとが同じになる
 * - 鳴らすのは Web Audio API。小さな区切りを隙間なく並べられる。届く間隔の揺れは、最初に少し待って吸収する
 * - 遅れが積み上がったら、その分は鳴らさない。古い声を聞かせるより、字幕と近い今の声を優先する
 *
 * ブラウザは操作なしに音を鳴らさないので、「相手の声を聞く」を押したとき（操作の中）に unlock する。
 * 再読み込みの後などで止まっていたら needs_gesture にし、次のタップで再開する。
 */

/**
 * 再開に使う操作。ブラウザが「利用者の操作」と認めるのは、タッチでは指を離したとき（pointerup・touchend）と
 * click で、押した瞬間（pointerdown）は認めない（iPhoneのSafariとAndroidのChrome）。マウスとキーは押した時点で認める。
 */
const GESTURE_EVENTS = ['pointerup', 'touchend', 'click', 'keydown'] as const;

/** 切り替えのボタンに付ける印。画面のどこかを押したときの自動の再開から外す。 */
export const PARTNER_VOICE_TOGGLE_ATTRIBUTE = 'data-partner-voice-toggle';

export type PartnerVoiceState =
  /** 本人が聞かないと選んでいる。 */
  | 'off'
  /** 聞くと選んでいるが、ブラウザが音を止めている。画面のどこかを押すと再開する。 */
  | 'needs_gesture'
  /** 鳴らせる。相手が話すと聞こえる。 */
  | 'on'
  /** このブラウザには音を鳴らす部品（Web Audio API）がない。字幕だけで続ける。 */
  | 'unavailable';

/** 届き始めてから鳴らすまでの待ち。届く間隔の揺れ（約0.1秒ごと）を吸収する。 */
export const START_LEAD_S = 0.15;

/** これより遅れたら、その区切りは鳴らさない。遅れを広げず、字幕との差を小さく保つ。 */
export const MAX_LAG_S = 0.8;

/** 区切りの端で音がぷつっと鳴らないよう、鳴らし始めの区切りだけ短く音量を上げる。 */
const FADE_IN_S = 0.01;

type AudioContextWindow = typeof window & { webkitAudioContext?: typeof AudioContext };

/** iOS 17 以降の Safari にある。playback にすると、消音スイッチがオンでも Web Audio が鳴る。 */
type AudioSessionNavigator = Navigator & { audioSession?: { type: string } };

function defaultCreateContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioCtx = window.AudioContext || (window as AudioContextWindow).webkitAudioContext;
  if (!AudioCtx) return null;
  try {
    return new AudioCtx();
  } catch {
    return null;
  }
}

function setAudioSession(type: 'playback' | 'auto'): void {
  try {
    const session = (typeof navigator !== 'undefined' ? (navigator as AudioSessionNavigator) : null)?.audioSession;
    if (session) session.type = type;
  } catch {
    // 対応していないブラウザでは何もしない。
  }
}

/** 16bit・リトルエンディアンのPCMを、-1〜1の値にする。奇数のバイトは捨てる。 */
export function pcm16ToFloat32(chunk: ArrayBuffer): Float32Array<ArrayBuffer> {
  const view = new DataView(chunk);
  const length = chunk.byteLength >> 1;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

/** 線形補間でレートを変える。16kHz の AudioBuffer を作れないブラウザだけで使う。 */
function upsample(samples: Float32Array, from: number, to: number): Float32Array<ArrayBuffer> {
  const length = Math.max(1, Math.round((samples.length * to) / from));
  const out = new Float32Array(length);
  const step = from / to;
  for (let i = 0; i < length; i += 1) {
    const position = i * step;
    const index = Math.floor(position);
    const next = Math.min(index + 1, samples.length - 1);
    const fraction = position - index;
    out[i] = samples[index] * (1 - fraction) + samples[next] * fraction;
  }
  return out;
}

export interface PartnerVoicePlayerOptions {
  onState(state: PartnerVoiceState): void;
  /** 相手の声が今聞こえているか（鳴らす予定の音が残っているか）。字幕の「音声を再生中」に使う。 */
  onAudible?(audible: boolean): void;
  /** テストで偽物の AudioContext を渡す。 */
  createContext?: () => AudioContext | null;
}

export class PartnerVoicePlayer {
  private context: AudioContext | null = null;
  private output: GainNode | null = null;
  private enabled = false;
  private resuming = false;
  private nextTime = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private audible = false;
  private lastState: PartnerVoiceState = 'off';
  private disposed = false;
  private gestureListening = false;
  private buffer16k = true;

  constructor(private readonly options: PartnerVoicePlayerOptions) {}

  get state(): PartnerVoiceState {
    return this.lastState;
  }

  /**
   * 聞くかどうかを変える。fromGesture は利用者の操作の中で呼んだとき。
   * 操作の外で聞くにしたとき（再読み込みの後など）は、止まっていれば次のタップを待つ。
   */
  setEnabled(enabled: boolean, fromGesture: boolean): void {
    if (this.disposed) return;
    this.enabled = enabled;
    if (enabled) {
      setAudioSession('playback');
      this.ensureContext();
      this.resume(fromGesture);
    } else {
      this.stop();
      setAudioSession('auto');
      const context = this.context;
      if (context && context.state === 'running') context.suspend?.().catch(() => {});
    }
    this.emitState();
  }

  /** 利用者の操作の中で呼ぶ。止まっていた音を再開する。 */
  unlock(): void {
    if (this.disposed || !this.enabled) return;
    this.ensureContext();
    this.resume(true);
    this.emitState();
  }

  /** 中継された音声の区切りを、届いた順に隙間なく並べて鳴らす。 */
  play(chunk: ArrayBuffer): void {
    const context = this.context;
    const output = this.output;
    if (this.disposed || !this.enabled || !context || !output || context.state !== 'running') return;
    const samples = pcm16ToFloat32(chunk);
    if (samples.length === 0) return;

    const now = context.currentTime;
    if (this.sources.size === 0 || this.nextTime < now) {
      // 話し始め、または届くのが途切れた。少し待ってから鳴らし、次の区切りが間に合うようにする。
      this.nextTime = now + START_LEAD_S;
    } else if (this.nextTime - now > MAX_LAG_S) {
      // 遅れが大きい。この区切りは鳴らさず、遅れを広げない。
      return;
    }

    const buffer = this.createBuffer(context, samples);
    if (!buffer) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    const startsAfterGap = this.sources.size === 0;
    if (startsAfterGap && typeof context.createGain === 'function') {
      const fade = context.createGain();
      fade.gain.setValueAtTime(0, this.nextTime);
      fade.gain.linearRampToValueAtTime(1, this.nextTime + FADE_IN_S);
      source.connect(fade);
      fade.connect(output);
    } else {
      source.connect(output);
    }
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0) this.setAudible(false);
    };
    this.sources.add(source);
    source.start(this.nextTime);
    this.nextTime += buffer.duration;
    this.setAudible(true);
  }

  /** 鳴らす予定の音をすべて止める（聞かないにした、通話を終えた）。 */
  stop(): void {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // まだ始まっていない区切りでも止められる。止められなくても外す。
      }
      source.disconnect?.();
    }
    this.sources.clear();
    this.nextTime = 0;
    this.setAudible(false);
  }

  /** 通話を終えたら呼ぶ。部品を閉じ、端末の音の設定を戻す。 */
  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.enabled = false;
    this.removeGestureListener();
    if (this.lastState !== 'off') setAudioSession('auto');
    const context = this.context;
    this.context = null;
    this.output = null;
    if (context) {
      context.onstatechange = null;
      if (context.state !== 'closed') context.close?.().catch(() => {});
    }
    this.lastState = 'off';
  }

  private ensureContext(): void {
    if (this.context) return;
    const context = (this.options.createContext ?? defaultCreateContext)();
    if (!context) return;
    this.context = context;
    const output = context.createGain();
    output.gain.value = 1;
    output.connect(context.destination);
    this.output = output;
    // 電話の着信や画面の切り替えで止まったら、再開を待つ表示にする。
    context.onstatechange = () => {
      if (context.state !== 'running') this.stop();
      this.emitState();
    };
  }

  private resume(fromGesture: boolean): void {
    const context = this.context;
    if (!context || context.state === 'running' || context.state === 'closed') return;
    if (fromGesture) this.primeOutput(context);
    this.resuming = true;
    const done = () => {
      this.resuming = false;
      this.emitState();
    };
    try {
      const resumed = context.resume?.();
      if (resumed) resumed.then(done, done);
      else done();
    } catch {
      done();
    }
  }

  /** iPhoneは操作の中で一度音を鳴らした部品でないと、後から鳴らさないことがあるので、無音を鳴らしておく。 */
  private primeOutput(context: AudioContext): void {
    try {
      const silent = context.createBuffer(1, 1, context.sampleRate);
      const source = context.createBufferSource();
      source.buffer = silent;
      source.connect(context.destination);
      source.start(0);
    } catch {
      // 鳴らせなくても resume の結果で判断する。
    }
  }

  private createBuffer(context: AudioContext, samples: Float32Array<ArrayBuffer>): AudioBuffer | null {
    try {
      if (this.buffer16k) {
        try {
          const buffer = context.createBuffer(1, samples.length, PARTNER_AUDIO_SAMPLE_RATE_HZ);
          buffer.copyToChannel(samples, 0);
          return buffer;
        } catch {
          // 古いSafariは 22.05kHz より低いレートの AudioBuffer を作れない。以後は自分でレートを変える。
          this.buffer16k = false;
        }
      }
      const resampled = upsample(samples, PARTNER_AUDIO_SAMPLE_RATE_HZ, context.sampleRate);
      const buffer = context.createBuffer(1, resampled.length, context.sampleRate);
      buffer.copyToChannel(resampled, 0);
      return buffer;
    } catch {
      return null;
    }
  }

  private setAudible(audible: boolean): void {
    if (this.audible === audible) return;
    this.audible = audible;
    this.options.onAudible?.(audible);
  }

  private computeState(): PartnerVoiceState {
    if (!this.enabled) return 'off';
    if (!this.context) return 'unavailable';
    const running = this.context.state === 'running';
    // 再開を待っている間は、押した直後に「止まっています」と出さない。
    return running || this.resuming ? 'on' : 'needs_gesture';
  }

  private emitState(): void {
    if (this.disposed) return;
    const state = this.computeState();
    if (state === 'needs_gesture') this.addGestureListener();
    else this.removeGestureListener();
    if (state === this.lastState) return;
    this.lastState = state;
    this.options.onState(state);
  }

  /**
   * 止まっている間は、画面のどこを押しても再開する。返答の候補を押したときなども含む。
   * 切り替えのボタン（PARTNER_VOICE_TOGGLE_ATTRIBUTE）は除く。そのボタンの処理が再開とオフを見分けるため。
   */
  private readonly onAnyGesture = (event: Event) => {
    const target = event.target as Element | null;
    if (typeof target?.closest === 'function' && target.closest(`[${PARTNER_VOICE_TOGGLE_ATTRIBUTE}]`)) return;
    this.unlock();
  };

  private addGestureListener(): void {
    if (this.gestureListening || typeof window === 'undefined') return;
    this.gestureListening = true;
    GESTURE_EVENTS.forEach((type) => window.addEventListener(type, this.onAnyGesture, true));
  }

  private removeGestureListener(): void {
    if (!this.gestureListening || typeof window === 'undefined') return;
    this.gestureListening = false;
    GESTURE_EVENTS.forEach((type) => window.removeEventListener(type, this.onAnyGesture, true));
  }
}

/** 本人の選択（相手の声を聞くか）。この端末のブラウザにだけ保存し、次の通話でも使う。 */
export const PARTNER_VOICE_KEY = 'echobridge.partnerVoice.v1';

const preferenceListeners = new Set<() => void>();

// 保存できないブラウザ（保存を禁止した設定など）でも、このページを開いている間は選んだとおりにする。
// 保存に失敗したときだけ、このページで選んだ値を使う。
let unsavedPreference: boolean | null = null;

export function loadPartnerVoicePreference(): boolean {
  if (unsavedPreference !== null) return unsavedPreference;
  try {
    return window.localStorage.getItem(PARTNER_VOICE_KEY) === 'on';
  } catch {
    return false;
  }
}

export function savePartnerVoicePreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(PARTNER_VOICE_KEY, enabled ? 'on' : 'off');
    unsavedPreference = null;
  } catch {
    unsavedPreference = enabled;
  }
  preferenceListeners.forEach((listener) => listener());
}

export function subscribePartnerVoicePreference(listener: () => void): () => void {
  preferenceListeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === PARTNER_VOICE_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    preferenceListeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}
