'use client';

import { useState, useRef, useCallback } from 'react';

interface UseAudioRecorderOptions {
  onAudioChunk: (base64Audio: string) => void;
}

type AudioRecorderInput = UseAudioRecorderOptions | ((base64Audio: string) => void);

const PROCESSOR_CODE = `
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 16000;
    this.sampleRateRatio = sampleRate / this.targetSampleRate;
    this.bufferSize = 2048; // 約128ms分のチャンク
    this.pcmBuffer = new Int16Array(this.bufferSize);
    this.pcmIndex = 0;
    this.phase = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      const channelData = input[0];
      
      let sum = 0;
      for (let i = 0; i < channelData.length; i++) {
        sum += Math.abs(channelData[i]);
      }
      const avgVol = sum / channelData.length;

      // ネイティブレートから 16000Hz への線形補間リサンプリング
      while (this.phase < channelData.length) {
        const idx = Math.floor(this.phase);
        const nextIdx = Math.min(idx + 1, channelData.length - 1);
        const frac = this.phase - idx;
        const s = channelData[idx] * (1 - frac) + channelData[nextIdx] * frac;
        const clamped = Math.max(-1, Math.min(1, s));
        this.pcmBuffer[this.pcmIndex++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;

        if (this.pcmIndex >= this.bufferSize) {
          const chunk = new Int16Array(this.pcmBuffer);
          this.port.postMessage({ pcm16: chunk, avgVol }, [chunk.buffer]);
          this.pcmIndex = 0;
        }

        this.phase += this.sampleRateRatio;
      }
      this.phase -= channelData.length;
    }
    return true;
  }
}
registerProcessor('audio-processor', AudioProcessor);
`;

export function useAudioRecorder(input: AudioRecorderInput) {
  const [isRecording, setIsRecording] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);

  const onAudioChunk = typeof input === 'function' ? input : input?.onAudioChunk;

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      // 引数なしで作成し、OSネイティブのサンプリングレート（48kHz等）で確実にキャプチャ
      const AudioCtx =
        window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      const audioContext = new AudioCtx();
      audioContextRef.current = audioContext;

      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      const blob = new Blob([PROCESSOR_CODE], { type: 'application/javascript' });
      const moduleUrl = URL.createObjectURL(blob);
      await audioContext.audioWorklet.addModule(moduleUrl);
      URL.revokeObjectURL(moduleUrl);

      const sourceNode = audioContext.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioContext, 'audio-processor');
      workletNodeRef.current = workletNode;

      let chunkCount = 0;
      workletNode.port.onmessage = (event) => {
        const { pcm16, avgVol } = event.data;
        const buffer = new Uint8Array(pcm16.buffer);
        let binary = '';
        for (let i = 0; i < buffer.byteLength; i++) {
          binary += String.fromCharCode(buffer[i]);
        }
        const base64 = btoa(binary);

        chunkCount++;
        if (chunkCount % 8 === 0) {
          console.log(`[Mic] 送信中 (${chunkCount}) 入力レベル: ${(avgVol * 100).toFixed(1)}%`);
        }

        if (typeof onAudioChunk === 'function') {
          onAudioChunk(base64);
        }
      };

      const muteGain = audioContext.createGain();
      muteGain.gain.value = 0;

      sourceNode.connect(workletNode);
      workletNode.connect(muteGain);
      muteGain.connect(audioContext.destination);

      setIsRecording(true);
      console.log(`[Mic] 録音開始 (Native Rate: ${audioContext.sampleRate}Hz -> 16000Hz リサンプリング)`);
    } catch (err) {
      console.error('[Mic] 録音開始失敗:', err);
      setIsRecording(false);
    }
  }, [onAudioChunk]);

  const stopRecording = useCallback(() => {
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    setIsRecording(false);
    console.log('[Mic] 録音停止');
  }, []);

  return { isRecording, startRecording, stopRecording };
}