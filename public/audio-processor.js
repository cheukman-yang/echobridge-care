/**
 * AudioWorkletProcessor for EchoBridge
 * 入力音声をリアルタイムに 16,000Hz モノラル 16-bit PCM (Int16Array) にダウンサンプリングし、
 * メインスレッド（WebSocket送信用）に転送するプロセッサ
 */
class PcmDownsamplerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 16000;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const inputChannel = input[0];
    if (!inputChannel || inputChannel.length === 0) {
      return true;
    }

    const sourceSampleRate = sampleRate;
    const ratio = sourceSampleRate / this.targetSampleRate;
    const outputLength = Math.floor(inputChannel.length / ratio);
    const pcm16Data = new Int16Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const sourceIndex = i * ratio;
      const indexFloor = Math.floor(sourceIndex);
      const indexCeil = Math.min(indexFloor + 1, inputChannel.length - 1);
      const interpolationFactor = sourceIndex - indexFloor;

      const sample =
        inputChannel[indexFloor] * (1 - interpolationFactor) +
        inputChannel[indexCeil] * interpolationFactor;

      const clampedSample = Math.max(-1, Math.min(1, sample));
      pcm16Data[i] = clampedSample < 0 ? clampedSample * 0x8000 : clampedSample * 0x7fff;
    }

    if (pcm16Data.length > 0) {
      this.port.postMessage(pcm16Data.buffer, [pcm16Data.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-downsampler-processor', PcmDownsamplerProcessor);
