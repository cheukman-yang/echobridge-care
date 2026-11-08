/**
 * マイクの音声（-1〜1の浮動小数）を、Speech-to-Text へ送る16bitのPCMに変える。サンプリングレートもそろえる。
 *
 * AudioContext に sampleRate を指定して、変換をブラウザに任せない理由（2026-11-09の判断）:
 * - iPhoneのSafariは、端末と違うレートを指定すると1秒あたりのサンプルが足りなくなる報告がある
 *   （WebKit bug 251350。iOS 15.6〜16.2で報告され、未解決）。STTには欠けて早回しになった音として届く
 * - Firefoxは長い間、マイクと違うレートの AudioContext につなぐと例外を投げていた（Mozilla bug 1674892）
 *
 * そこで端末の標準のレートで録り、ここで高い音を落としてから間引く。
 * 高い音を残したまま間引くと、雑音（折り返し）になって声の帯域に重なる。
 *
 * 入力は細切れで届くので、塊の境目でも音がつながるよう、前の塊の末尾を持ち越す。
 */

const MIN_SAMPLE_RATE = 3000;
const MAX_SAMPLE_RATE = 768000;

/** 出力のナイキスト周波数に対する、低域通過フィルタの遮断周波数の比。16kHzなら7kHz。 */
const CUTOFF_RATIO = 0.875;

/** フィルタの長さを決める係数。間引く比が大きいほど長くし、どのレートでも同じくらいの切れにする。 */
const TAPS_PER_RATIO = 8;

function greatestCommonDivisor(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const rest = x % y;
    x = y;
    y = rest;
  }
  return x;
}

function toSampleRate(value: number, label: string): number {
  const rate = Math.round(value);
  if (!Number.isFinite(rate) || rate < MIN_SAMPLE_RATE || rate > MAX_SAMPLE_RATE) {
    throw new RangeError(`${label} sample rate is out of range: ${value}`);
  }
  return rate;
}

/**
 * 窓付きsinc（ハミング窓）の低域通過フィルタ。直流の大きさが変わらないよう、係数の合計を1にする。
 * cutoff は入力のサンプリングレートに対する比（0〜0.5）。
 */
function lowPassTaps(cutoff: number, length: number): Float32Array {
  const taps = new Float32Array(length);
  const middle = (length - 1) / 2;
  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    const x = i - middle;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (length - 1));
    taps[i] = sinc * window;
    sum += taps[i];
  }
  for (let i = 0; i < length; i += 1) taps[i] /= sum;
  return taps;
}

/** -1〜1を16bitの整数にする。範囲外は端にそろえる。NaN は Int16Array に入れると0になる。 */
function toInt16(value: number): number {
  const clamped = value > 1 ? 1 : value < -1 ? -1 : value;
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

export class Pcm16Resampler {
  readonly inputRate: number;
  readonly outputRate: number;
  /** 出力の1サンプルごとに、入力を down / up サンプル進む。整数で数え、長く録っても位置がずれない。 */
  private readonly up: number;
  private readonly down: number;
  /** 間引くときだけ使う。同じか上げるときは高い音の折り返しが起きない。 */
  private readonly taps: Float32Array | null;
  /** フィルタに使う、これまでの入力の末尾。 */
  private history: Float32Array;
  /** 前の塊の最後の値（フィルタの後）。塊の境目をまたいで補間する。 */
  private lastValue = 0;
  /** 次に出す位置。今の塊の先頭からの距離を 1/up サンプル単位で持つ。-up 以上。 */
  private position = 0;

  constructor(inputRate: number, outputRate: number) {
    this.inputRate = toSampleRate(inputRate, 'input');
    this.outputRate = toSampleRate(outputRate, 'output');
    const divisor = greatestCommonDivisor(this.inputRate, this.outputRate);
    this.up = this.outputRate / divisor;
    this.down = this.inputRate / divisor;

    if (this.inputRate > this.outputRate) {
      const ratio = this.inputRate / this.outputRate;
      const length = 2 * Math.ceil(TAPS_PER_RATIO * ratio) + 1;
      this.taps = lowPassTaps((CUTOFF_RATIO * 0.5) / ratio, length);
      this.history = new Float32Array(length - 1);
    } else {
      this.taps = null;
      this.history = new Float32Array(0);
    }
  }

  /** 1つの塊を変える。返す配列の buffer は、その配列の分だけの長さで、そのまま送れる。 */
  process(input: Float32Array): Int16Array<ArrayBuffer> {
    const length = input.length;
    if (length === 0) return new Int16Array(0);

    const filtered = this.filter(input);
    const { up, down } = this;
    // 補間には次の値も要るので、塊の最後の値の位置は次の塊で出す。
    const limit = (length - 1) * up;
    let position = this.position;
    // 位置は整数なので、出す数は (limit - position) / down の切り上げでちょうど決まる。
    const count = position < limit ? Math.floor((limit - position + down - 1) / down) : 0;
    const output = new Int16Array(count);

    for (let i = 0; i < count; i += 1) {
      const index = Math.floor(position / up);
      const fraction = (position - index * up) / up;
      const from = index < 0 ? this.lastValue : filtered[index];
      // 割り切れる比（48kHz→16kHzなど）では補間しない。隣の値が壊れていても巻き込まない。
      output[i] = toInt16(fraction === 0 ? from : from + (filtered[index + 1] - from) * fraction);
      position += down;
    }

    this.position = position - length * up;
    this.lastValue = filtered[length - 1];
    return output;
  }

  private filter(input: Float32Array): Float32Array {
    const taps = this.taps;
    if (!taps) return input;

    const carried = this.history.length;
    const extended = new Float32Array(carried + input.length);
    extended.set(this.history, 0);
    extended.set(input, carried);

    const filtered = new Float32Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      let sum = 0;
      const end = i + carried;
      for (let k = 0; k < taps.length; k += 1) sum += taps[k] * extended[end - k];
      filtered[i] = sum;
    }
    this.history = extended.slice(extended.length - carried);
    return filtered;
  }
}
