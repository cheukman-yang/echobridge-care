"use client";

import React, { useState, useRef, useEffect, useEffectEvent, useCallback } from 'react';
import { Phone, PhoneOff, Mic } from 'lucide-react';
import { CallNotice } from '@/components/AiStatusBadge';
import { useCallChannel, useCallSocket } from '@/hooks/useCallChannel';
import {
  CALL_CLOSED_NOTICES,
  CALL_ERROR_NOTICES,
  RECONNECTING_NOTICE,
  SEAT_TAKEN_NOTICE,
} from '@/lib/callNotices';
import { normalizeInviteCode, parseInviteFromHash } from '@/lib/callProtocol';
import type {
  CallPhase,
  CallSnapshot,
  ClientMessage,
  RecordingFailureReason,
  ServerMessage,
  SpeechStatus,
} from '@/lib/callProtocol';
import { loadSpokenSeq, saveSpokenSeq } from '@/lib/callSession';

/** 押してから、サーバーの受け付けとマイクの準備がそろうまでは録音中と表示しない。 */
type RecordingPhase = 'idle' | 'awaiting_server' | 'opening_mic' | 'recording';

type HospitalCallState = 'idle' | 'ringing' | 'connected' | 'ended';

const PHASE_TO_CALL_STATE: Record<CallPhase, HospitalCallState> = {
  ringing: 'ringing',
  connected: 'connected',
  ending: 'ended',
  ended: 'ended',
};

const PATIENT_DISCONNECTED_NOTICE = '相手の接続が切れています。';

interface QueuedSpeech {
  text: string;
  /** 通話の記録にある発言の番号。自動案内にはない。 */
  seq?: number;
}

