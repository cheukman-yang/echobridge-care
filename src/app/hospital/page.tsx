"use client";

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Phone, Mic, RotateCcw } from 'lucide-react';

export default function HospitalApp() {
  const [isConnected, setIsConnected] = useState(false);
  const [callState, setCallState] = useState<'idle' | 'ringing' | 'connected' | 'ended'>('idle');
  const [callerIntent, setCallerIntent] = useState('');
  const [isRecording, setIsRecording] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  const ringtoneTimerRef = useRef<any>(null);
  const ringAudioCtxRef = useRef<AudioContext | null>(null);

  const startRingtone = () => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      ringAudioCtxRef.current = ctx;

      const playRing = () => {
        if (!ringAudioCtxRef.current || ringAudioCtxRef.current.state === 'closed') return;

        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();

        osc1.type = 'sine';
        osc2.type = 'sine';
        osc1.frequency.setValueAtTime(400, ctx.currentTime);
        osc2.frequency.setValueAtTime(450, ctx.currentTime);

        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.05);
        gain.gain.setValueAtTime(0.12, ctx.currentTime + 0.95);
        gain.gain.linearRampToValueAtTime(0.001, ctx.currentTime + 1.0);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(ctx.destination);

        osc1.start(ctx.currentTime);
        osc2.start(ctx.currentTime);
        osc1.stop(ctx.currentTime + 1.0);
        osc2.stop(ctx.currentTime + 1.0);
      };

      playRing();
      ringtoneTimerRef.current = setInterval(playRing, 3000);
    } catch {
      // 無視
    }
  };

  const stopRingtone = () => {
    if (ringtoneTimerRef.current) {
      clearInterval(ringtoneTimerRef.current);
      ringtoneTimerRef.current = null;
    }
    if (ringAudioCtxRef.current && ringAudioCtxRef.current.state !== 'closed') {
      ringAudioCtxRef.current.close().catch(() => {});
      ringAudioCtxRef.current = null;
    }
  };

  const speakText = (text: string) => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'ja-JP';
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      window.speechSynthesis.speak(utterance);
    }
  };

  const connectWebSocket = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const ws = new WebSocket('ws://localhost:8080/ws/call');
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
    };

    ws.onclose = () => {
      setIsConnected(false);
      reconnectTimeoutRef.current = setTimeout(connectWebSocket, 1500);
    };

    ws.onerror = () => {
      setIsConnected(false);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'start_call') {
          setCallerIntent(data.intent || '');
          setCallState('ringing');
          startRingtone();
        } else if (data.type === 'answer_call') {
          if (data.text) speakText(data.text);
        } else if (data.type === 'patient_speech') {
          speakText(data.text);
        } else if (data.type === 'call_ending' || data.type === 'end_call') {
          stopRingtone();
          setCallState('ended');
        } else if (data.type === 'reset_call') {
          stopRingtone();
          setCallState('idle');
          setCallerIntent('');
          setIsRecording(false);
        }
      } catch {
        // パースエラー無視
      }
    };
  }, []);

  useEffect(() => {
    connectWebSocket();
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      stopRingtone();
      if (wsRef.current) wsRef.current.close();
    };
  }, [connectWebSocket]);

  const handleAnswerCall = () => {
    stopRingtone();
    setCallState('connected');
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'answer_call' }));
    }
  };

  const handleGlobalReset = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'reset_call' }));
    }
    stopRingtone();
    setCallState('idle');
    setCallerIntent('');
    setIsRecording(false);
  };

  // PTT ボタン押下時（0ミリ秒で即座に信号送信）
  const startRecording = async () => {
    if (isRecording) return;
    setIsRecording(true);

    // ★マイク準備を待たずに即時送信し、患者側のパルスを瞬時に動かす
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'hospital_speaking_start' }));
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const outputData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          outputData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(outputData.buffer);
        }
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
    } catch {
      alert('マイクの使用が許可されていません。');
      setIsRecording(false);
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'hospital_speaking_stop' }));
      }
    }
  };

  // PTT ボタン解除時
  const stopRecording = () => {
    if (!isRecording) return;

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    setIsRecording(false);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'hospital_speech_end' }));
    }
  };

  return (
    <div className="flex h-screen bg-slate-950 items-center justify-center p-4 relative select-none">
      <div className="absolute top-4 right-6 z-50">
        <button
          onClick={handleGlobalReset}
          className="flex items-center gap-1.5 bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 px-3 py-1.5 rounded-full text-xs font-medium shadow-md transition active:scale-95"
          title="両端末を初期待機状態にリセット"
        >
          <RotateCcw className="w-3.5 h-3.5 text-green-400" />
          <span>全体リセット</span>
        </button>
      </div>

      <div className="w-[360px] h-[780px] bg-slate-800 rounded-[3rem] border-[10px] border-slate-700 relative overflow-hidden flex flex-col shadow-2xl">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-6 bg-slate-700 rounded-b-2xl z-10" />

        <header className="pt-10 pb-3 px-5 border-b border-slate-700 flex items-center justify-center gap-2 z-20">
          <span className="text-sm font-bold text-slate-300">ひまわり医院 (受付)</span>
          <span
            className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`}
            title={isConnected ? 'サーバー接続中' : '未接続'}
          />
        </header>

        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center space-y-8">
          {callState === 'idle' && (
            <div className="text-slate-500 text-sm">
              {isConnected ? '着信待機中...' : 'サーバー接続待機中...'}
            </div>
          )}

          {callState === 'ringing' && (
            <div className="space-y-6 animate-pulse">
              <div className="w-24 h-24 bg-green-500/20 rounded-full flex items-center justify-center mx-auto shadow-lg shadow-green-500/20">
                <Phone className="w-10 h-10 text-green-400" />
              </div>
              <div>
                <div className="text-green-400 font-bold text-lg">着信中... 🔔</div>
                {callerIntent && (
                  <div className="text-xs text-slate-200 mt-3 px-4 py-2 bg-slate-700 rounded-xl border border-slate-600">
                    用件: {callerIntent}
                  </div>
                )}
              </div>
              <button
                onClick={handleAnswerCall}
                className="bg-green-500 hover:bg-green-600 text-white px-8 py-3 rounded-full font-bold shadow-lg transition active:scale-95"
              >
                応答する
              </button>
            </div>
          )}

          {callState === 'connected' && (
            <div className="w-full flex flex-col items-center space-y-12">
              <div className="text-green-400 font-bold flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                通話中
              </div>

              <button
                onMouseDown={startRecording}
                onMouseUp={stopRecording}
                onMouseLeave={stopRecording}
                onTouchStart={startRecording}
                onTouchEnd={stopRecording}
                className={`w-36 h-36 rounded-full flex items-center justify-center transition-all ${
                  isRecording ? 'bg-red-500 scale-95 shadow-[0_0_35px_rgba(239,68,68,0.7)]' : 'bg-slate-700 hover:bg-slate-600 shadow-xl'
                }`}
              >
                <Mic className={`w-14 h-14 ${isRecording ? 'text-white' : 'text-slate-300'}`} />
              </button>

              <p className="text-slate-400 text-sm">
                {isRecording ? '録音＆送信中...' : '長押しで発話 (PTT)'}
              </p>
            </div>
          )}

          {callState === 'ended' && (
            <div className="space-y-4">
              <div className="text-slate-400 text-sm">通話が終了しました</div>
              <button
                onClick={handleGlobalReset}
                className="bg-slate-700 hover:bg-slate-600 text-white px-5 py-2 rounded-xl text-xs font-semibold active:scale-95"
              >
                待機画面に戻る
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}