/** 相手の声の再生（src/lib/partnerVoice.ts）のテスト用。必要な部分だけの AudioContext で、時刻はテストで進める。 */

class FakeParam {
  value = 1;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
}

class FakeNode {
  connect() {}
  disconnect() {}
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

export class FakeSource extends FakeNode {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped = false;
  start(when = 0) {
    this.startedAt = when;
  }
  stop() {
    this.stopped = true;
  }
}

export class FakeAudioContext {
  state: AudioContextState = 'suspended';
  currentTime = 0;
  sampleRate = 48000;
  destination = new FakeNode();
  onstatechange: (() => void) | null = null;
  sources: FakeSource[] = [];
  buffers: { length: number; rate: number }[] = [];
  /** false なら resume しても動き出さない（操作がないときのブラウザ）。 */
  allowResume = true;
  /** 16kHz の AudioBuffer を作れない古いブラウザを真似る。 */
  rejectLowRate = false;
  closed = false;

  createGain() {
    return new FakeGain();
  }
  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  createBuffer(_channels: number, length: number, rate: number) {
    if (this.rejectLowRate && rate < 22050) throw new Error('NotSupportedError');
    this.buffers.push({ length, rate });
    return { duration: length / rate, copyToChannel() {} };
  }
  resume() {
    if (this.allowResume) this.setState('running');
    return Promise.resolve();
  }
  suspend() {
    this.setState('suspended');
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    this.state = 'closed';
    return Promise.resolve();
  }
  setState(state: AudioContextState) {
    this.state = state;
    this.onstatechange?.();
  }
  /** 鳴らした区切り（無音の準備を除く）。 */
  get scheduled() {
    return this.sources.filter((source) => source.buffer && source.buffer.duration > 0.001);
  }
}


/** 作った AudioContext を覚える。画面のテストで window.AudioContext の代わりに置く。 */
export function installFakeAudioContext(): FakeAudioContext[] {
  const created: FakeAudioContext[] = [];
  class Tracked extends FakeAudioContext {
    constructor() {
      super();
      created.push(this);
    }
  }
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = Tracked;
  return created;
}

/** 16kHz・16bit で ms ミリ秒分の音声。 */
export function pcmChunk(ms: number, value = 1000): ArrayBuffer {
  const samples = (16000 * ms) / 1000;
  const buffer = new ArrayBuffer(samples * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples; i += 1) view.setInt16(i * 2, value, true);
  return buffer;
}
