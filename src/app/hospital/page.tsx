"use client";

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Phone, Mic, RotateCcw } from 'lucide-react';
import type { RecordingFailureReason, ServerMessage, SpeechStatus } from '@/lib/callProtocol';

/** 押してから、サーバーの受け付けとマイクの準備がそろうまでは録音中と表示しない。 */
type RecordingPhase = 'idle' | 'awaiting_server' | 'opening_mic' | 'recording';

const RECORDING_FAILURE_LABELS: Record<RecordingFailureReason, string> = {
  start_failed: '録音を開始できませんでした。音声は送られていません。',
  stream_failed: '音声認識が中断しました。もう一度話してください。',
};

function describePtt(
  isConnected: boolean,
  phase: RecordingPhase,
  isPatientSpeaking: boolean,
  speechStatus: SpeechStatus | null,
): string {
  if (!isConnected) return 'サーバーに接続していません';
  if (phase === 'recording') return '録音＆送信中...';
  if (phase !== 'idle') return '録音を準備中... まだ話さないでください';
  if (isPatientSpeaking) return '相手が発話・入力中...';
  if (speechStatus === 'unavailable') return '音声認識を利用できません。長押しで再確認します';
  if (speechStatus !== 'ready') return '音声認識を準備中です。まだ録音できません';
  return '長押しで発話 (PTT)';
}