/** リンクで開いた招待コードを取り出し、アドレスバーと履歴からは消す。 */
function takeInviteFromUrl(): string | null {
  const code = parseInviteFromHash(window.location.hash);
  if (code) window.history.replaceState(null, '', window.location.pathname);
  return code;
}

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
  const [callState, setCallState] = useState<HospitalCallState>('idle');
  const [recordingPhase, setRecordingPhaseState] = useState<RecordingPhase>('idle');
  const [recordingFailure, setRecordingFailure] = useState<RecordingFailureReason | null>(null);
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus | null>(null);
  const [isPatientSpeaking, setIsPatientSpeaking] = useState(false);
  const [peerConnected, setPeerConnected] = useState(true);
  const [inviteInput, setInviteInput] = useState('');
  const [callNotice, setCallNotice] = useState<string | null>(null);
  // 再読み込みの後は、操作があるまでブラウザが読み上げを止める。
  const [needsAudioResume, setNeedsAudioResume] = useState(false);

  const channel = useCallChannel('hospital');

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

  const speechQueueRef = useRef<QueuedSpeech[]>([]);
  const isSpeakingRef = useRef<boolean>(false);
  // 再接続で同じ発言を二度読まないよう、並べた最後の番号を覚える。
  const lastQueuedSeqRef = useRef(0);
  const isAudioBlockedRef = useRef(false);
  // 操作があったページでは、再接続しても読み上げを続けられる。
  const hasUserGestureRef = useRef(false);
  const pendingInviteRef = useRef<string | null>(null);

  const markSpoken = useCallback((seq: number | undefined) => {
    const seatToken = channel.seatTokenRef.current;
    if (seq !== undefined && seatToken) saveSpokenSeq(seatToken, seq);
  }, [channel]);

  const processSpeechQueue = useCallback(function processNext() {
    if (isSpeakingRef.current || isAudioBlockedRef.current || speechQueueRef.current.length === 0) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    const next = speechQueueRef.current.shift();
    if (!next) return;

    isSpeakingRef.current = true;
    const utterance = new SpeechSynthesisUtterance(next.text);
    utterance.lang = 'ja-JP';
    utterance.rate = 1.0;

    const finish = () => {
      isSpeakingRef.current = false;
      markSpoken(next.seq);
      processNext();
    };
    utterance.onend = finish;
    utterance.onerror = finish;

    window.speechSynthesis.speak(utterance);
  }, [markSpoken]);

  const queueSpeech = useCallback((text: string, seq?: number) => {
    if (seq !== undefined) {
      if (seq <= lastQueuedSeqRef.current) return;
      lastQueuedSeqRef.current = seq;
    }
    speechQueueRef.current.push({ text, seq });
    processSpeechQueue();
  }, [processSpeechQueue]);

  const clearSpeechQueue = useCallback(() => {
    speechQueueRef.current = [];
    isSpeakingRef.current = false;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

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

        channel.sendAudio(outputData.buffer);
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      setRecordingPhase('recording');
    } catch {
      if (attempt !== captureAttemptRef.current) return;
      alert('マイクの使用が許可されていません。');
      releaseMic();
      channel.send({ type: 'hospital_speaking_stop' });
    }
  }, [channel, releaseMic, setRecordingPhase]);

  /** 通話の音と録音を止める。画面の状態はそのまま。 */
  const stopCallMedia = useCallback(() => {
    stopRingtone();
    clearSpeechQueue();
    releaseMic();
  }, [clearSpeechQueue, releaseMic, stopRingtone]);

  /** 通話から離れ、コードの入力画面へ戻す。 */
  const returnToLobby = useCallback(() => {
    stopCallMedia();
    setRecordingFailure(null);
    setCallState('idle');
    setIsPatientSpeaking(false);
    setNeedsAudioResume(false);
    isAudioBlockedRef.current = false;
    lastQueuedSeqRef.current = 0;
  }, [stopCallMedia]);

  /** サーバーの状態に画面を合わせる。切断中に送られた文は、ここから読み上げる。 */
  const applySnapshot = useCallback((snapshot: CallSnapshot, seatToken: string) => {
    const nextState = PHASE_TO_CALL_STATE[snapshot.phase];
    setCallState(nextState);
    setIsPatientSpeaking(snapshot.isPatientSpeaking);
    setPeerConnected(snapshot.peerConnected);
    setCallNotice(null);

    if (nextState === 'ringing') {
      startRingtone();
      return;
    }
    stopRingtone();
    if (nextState !== 'connected') return;

    if (!hasUserGestureRef.current) {
      isAudioBlockedRef.current = true;
      setNeedsAudioResume(true);
    }
    lastQueuedSeqRef.current = Math.max(lastQueuedSeqRef.current, loadSpokenSeq(seatToken));
    snapshot.turns
      .filter((turn) => turn.sender === '患者')
      .forEach((turn) => queueSpeech(turn.text, turn.seq));
  }, [queueSpeech, startRingtone, stopRingtone]);

  const handleServerMessage = useCallback((data: ServerMessage) => {
    if (data.type === 'speech_status') {
      setSpeechStatus(data.status);
    } else if (data.type === 'call_joined') {
      applySnapshot(data.snapshot, data.seatToken);
    } else if (data.type === 'call_error') {
      const notice = CALL_ERROR_NOTICES[data.code];
      if (data.code === 'call_not_found') returnToLobby();
      if (notice) setCallNotice(notice);
    } else if (data.type === 'call_closed') {
      returnToLobby();
      // 終了後の保存期限は患者の結果の話なので、病院役には知らせない。
      if (data.reason !== 'retention_expired') setCallNotice(CALL_CLOSED_NOTICES[data.reason]);
    } else if (data.type === 'peer_status') {
      setPeerConnected(data.connected);
    } else if (data.type === 'hospital_speaking_start') {
      if (recordingPhaseRef.current === 'awaiting_server') beginCapture();
    } else if (data.type === 'hospital_recording_failed') {
      setRecordingFailure(data.reason);
      releaseMic();
    } else if (data.type === 'answer_call') {
      stopRingtone(); // 念のため応答メッセージ受信時にも確実に停止
      setCallState('connected');
      queueSpeech(data.text, data.seq);
    } else if (data.type === 'patient_typing_notice') {
      queueSpeech(data.text);
    } else if (data.type === 'patient_speech') {
      queueSpeech(data.text, data.seq);
    } else if (data.type === 'patient_speaking_status') {
      setIsPatientSpeaking(data.isSpeaking);
    } else if (data.type === 'call_ending') {
      stopCallMedia();
      setCallState('ended');
    }
  }, [applySnapshot, beginCapture, queueSpeech, releaseMic, returnToLobby, stopCallMedia, stopRingtone]);

  const isConnected = useCallSocket(channel, {
    onMessage: handleServerMessage,
    onDisconnected: () => {
      setSpeechStatus(null);
      if (recordingPhaseRef.current !== 'idle') {
        setRecordingFailure('stream_failed');
        releaseMic();
      }
    },
    onSeatTaken: () => {
      returnToLobby();
      setCallNotice(SEAT_TAKEN_NOTICE);
    },
    chooseJoin: (seatToken): ClientMessage | null => {
      // リンクを開いたのは本人の操作なので、前の通話に戻るより優先する。
      const inviteCode = pendingInviteRef.current ?? takeInviteFromUrl();
      pendingInviteRef.current = null;
      if (inviteCode) return { type: 'join_call', inviteCode };
      return seatToken ? { type: 'join_call', seatToken } : null;
    },
  });

  const joinWithInvite = useEffectEvent((inviteCode: string) => {
    if (callState === 'ringing' || callState === 'connected') {
      setCallNotice('通話中は別の通話に参加できません。');
      return;
    }
    if (callState === 'ended') {
      channel.send({ type: 'leave_call' });
      channel.forgetSeat();
      returnToLobby();
    }
    setCallNotice(null);
    // 切断中ならフラグメントはもう消えているので、つながったときに使えるよう覚えておく。
    if (!channel.send({ type: 'join_call', inviteCode })) pendingInviteRef.current = inviteCode;
  });

  // 開いているタブに別の招待リンクを貼ると、再読み込みせずフラグメントだけが変わる。
  useEffect(() => {
    const onHashChange = () => {
      const inviteCode = takeInviteFromUrl();
      if (inviteCode) joinWithInvite(inviteCode);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => stopCallMedia, [stopCallMedia]);

  const handleJoinByCode = (event: React.FormEvent) => {
    event.preventDefault();
    const inviteCode = normalizeInviteCode(inviteInput);
    if (!inviteCode) return;
    hasUserGestureRef.current = true;
    setCallNotice(null);
    if (channel.send({ type: 'join_call', inviteCode })) {
      setInviteInput('');
    }
  };

  const handleAnswerCall = () => {
    hasUserGestureRef.current = true;
    // 切断中に押しても応答にはならない。再接続の帯が出ているので、着信の画面に留める。
    if (!channel.send({ type: 'answer_call' })) return;
    stopRingtone(); // ボタン押下時に即時停止
    setCallState('connected');
  };

  /** 操作があるまで止まっていた読み上げを再開する。 */
  const handleResumeAudio = () => {
    hasUserGestureRef.current = true;
    isAudioBlockedRef.current = false;
    setNeedsAudioResume(false);
    processSpeechQueue();
  };

  const handleHangUp = () => {
    // 切断中は送れない。再接続の帯が出ているので、画面はそのままにする。
    if (!channel.send({ type: 'end_call' })) return;
    stopCallMedia();
    setCallState('ended');
  };

  /** この通話の席を手放す。患者の画面や通話の記録は消さない。 */
  const handleLeaveCall = () => {
    channel.send({ type: 'leave_call' });
    channel.forgetSeat();
    setCallNotice(null);
    returnToLobby();
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
    if (!channel.send({ type: 'hospital_speaking_start' })) setRecordingPhase('idle');
  };

  const stopRecording = () => {
    if (recordingPhase === 'idle') return;
    releaseMic();
    channel.send({ type: 'hospital_speech_end' });
  };

  const connectionNotice = !isConnected && callState !== 'idle'
    ? RECONNECTING_NOTICE
    : callState === 'connected' && !peerConnected
    ? PATIENT_DISCONNECTED_NOTICE
    : null;

  return (
    <div className="flex h-screen bg-slate-950 items-center justify-center p-4 relative select-none">
      <div className="w-[360px] h-[780px] bg-slate-800 rounded-[3rem] border-[10px] border-slate-700 relative overflow-hidden flex flex-col shadow-2xl">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-6 bg-slate-700 rounded-b-2xl z-10" />

        <header className="pt-10 pb-3 px-5 border-b border-slate-700 flex items-center justify-center gap-2 z-20">
          <span className="text-sm font-bold text-slate-300">ひまわり医院 (受付)</span>
          <span
            className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`}
            title={isConnected ? 'サーバー接続中' : '未接続'}
          />
        </header>

        <CallNotice text={connectionNotice ?? callNotice} />

        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center space-y-8">
          {callState === 'idle' && (
            <form onSubmit={handleJoinByCode} className="w-full space-y-3 select-text">
              <div className="space-y-1">
                <h2 className="text-base font-bold text-white">通話コードを入力</h2>
                <p className="text-xs text-slate-400">
                  患者側に表示されたコードを入力するか、招待リンクを開いてください
                </p>
              </div>
              <input
                type="text"
                aria-label="通話コード"
                value={inviteInput}
                onChange={(event) => setInviteInput(event.target.value)}
                placeholder="XXXXX-XXXXX"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={32}
                className="w-full bg-slate-900 border border-slate-600 rounded-xl px-3 py-2.5 text-center font-mono text-base tracking-widest text-white focus:outline-none focus:border-green-500"
              />
              <button
                type="submit"
                disabled={!isConnected || !inviteInput.trim()}
                className="w-full bg-green-600 hover:bg-green-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-bold py-2.5 rounded-xl transition active:scale-[0.98]"
              >
                {isConnected ? '通話に参加する' : 'サーバー接続待機中...'}
              </button>
            </form>
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
              <button
                type="button"
                onClick={handleLeaveCall}
                className="block mx-auto text-xs text-slate-300 underline px-2 py-1"
              >
                応答しない
              </button>
            </div>
          )}

          {callState === 'connected' && needsAudioResume && (
            <div className="space-y-4">
              <p className="text-sm text-slate-300">読み上げを再開するにはボタンを押してください</p>
              <button
                type="button"
                onClick={handleResumeAudio}
                className="bg-green-500 hover:bg-green-600 text-white px-8 py-3 rounded-full font-bold shadow-lg transition active:scale-95"
              >
                通話に戻る
              </button>
            </div>
          )}

          {callState === 'connected' && !needsAudioResume && (
            <div className="w-full flex flex-col items-center space-y-10">
              <div className="w-full flex items-center justify-between">
                <div className="text-green-400 font-bold flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                  通話中
                </div>
                <button
                  type="button"
                  onClick={handleHangUp}
                  className="flex items-center gap-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/40 px-3 py-1 rounded-full text-xs font-bold transition active:scale-95"
                >
                  <PhoneOff className="w-3.5 h-3.5" />
                  <span>通話を切る</span>
                </button>
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
                onClick={handleLeaveCall}
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