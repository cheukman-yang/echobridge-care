"use client";

import React, { useState, useRef, useEffect, useEffectEvent, useCallback } from 'react';
import { Mic, Phone, PhoneOff } from 'lucide-react';
import { CallNotice } from '@/components/AiStatusBadge';
import { DemoDataNotice } from '@/components/DemoDataNotice';
import { AppHeader, CallStatus } from '@/components/AppHeader';
import type { CallStatusTone } from '@/components/AppHeader';
import { buttonClass, cx } from '@/components/ui';
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
  CallTurn,
  ClientMessage,
  PlaybackStatus,
  RecordingFailureReason,
  ServerMessage,
  SpeechStatus,
} from '@/lib/callProtocol';
import { CALL_PURPOSE_PROFILES, DEFAULT_CALL_PURPOSE } from '@/lib/callPurpose';
import type { CallPurpose } from '@/lib/callPurpose';
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

/**
 * 読み上げが終わった合図が来ないときに、次へ進むまでの上限。
 * ブラウザによっては長い文の途中で読み上げが止まり、終わりの合図が来ない。待ち続けると録音もできなくなる。
 */
function readingWatchdogMs(text: string): number {
  return Math.max(8_000, text.length * 300 + 4_000);
}

/** 時間切れで読み上げを止めた後、次の文を読むまでの間。止める処理に次の文が巻き込まれないようにする。 */
const RESUME_AFTER_CANCEL_MS = 300;

/** これより短く押したら「押して開始・もう一度押して終了」、長く押したら離したときに終える。 */
const HOLD_THRESHOLD_MS = 400;

/** 押して開始したまま止め忘れたときに、録音を終える上限。 */
const MAX_LATCHED_RECORDING_MS = 60_000;

/** 押す・離す・キーの操作の直後に届くクリックは、同じ操作として扱い、二重に処理しない。 */
const CLICK_AFTER_GESTURE_MS = 700;

/** 録音の操作欄に出す、認識途中の文の長さ。全文は字幕に出す。 */
const LIVE_TAIL_LENGTH = 36;

interface QueuedSpeech {
  text: string;
  /** 通話の記録にある発言の番号。自動案内にはない。 */
  seq?: number;
}

/** 相手の画面の字幕の1行。この画面から見て、EchoBridgeを使う人が「相手」。 */
interface CaptionLine {
  id: string;
  who: 'caller' | 'me' | 'notice';
  text: string;
  seq?: number;
}

function turnToCaption(turn: CallTurn): CaptionLine {
  return {
    id: String(turn.seq),
    who: turn.sender === '患者' ? 'caller' : 'me',
    text: turn.text,
    seq: turn.seq,
  };
}

type AudioContextWindow = typeof window & { webkitAudioContext?: typeof AudioContext };

function createAudioContext(options?: AudioContextOptions): AudioContext {
  const AudioCtx = window.AudioContext || (window as AudioContextWindow).webkitAudioContext;
  return new AudioCtx(options);
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
  isLatched: boolean,
  isReadingAloud: boolean,
  isPatientSpeaking: boolean,
  speechStatus: SpeechStatus | null,
): string {
  if (!isConnected) return 'サーバーに接続していません';
  if (phase === 'recording') {
    return isLatched
      ? '録音中です。話し終えたら、もう一度押してください'
      : '録音中です。話し終えたら離してください';
  }
  if (phase !== 'idle') return '録音を準備しています。まだ話さないでください';
  if (isReadingAloud) return '相手の文を読み上げています。終わってから話してください';
  if (isPatientSpeaking) return '相手が入力中です。少しお待ちください';
  if (speechStatus === 'unavailable') return '音声認識を利用できません。押すと再確認します';
  if (speechStatus !== 'ready') return '音声認識を準備しています。まだ録音できません';
  return '押すと録音を始めます';
}