export default function HospitalApp() {
  const [isConnected, setIsConnected] = useState(false);
  const [callState, setCallState] = useState<'idle' | 'ringing' | 'connected' | 'ended'>('idle');
  const [recordingPhase, setRecordingPhaseState] = useState<RecordingPhase>('idle');
  const [recordingFailure, setRecordingFailure] = useState<RecordingFailureReason | null>(null);
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus | null>(null);
  const [isPatientSpeaking, setIsPatientSpeaking] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  // WebSocketの受信処理からも最新の段階を読めるようにする。
  const recordingPhaseRef = useRef<RecordingPhase>('idle');
  // 開いている途中のマイクが、もう不要になったかを見分ける。
  const captureAttemptRef = useRef(0);

  // 着信音用の管理Ref
  const ringtoneTimerRef = useRef<any>(null);
  const ringAudioCtxRef = useRef<AudioContext | null>(null);
  const activeGainRef = useRef<GainNode | null>(null);

  const speechQueueRef = useRef<string[]>([]);
  const isSpeakingRef = useRef<boolean>(false);

  const processSpeechQueue = useCallback(() => {
    if (isSpeakingRef.current || speechQueueRef.current.length === 0) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    const nextText = speechQueueRef.current.shift();
    if (!nextText) return;

    isSpeakingRef.current = true;
    const utterance = new SpeechSynthesisUtterance(nextText);
    utterance.lang = 'ja-JP';
    utterance.rate = 1.0;

    utterance.onend = () => {
      isSpeakingRef.current = false;
      processSpeechQueue();
    };

    utterance.onerror = () => {
      isSpeakingRef.current = false;
      processSpeechQueue();
    };

    window.speechSynthesis.speak(utterance);
  }, []);

  const queueSpeech = useCallback((text: string) => {
    speechQueueRef.current.push(text);
    processSpeechQueue();
  }, [processSpeechQueue]);

  const clearSpeechQueue = () => {
    speechQueueRef.current = [];
    isSpeakingRef.current = false;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  };

  // 着信音の完全停止処理
  const stopRingtone = useCallback(() => {
    if (ringtoneTimerRef.current) {
      clearInterval(ringtoneTimerRef.current);
      ringtoneTimerRef.current = null;
    }
    if (activeGainRef.current) {
      try {
        activeGainRef.current.gain.setValueAtTime(0, 0);
      } catch {}
      activeGainRef.current = null;
    }
    if (ringAudioCtxRef.current) {
      try {
        if (ringAudioCtxRef.current.state !== 'closed') {
          ringAudioCtxRef.current.close().catch(() => {});
        }
      } catch {}
      ringAudioCtxRef.current = null;
    }
  }, []);

  // 着信音の開始処理（既存の音を止めてから鳴らす）
  const startRingtone = useCallback(() => {
    stopRingtone(); // 二重再生を完全防止

    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx();
      ringAudioCtxRef.current = ctx;

      const playRing = () => {
        if (!ringAudioCtxRef.current || ringAudioCtxRef.current.state === 'closed') return;

        try {
          const osc1 = ctx.createOscillator();
          const osc2 = ctx.createOscillator();
          const gain = ctx.createGain();
          activeGainRef.current = gain;

          osc1.type = 'sine';
          osc2.type = 'sine';
          osc1.frequency.setValueAtTime(400, ctx.currentTime);
          osc2.frequency.setValueAtTime(450, ctx.currentTime);

          gain.gain.setValueAtTime(0, ctx.currentTime);
          gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.05);
          gain.gain.setValueAtTime(0.12, ctx.currentTime + 0.95);
          gain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 1.0);

          osc1.connect(gain);
          osc2.connect(gain);
          gain.connect(ctx.destination);

          osc1.start(ctx.currentTime);
          osc2.start(ctx.currentTime);
          osc1.stop(ctx.currentTime + 1.0);
          osc2.stop(ctx.currentTime + 1.0);
        } catch {}
      };

      playRing();
      ringtoneTimerRef.current = setInterval(playRing, 3000);
    } catch {}
  }, [stopRingtone]);

  const setRecordingPhase = useCallback((phase: RecordingPhase) => {
    recordingPhaseRef.current = phase;
    setRecordingPhaseState(phase);
  }, []);

  const sendControl = useCallback((message: { type: string }) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  const releaseMic = useCallback(() => {
    captureAttemptRef.current += 1;

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

    setRecordingPhase('idle');
  }, [setRecordingPhase]);

  const beginCapture = useCallback(async () => {
    captureAttemptRef.current += 1;
    const attempt = captureAttemptRef.current;
    setRecordingPhase('opening_mic');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (attempt !== captureAttemptRef.current) {
        // 待っている間に指を離したか、サーバーが録音を止めた。
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      mediaStreamRef.current = stream;

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const audioContext = new AudioCtx({ sampleRate: 16000 });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (typeof window !== 'undefined' && window.speechSynthesis && window.speechSynthesis.speaking) {
          return;
        }

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
      setRecordingPhase('recording');
    } catch {
      if (attempt !== captureAttemptRef.current) return;
      alert('マイクの使用が許可されていません。');
      releaseMic();
      sendControl({ type: 'hospital_speaking_stop' });
    }
  }, [releaseMic, sendControl, setRecordingPhase]);

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
      setSpeechStatus(null);
      if (recordingPhaseRef.current !== 'idle') {
        setRecordingFailure('stream_failed');
        releaseMic();
      }
      reconnectTimeoutRef.current = setTimeout(connectWebSocket, 1500);
    };

    ws.onerror = () => {
      setIsConnected(false);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as ServerMessage;
        if (data.type === 'speech_status') {
          setSpeechStatus(data.status);
        } else if (data.type === 'hospital_speaking_start') {
          if (recordingPhaseRef.current === 'awaiting_server') beginCapture();
        } else if (data.type === 'hospital_recording_failed') {
          setRecordingFailure(data.reason);
          releaseMic();
        } else if (data.type === 'start_call') {
          setRecordingFailure(null);
          setCallState('ringing');
          startRingtone();
        } else if (data.type === 'answer_call') {
          stopRingtone(); // 念のため応答メッセージ受信時にも確実に停止
          if (data.text) queueSpeech(data.text);
        } else if (data.type === 'patient_typing_notice') {
          if (data.text) queueSpeech(data.text);
        } else if (data.type === 'patient_speech') {
          if (data.text) queueSpeech(data.text);
        } else if (data.type === 'patient_speaking_status') {
          setIsPatientSpeaking(data.isSpeaking);
        } else if (data.type === 'call_ending' || data.type === 'end_call') {
          stopRingtone();
          clearSpeechQueue();
          releaseMic();
          setCallState('ended');
        } else if (data.type === 'reset_call') {
          stopRingtone();
          clearSpeechQueue();
          releaseMic();
          setRecordingFailure(null);
          setCallState('idle');
          setIsPatientSpeaking(false);
        }
      } catch {}
    };
  }, [beginCapture, queueSpeech, releaseMic, startRingtone, stopRingtone]);

  useEffect(() => {
    connectWebSocket();
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      stopRingtone();
      clearSpeechQueue();
      releaseMic();
      if (wsRef.current) wsRef.current.close();
    };
  }, [connectWebSocket, releaseMic, stopRingtone]);

  const handleAnswerCall = () => {
    stopRingtone(); // ボタン押下時に即時停止
    setCallState('connected');
    sendControl({ type: 'answer_call' });
  };

  const handleGlobalReset = () => {
    stopRingtone();
    clearSpeechQueue();
    releaseMic();
    setRecordingFailure(null);
    sendControl({ type: 'reset_call' });
    setCallState('idle');
    setIsPatientSpeaking(false);
  };

  // 切断中は speechStatus が null になる。unavailable で押すと、サーバーが認証を確認し直す。
  const canStartRecording =
    !isPatientSpeaking && (speechStatus === 'ready' || speechStatus === 'unavailable');
  const isPreparing = recordingPhase === 'awaiting_server' || recordingPhase === 'opening_mic';
  const isRecording = recordingPhase === 'recording';

  // マイクを開くのはサーバーが受け付けた後。使えないときに許可を求めず、音声も送らない。
  const startRecording = () => {
    if (recordingPhase !== 'idle' || !canStartRecording || isSpeakingRef.current) return;
    setRecordingFailure(null);
    setRecordingPhase('awaiting_server');
    sendControl({ type: 'hospital_speaking_start' });
  };

  const stopRecording = () => {
    if (recordingPhase === 'idle') return;
    releaseMic();
    sendControl({ type: 'hospital_speech_end' });
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
              <div className="text-green-400 font-bold text-lg">着信中... 🔔</div>
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
                disabled={recordingPhase === 'idle' && !canStartRecording}
                aria-label="長押しで発話"
                className={`w-36 h-36 rounded-full flex items-center justify-center transition-all ${
                  isRecording 
                    ? 'bg-red-500 scale-95 shadow-[0_0_35px_rgba(239,68,68,0.7)]' 
                    : isPreparing
                    ? 'bg-amber-600/70 scale-95'
                    : !canStartRecording
                    ? 'bg-slate-700/50 opacity-40 cursor-not-allowed'
                    : 'bg-slate-700 hover:bg-slate-600 shadow-xl'
                }`}
              >
                <Mic className={`w-14 h-14 ${isRecording ? 'text-white' : 'text-slate-300'}`} />
              </button>

              <div className="space-y-2">
                <p
                  role="status"
                  className={`text-sm ${speechStatus === 'unavailable' ? 'text-amber-300' : 'text-slate-400'}`}
                >
                  {describePtt(isConnected, recordingPhase, isPatientSpeaking, speechStatus)}
                </p>
                {recordingFailure && (
                  <p role="alert" className="text-sm font-semibold text-red-300">
                    {RECORDING_FAILURE_LABELS[recordingFailure]}
                  </p>
                )}
              </div>
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