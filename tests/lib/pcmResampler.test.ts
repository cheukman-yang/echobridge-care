import { describe, expect, it } from 'vitest';
import { Pcm16Resampler } from '@/lib/pcmResampler';

const STT_RATE = 16000;

function sine(frequency: number, rate: number, samples: number, amplitude = 0.5): Float32Array {
  const signal = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) signal[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / rate);
  return signal;
}

/** 決まった順の、ばらばらな長さ。ブラウザの塊の長さは端末で違うので、境目で音が崩れないかを見る。 */
function chunkSizes(total: number): number[] {
  const sizes: number[] = [];
  let seed = 7;
  let used = 0;
  while (used < total) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const size = Math.min(total - used, 1 + (seed % 5000));
    sizes.push(size);
    used += size;
  }
  return sizes;
}

function run(resampler: Pcm16Resampler, input: Float32Array, sizes: number[] = [input.length]): Int16Array {
  const parts: Int16Array[] = [];
  let offset = 0;
  for (const size of sizes) {
    parts.push(resampler.process(input.subarray(offset, offset + size)));
    offset += size;
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Int16Array(total);
  let at = 0;
  for (const part of parts) {
    output.set(part, at);
    at += part.length;
  }
  return output;
}

function rms(samples: ArrayLike<number>, from = 0): number {
  let sum = 0;
  for (let i = from; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (samples.length - from));
}

/** その周波数の成分の振幅（1つのDFTの値）。区間に周期がちょうど収まる長さで使う。 */
function amplitudeAt(samples: Int16Array, frequency: number, rate: number, from: number, length: number): number {
  let re = 0;
  let im = 0;
  for (let i = 0; i < length; i += 1) {
    const angle = (2 * Math.PI * frequency * i) / rate;
    re += samples[from + i] * Math.cos(angle);
    im -= samples[from + i] * Math.sin(angle);
  }
  return (2 * Math.hypot(re, im)) / length;
}

describe('マイクの音声を16kHzのPCMにする', () => {
  it.each([
    [48000, 4096],
    [44100, 4096],
    [96000, 2048],
    [24000, 1024],
  ])('%iHzを1秒あたり16000サンプルにする（長く録ってもずれない）', (rate, size) => {
    const seconds = 10;
    const input = new Float32Array(rate * seconds);
    const resampler = new Pcm16Resampler(rate, STT_RATE);

    const sizes = Array.from({ length: Math.ceil(input.length / size) }, (_, i) =>
      Math.min(size, input.length - i * size),
    );
    const output = run(resampler, input, sizes);

    expect(Math.abs(output.length - STT_RATE * seconds)).toBeLessThanOrEqual(1);
  });

  it('塊の分け方が違っても、同じ音になる', () => {
    const rate = 44100;
    const input = sine(1234, rate, rate * 2);

    const whole = run(new Pcm16Resampler(rate, STT_RATE), input);
    const pieces = run(new Pcm16Resampler(rate, STT_RATE), input, chunkSizes(input.length));

    expect(pieces).toEqual(whole);
  });

  it.each([
    [48000, 1000],
    [48000, 3000],
    [44100, 1000],
    [44100, 4000],
  ])('%iHzの%iHzの音は、高さと大きさを保つ', (rate, frequency) => {
    const output = run(new Pcm16Resampler(rate, STT_RATE), sine(frequency, rate, rate), chunkSizes(rate));
    // 先頭はフィルタが落ち着くまで除き、周期がちょうど収まる1600サンプル（0.1秒）で測る。
    const amplitude = amplitudeAt(output, frequency, STT_RATE, 800, 1600);

    // 44.1kHzは割り切れないので補間する。高い音ほど少し小さくなる（4kHzで約4%）。声の認識には影響しない大きさ。
    expect(amplitude / (0.5 * 0x7fff)).toBeGreaterThan(0.95);
    expect(amplitude / (0.5 * 0x7fff)).toBeLessThan(1.02);
    // ほかの周波数の成分（折り返しや崩れ）がほとんどない。
    expect(rms(output.subarray(800, 2400)) / (amplitude / Math.SQRT2)).toBeLessThan(1.02);
  });

  it.each([
    [48000, 12000],
    [48000, 15000],
    [44100, 11025],
  ])('%iHzの%iHzの音は、間引く前に落とし、雑音として残さない', (rate, frequency) => {
    const output = run(new Pcm16Resampler(rate, STT_RATE), sine(frequency, rate, rate), chunkSizes(rate));

    expect(rms(output, 200) / ((0.5 * 0x7fff) / Math.SQRT2)).toBeLessThan(0.01);
  });

  it('16kHzのときはそのまま16bitにする', () => {
    const input = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25, -0.25, 0.125]);

    const output = run(new Pcm16Resampler(STT_RATE, STT_RATE), input, [3, 1, 4]);

    // 最後の1つは次の塊が来てから出す。
    expect(Array.from(output)).toEqual([0, 16383, -16384, 32767, -32768, 8191, -8192]);
  });

  it('8kHzからは間を補って16kHzにする', () => {
    const output = run(new Pcm16Resampler(8000, STT_RATE), new Float32Array([0, 0.5, 1, 0.5, 0]));

    expect(Array.from(output)).toEqual([0, 8191, 16383, 24575, 32767, 24575, 16383, 8191]);
  });

  it('直流は同じ大きさのまま', () => {
    const output = run(new Pcm16Resampler(48000, STT_RATE), new Float32Array(4800).fill(0.25));

    for (const value of output.subarray(100)) expect(Math.abs(value - 0.25 * 0x7fff)).toBeLessThanOrEqual(1);
  });

  it('範囲を超えた値は端にそろえ、壊れた値は無音にする', () => {
    const output = run(new Pcm16Resampler(STT_RATE, STT_RATE), new Float32Array([2, -2, Number.NaN, 0.5, 0]));

    expect(Array.from(output)).toEqual([32767, -32768, 0, 16383]);
  });

  it('返す配列の buffer は中身の長さだけで、そのまま送れる', () => {
    const resampler = new Pcm16Resampler(48000, STT_RATE);

    for (const size of [4096, 4095, 1, 2, 3, 128]) {
      const output = resampler.process(new Float32Array(size).fill(0.1));
      expect(output.buffer.byteLength).toBe(output.length * 2);
    }
  });

  it('空の塊は何も出さず、続きの音も変えない', () => {
    const input = sine(500, 48000, 9000);
    const plain = run(new Pcm16Resampler(48000, STT_RATE), input, [4000, 5000]);

    const resampler = new Pcm16Resampler(48000, STT_RATE);
    const first = resampler.process(input.subarray(0, 4000));
    const empty = resampler.process(new Float32Array(0));
    const second = resampler.process(input.subarray(4000));

    expect(empty.length).toBe(0);
    expect([...first, ...second]).toEqual(Array.from(plain));
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000])('おかしなレート（%s）は受け付けない', (rate) => {
    expect(() => new Pcm16Resampler(rate, STT_RATE)).toThrow(RangeError);
  });
});