function describeStatus(
  callState: HospitalCallState,
  isConnected: boolean,
  peerConnected: boolean,
): { tone: CallStatusTone; label: string } {
  if (!isConnected) return { tone: 'warning', label: '再接続中' };
  if (callState === 'ringing') return { tone: 'waiting', label: '着信中' };
  if (callState === 'connected') {
    return peerConnected ? { tone: 'live', label: '通話中' } : { tone: 'warning', label: '相手の接続待ち' };
  }
  if (callState === 'ended') return { tone: 'ended', label: '通話終了' };
  return { tone: 'idle', label: '参加前' };
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
  const [purpose, setPurpose] = useState<CallPurpose>(DEFAULT_CALL_PURPOSE);
  const [partnerName, setPartnerName] = useState('');
  const [captions, setCaptions] = useState<CaptionLine[]>([]);
  const [liveText, setLiveText] = useState('');
  // 今読み上げている発言。字幕で強調し、その間は録音を始めない。
  const [readingSeq, setReadingSeq] = useState<number | null>(null);
  const [isReadingAloud, setIsReadingAloud] = useState(false);
  // 押して開始した録音（もう一度押すまで続く）か。
  const [isLatched, setIsLatched] = useState(false);

  const channel = useCallChannel('hospital');

  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  // WebSocketの受信処理からも最新の段階を読めるようにする。
  const recordingPhaseRef = useRef<RecordingPhase>('idle');
  // 開いている途中のマイクが、もう不要になったかを見分ける。
  const captureAttemptRef = useRef(0);

  // 着信音用の管理Ref
  const ringtoneTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ringAudioCtxRef = useRef<AudioContext | null>(null);
  const activeGainRef = useRef<GainNode | null>(null);

  const speechQueueRef = useRef<QueuedSpeech[]>([]);
  const isSpeakingRef = useRef<boolean>(false);
  const readingWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 録音ボタンの操作の状態。押している途中か、押して開始した録音か、直前の操作の時刻。
  const holdRef = useRef<'none' | 'pointer' | 'key'>('none');
  const pressStartedAtRef = useRef(0);
  const lastGestureAtRef = useRef(0);
  const latchedRef = useRef(false);
  const latchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 再接続で同じ発言を二度読まないよう、並べた最後の番号を覚える。
  const lastQueuedSeqRef = useRef(0);
  const isAudioBlockedRef = useRef(false);
  // 操作があったページでは、再接続しても読み上げを続けられる。
  const hasUserGestureRef = useRef(false);
  const pendingInviteRef = useRef<string | null>(null);
  const captionsEndRef = useRef<HTMLDivElement>(null);
  const localIdRef = useRef(0);

  const markSpoken = useCallback((seq: number | undefined) => {
    const seatToken = channel.seatTokenRef.current;
    if (seq !== undefined && seatToken) saveSpokenSeq(seatToken, seq);
  }, [channel]);

  /** 読み上げの結果を本人の画面に知らせる。自動案内には番号がないので知らせない。 */
  const reportPlayback = useCallback((seq: number | undefined, status: PlaybackStatus) => {
    if (seq !== undefined) channel.send({ type: 'speech_playback', seq, status });
  }, [channel]);

  const setReading = useCallback((reading: boolean, seq: number | null) => {
    isSpeakingRef.current = reading;
    setIsReadingAloud(reading);
    setReadingSeq(seq);
  }, []);

  const clearReadingWatchdog = useCallback(() => {
    if (readingWatchdogRef.current) {
      clearTimeout(readingWatchdogRef.current);
      readingWatchdogRef.current = null;
    }
  }, []);

  const processSpeechQueue = useCallback(function processNext() {
    if (isSpeakingRef.current || isAudioBlockedRef.current || speechQueueRef.current.length === 0) return;
    // 録音中は読み上げない。声が重なるうえ、読み上げ中の音声は送らないので、話した内容が欠ける。
    if (recordingPhaseRef.current !== 'idle' || resumeTimerRef.current) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    const next = speechQueueRef.current.shift();
    if (!next) return;

    setReading(true, next.seq ?? null);
    const utterance = new SpeechSynthesisUtterance(next.text);
    utterance.lang = 'ja-JP';
    utterance.rate = 1.0;

    let finished = false;
    const finish = (status: PlaybackStatus | null) => {
      if (finished) return;
      finished = true;
      clearReadingWatchdog();
      setReading(false, null);
      markSpoken(next.seq);
      if (status) reportPlayback(next.seq, status);
      processNext();
    };
    utterance.onstart = () => {
      if (!finished) reportPlayback(next.seq, 'started');
    };
    utterance.onend = () => finish('ended');
    utterance.onerror = () => finish('failed');
    // 終わりの合図が来ないときは、読み上げを実際に止めてから先へ進む。
    // 止めないとブラウザは読み上げ中のままで、次の文が始まらず、録音の音声も捨てられる。
    // 聞けたかどうかは分からないので、結果は知らせない。止めたことで届く合図は、finished で無視する。
    clearReadingWatchdog();
    readingWatchdogRef.current = setTimeout(() => {
      if (finished) return;
      finished = true;
      readingWatchdogRef.current = null;
      window.speechSynthesis.cancel();
      setReading(false, null);
      markSpoken(next.seq);
      resumeTimerRef.current = setTimeout(() => {
        resumeTimerRef.current = null;
        processNext();
      }, RESUME_AFTER_CANCEL_MS);
    }, readingWatchdogMs(next.text));

    window.speechSynthesis.speak(utterance);
  }, [clearReadingWatchdog, markSpoken, reportPlayback, setReading]);

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
    clearReadingWatchdog();
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
    setReading(false, null);
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, [clearReadingWatchdog, setReading]);

  /** 字幕に1行足す。同じ番号の発言は二重に並べない。 */
  const addCaption = useCallback((line: Omit<CaptionLine, 'id'> & { id?: string }) => {
    setCaptions((prev) => {
      if (line.seq !== undefined && prev.some((existing) => existing.seq === line.seq)) return prev;
      localIdRef.current += 1;
      return [...prev, { id: line.id ?? `local-${localIdRef.current}`, ...line }];
    });
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
      const ctx = createAudioContext();
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
    holdRef.current = 'none';
    latchedRef.current = false;
    setIsLatched(false);
    if (latchTimerRef.current) {
      clearTimeout(latchTimerRef.current);
      latchTimerRef.current = null;
    }
    // 録音中に届いて待たせていた文を読む。
    processSpeechQueue();
  }, [processSpeechQueue, setRecordingPhase]);

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

      const audioContext = createAudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        // この画面が読み上げている間は送らない。ブラウザの speaking は止まった後も残ることがあるので使わない。
        if (isSpeakingRef.current) return;

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
    setCaptions([]);
    setLiveText('');
    setPartnerName('');
    setPurpose(DEFAULT_CALL_PURPOSE);
    isAudioBlockedRef.current = false;
    lastQueuedSeqRef.current = 0;
  }, [stopCallMedia]);

  /** サーバーの状態に画面を合わせる。切断中に送られた文は、ここから読み上げる。 */
  const applySnapshot = useCallback((snapshot: CallSnapshot, seatToken: string) => {
    const nextState = PHASE_TO_CALL_STATE[snapshot.phase];
    setCallState(nextState);
    setIsPatientSpeaking(snapshot.isPatientSpeaking);
    setPeerConnected(snapshot.peerConnected);
    setPurpose(snapshot.purpose);
    setPartnerName(snapshot.partnerName);
    setCaptions(snapshot.turns.map(turnToCaption));
    setLiveText('');
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
      setLiveText('');
      if (recordingPhaseRef.current === 'awaiting_server') beginCapture();
    } else if (data.type === 'transcript_interim') {
      setLiveText(data.text);
    } else if (data.type === 'hospital_speaking_stop') {
      setLiveText('');
    } else if (data.type === 'transcript_final') {
      setLiveText('');
      addCaption({ id: String(data.seq), who: 'me', text: data.text, seq: data.seq });
    } else if (data.type === 'hospital_recording_failed') {
      setRecordingFailure(data.reason);
      releaseMic();
    } else if (data.type === 'answer_call') {
      stopRingtone(); // 念のため応答メッセージ受信時にも確実に停止
      setCallState('connected');
      addCaption({ id: String(data.seq), who: 'caller', text: data.text, seq: data.seq });
      queueSpeech(data.text, data.seq);
    } else if (data.type === 'patient_typing_notice') {
      addCaption({ who: 'notice', text: data.text });
      queueSpeech(data.text);
    } else if (data.type === 'patient_speech') {
      addCaption({ id: String(data.seq), who: 'caller', text: data.text, seq: data.seq });
      queueSpeech(data.text, data.seq);
    } else if (data.type === 'patient_speaking_status') {
      setIsPatientSpeaking(data.isSpeaking);
    } else if (data.type === 'call_ending') {
      stopCallMedia();
      setCallState('ended');
    }
  }, [addCaption, applySnapshot, beginCapture, queueSpeech, releaseMic, returnToLobby, stopCallMedia, stopRingtone]);

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

  useEffect(() => {
    captionsEndRef.current?.scrollIntoView?.({ block: 'end' });
  }, [captions.length, liveText]);

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
    !isPatientSpeaking &&
    !isReadingAloud &&
    (speechStatus === 'ready' || speechStatus === 'unavailable');
  const isPreparing = recordingPhase === 'awaiting_server' || recordingPhase === 'opening_mic';
  const isRecording = recordingPhase === 'recording';

  // マイクを開くのはサーバーが受け付けた後。使えないときに許可を求めず、音声も送らない。
  const startRecording = (): boolean => {
    if (recordingPhaseRef.current !== 'idle' || !canStartRecording || isSpeakingRef.current) return false;
    setRecordingFailure(null);
    setRecordingPhase('awaiting_server');
    if (!channel.send({ type: 'hospital_speaking_start' })) {
      setRecordingPhase('idle');
      return false;
    }
    return true;
  };

  // 終える合図は1回の操作で何度も届くことがある（離す・捕捉の解除・クリック）。2回目は何もしない。
  const stopRecording = () => {
    if (recordingPhaseRef.current === 'idle') return;
    releaseMic();
    channel.send({ type: 'hospital_speech_end' });
  };

  /** 押して開始した録音にする。止め忘れても上限の時間で終える。 */
  const latchRecording = () => {
    latchedRef.current = true;
    setIsLatched(true);
    if (latchTimerRef.current) clearTimeout(latchTimerRef.current);
    latchTimerRef.current = setTimeout(stopRecording, MAX_LATCHED_RECORDING_MS);
  };

  /** 押す操作の始まり。録音中なら「もう一度押した」ので終える。 */
  const beginPress = (source: 'pointer' | 'key'): boolean => {
    lastGestureAtRef.current = Date.now();
    if (recordingPhaseRef.current !== 'idle') {
      if (holdRef.current === 'none') stopRecording();
      return false;
    }
    if (!startRecording()) return false;
    holdRef.current = source;
    pressStartedAtRef.current = Date.now();
    return true;
  };

  /** 押す操作の終わり。長く押していたら終え、短ければ押して開始した録音として続ける。 */
  const endPress = (source: 'pointer' | 'key') => {
    lastGestureAtRef.current = Date.now();
    if (holdRef.current !== source) return;
    holdRef.current = 'none';
    if (recordingPhaseRef.current === 'idle') return;
    if (Date.now() - pressStartedAtRef.current >= HOLD_THRESHOLD_MS) stopRecording();
    else latchRecording();
  };

  const onPttPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!beginPress('pointer')) return;
    // 指がボタンの外へずれても、離すまで録音を続ける。捕捉できない環境でも録音は止めない。
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {}
  };

  const onPttKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    if (!event.repeat) beginPress('key');
  };

  const onPttKeyUp = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    endPress('key');
  };

  /**
   * 押す・離すを伴わないクリック（読み上げソフトや音声操作、スイッチ操作など）。
   * 押して開始し、もう一度押して終える。
   */
  const onPttClick = () => {
    if (Date.now() - lastGestureAtRef.current < CLICK_AFTER_GESTURE_MS) return;
    if (recordingPhaseRef.current === 'idle') {
      if (startRecording()) latchRecording();
    } else {
      stopRecording();
    }
  };

  // キーを押したままフォーカスが外れると、離した合図が届かない。押して開始した録音は続ける。
  const onPttBlur = () => {
    if (holdRef.current === 'key') stopRecording();
  };

  const liveTail =
    liveText.length > LIVE_TAIL_LENGTH ? `…${liveText.slice(-(LIVE_TAIL_LENGTH - 1))}` : liveText;

  const connectionNotice = !isConnected && callState !== 'idle'
    ? RECONNECTING_NOTICE
    : callState === 'connected' && !peerConnected
    ? PATIENT_DISCONNECTED_NOTICE
    : null;
  const bannerText = connectionNotice ?? callNotice;

  const status = describeStatus(callState, isConnected, peerConnected);
  const purposeLabel = CALL_PURPOSE_PROFILES[purpose].label;
  const isInCall = callState === 'connected' && !needsAudioResume;

  return (
    <div className="flex h-dvh flex-col bg-canvas select-none">
      <AppHeader
        compactOnMobile={isInCall}
        status={<CallStatus tone={status.tone} label={status.label} />}
        actions={
          isInCall ? (
            <button type="button" onClick={handleHangUp} className={buttonClass('danger', 'md')}>
              <PhoneOff className="size-4" aria-hidden />
              通話を切る
            </button>
          ) : undefined
        }
      />

      {bannerText && (
        <div className="border-b border-line bg-surface">
          <div className="mx-auto max-w-[1440px] px-4 py-2.5 lg:px-6">
            <CallNotice text={bannerText} />
          </div>
        </div>
      )}

      <main className="min-h-0 flex-1">
        {callState === 'idle' && (
          <div className="h-full overflow-y-auto">
            <form
              onSubmit={handleJoinByCode}
              className="mx-auto w-full max-w-md space-y-6 px-4 py-10 select-text lg:py-16"
            >
              <div className="space-y-2">
                <h1 className="text-[26px] font-bold leading-snug">通話に参加</h1>
                <p className="text-[15px] leading-relaxed text-ink-2 text-pretty">
                  届いた招待リンクを開くと、自動で参加します。リンクを開けないときは、相手の画面に表示されたコードを入力してください。
                </p>
              </div>
              <DemoDataNotice side="partner" />
              <label className="block space-y-2">
                <span className="block text-[15px] font-bold">通話コード</span>
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
                  className="w-full rounded-lg border border-line-strong bg-surface px-3.5 py-3 text-center text-[22px] font-bold tabular-nums text-ink placeholder:font-normal placeholder:text-ink-2/60 focus:border-voice"
                />
              </label>
              <button
                type="submit"
                disabled={!isConnected || !inviteInput.trim()}
                className={buttonClass('primary', 'lg', 'w-full')}
              >
                {isConnected ? '通話に参加する' : 'サーバーに接続しています…'}
              </button>
              <p className="border-t border-line pt-4 text-[13px] leading-relaxed text-ink-2">
                EchoBridgeは、発話が難しい人がAIの支援を受けて話すための通話です。相手の言葉は合成音声で読み上げられ、あなたの声は文字にして相手に届きます。インストールとログインは不要です。
              </p>
            </form>
          </div>
        )}

        {callState === 'ringing' && (
          <div className="h-full overflow-y-auto">
            <section
              aria-labelledby="incoming-heading"
              className="mx-auto w-full max-w-md space-y-6 px-4 py-10 lg:py-16"
            >
              <div className="space-y-3">
                <h1 id="incoming-heading" className="text-[24px] font-bold leading-snug text-balance">
                  AI音声アシスタントを使う人からの通話です
                </h1>
                <p className="text-[15px] leading-relaxed text-ink-2 text-pretty">
                  応答すると、相手が用意した文を合成音声で読み上げます。音量を上げてからお聞きください。
                </p>
              </div>
              <dl className="divide-y divide-line rounded-xl border border-line bg-surface text-[15px]">
                <div className="flex gap-4 px-4 py-3">
                  <dt className="w-16 shrink-0 text-ink-2">目的</dt>
                  <dd className="min-w-0 font-bold">{purposeLabel}</dd>
                </div>
                {partnerName && (
                  <div className="flex gap-4 px-4 py-3">
                    <dt className="w-16 shrink-0 text-ink-2">宛先</dt>
                    <dd className="min-w-0 font-bold break-words">{partnerName}</dd>
                  </div>
                )}
              </dl>
              <DemoDataNotice side="partner" />
              <div className="grid gap-2 sm:grid-cols-2">
                <button type="button" onClick={handleAnswerCall} className={buttonClass('primary', 'lg')}>
                  <Phone className="size-5" aria-hidden />
                  応答する
                </button>
                <button type="button" onClick={handleLeaveCall} className={buttonClass('secondary', 'lg')}>
                  応答しない
                </button>
              </div>
            </section>
          </div>
        )}

        {callState === 'connected' && needsAudioResume && (
          <div className="h-full overflow-y-auto">
            <section className="mx-auto w-full max-w-md space-y-5 px-4 py-10 lg:py-16">
              <h1 className="text-[24px] font-bold leading-snug">通話に戻ります</h1>
              <p className="text-[15px] leading-relaxed text-ink-2">
                画面を読み込み直したため、読み上げが止まっています。ボタンを押すと、届いていた文から読み上げます。
              </p>
              <button type="button" onClick={handleResumeAudio} className={buttonClass('primary', 'lg', 'w-full')}>
                通話に戻る
              </button>
            </section>
          </div>
        )}

        {isInCall && (
          <div className="mx-auto flex h-full max-w-[1440px] flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(22rem,26rem)]">
            <section aria-label="字幕" className="min-h-0 flex-1 overflow-y-auto lg:border-r lg:border-line">
              <div className="mx-auto max-w-3xl px-4 py-5 lg:px-8 lg:py-6">
                <ol role="log" aria-label="字幕" className="space-y-5">
                  {captions.map((line) =>
                    line.who === 'notice' ? (
                      <li key={line.id} className="flex justify-center">
                        <p className="rounded-full bg-subtle px-3.5 py-1.5 text-center text-[13px] text-ink-2">
                          自動案内：{line.text}
                        </p>
                      </li>
                    ) : (
                      <li
                        key={line.id}
                        className={cx('flex flex-col gap-1.5', line.who === 'me' ? 'items-end' : 'items-start')}
                      >
                        <p className="flex items-center gap-2 px-1 text-[13px]">
                          <span className="font-bold text-ink">{line.who === 'me' ? 'あなた' : '相手'}</span>
                          <span className="text-ink-2">
                            {line.who === 'me' ? '文字起こし' : '読み上げた文'}
                          </span>
                          {line.seq !== undefined && line.seq === readingSeq && (
                            <span className="inline-flex items-center gap-1.5 font-bold text-voice-strong">
                              <span aria-hidden className="eb-live-dot size-2 rounded-full bg-voice" />
                              読み上げ中
                            </span>
                          )}
                        </p>
                        <p
                          className={cx(
                            'max-w-[min(40rem,88%)] rounded-xl px-4 py-3 leading-(--leading-talk) text-pretty break-words select-text',
                            line.who === 'me'
                              ? 'bg-subtle text-[16px] text-ink'
                              : 'border border-line bg-surface text-[19px] text-ink',
                            line.seq !== undefined && line.seq === readingSeq && 'border-voice ring-1 ring-voice',
                          )}
                        >
                          {line.text}
                        </p>
                      </li>
                    ),
                  )}
                </ol>
                {captions.length === 0 && !liveText && (
                  <p className="rounded-xl border border-dashed border-line-strong px-4 py-4 text-[14px] text-ink-2">
                    相手の文と、あなたの話した内容が、ここに文字で表示されます。
                  </p>
                )}
                {liveText && (
                  <div className="mt-5 flex flex-col items-end gap-1.5">
                    <p className="px-1 text-[13px] font-bold text-ink">あなた（認識中）</p>
                    <p className="max-w-[min(40rem,88%)] rounded-xl border border-dashed border-line-strong bg-surface px-4 py-3 text-[16px] leading-(--leading-talk) text-ink-2 text-pretty break-words select-text">
                      {liveText}
                    </p>
                  </div>
                )}
                <div ref={captionsEndRef} />
              </div>
            </section>

            <section
              aria-label="話す"
              className="shrink-0 border-t border-line bg-surface px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] lg:flex lg:flex-col lg:justify-center lg:border-t-0 lg:px-6 lg:py-6"
            >
              <div className="mx-auto w-full max-w-md space-y-3">
                {/* 長い文で録音ボタンが押し出されないよう、高さを固定して末尾だけを出す。全文は字幕にある。 */}
                <p
                  data-testid="ptt-live"
                  aria-hidden
                  className="line-clamp-2 h-12 text-[15px] leading-6 text-ink-2 break-all"
                >
                  {liveText ? `認識中：${liveTail}` : isRecording ? '認識中…' : ''}
                </p>
                <button
                  type="button"
                  onPointerDown={onPttPointerDown}
                  onPointerUp={() => endPress('pointer')}
                  onPointerCancel={() => endPress('pointer')}
                  onKeyDown={onPttKeyDown}
                  onKeyUp={onPttKeyUp}
                  onClick={onPttClick}
                  onBlur={onPttBlur}
                  onContextMenu={(event) => event.preventDefault()}
                  disabled={recordingPhase === 'idle' && !canStartRecording}
                  aria-pressed={recordingPhase !== 'idle'}
                  aria-describedby="ptt-hint"
                  className={cx(
                    'flex min-h-28 w-full touch-none flex-col items-center justify-center gap-2 rounded-2xl text-[18px] font-bold transition-colors duration-150 disabled:cursor-not-allowed lg:min-h-40',
                    isRecording
                      ? 'bg-danger text-white'
                      : isPreparing
                      ? 'bg-caution-soft text-caution ring-2 ring-caution-line'
                      : canStartRecording
                      ? 'bg-voice text-on-voice hover:bg-voice-strong'
                      : 'bg-subtle text-ink-2',
                  )}
                >
                  <Mic className="size-8" aria-hidden />
                  押して話す
                </button>
                <p role="status" className="text-center text-[15px] font-bold text-ink">
                  {describePtt(isConnected, recordingPhase, isLatched, isReadingAloud, isPatientSpeaking, speechStatus)}
                </p>
                {recordingFailure && (
                  <p role="alert" className="text-center text-[15px] font-bold text-danger">
                    {RECORDING_FAILURE_LABELS[recordingFailure]}
                  </p>
                )}
                <p id="ptt-hint" className="text-center text-[13px] leading-relaxed text-ink-2">
                  押して開始し、もう一度押すと送ります。押し続けて話し、離して送ることもできます。
                </p>
              </div>
            </section>
          </div>
        )}

        {callState === 'ended' && (
          <div className="h-full overflow-y-auto">
            <section className="mx-auto w-full max-w-md space-y-5 px-4 py-10 lg:py-16">
              <h1 className="text-[24px] font-bold leading-snug">通話が終了しました</h1>
              <p className="text-[15px] leading-relaxed text-ink-2">
                この画面の字幕は保存されません。新しい招待リンクを開くと、次の通話に参加できます。
              </p>
              <button type="button" onClick={handleLeaveCall} className={buttonClass('secondary', 'md')}>
                待機画面に戻る
              </button>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
