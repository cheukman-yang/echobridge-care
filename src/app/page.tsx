"use client";

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Phone, PhoneOff, Send, RotateCcw, Sparkles } from 'lucide-react';
import { AppointmentReviewCard } from '@/components/AppointmentReviewCard';
import type { TranscriptLine } from '@/components/AppointmentReviewCard';
import {
  AiStatusBadge,
  SpeechUnavailableNotice,
  SuggestionSourceNote,
} from '@/components/AiStatusBadge';
import { PolishReviewPanel } from '@/components/PolishReviewPanel';
import type { AiMeta, AiStatus } from '@/lib/aiMeta';
import {
  MAX_PATIENT_TEXT_LENGTH,
  TYPING_NOTICE_TEXT,
  buildGreeting,
} from '@/lib/callProtocol';
import type { AppointmentDraft, ServerMessage, SpeechOrigin, SpeechStatus, SuggestionItem } from '@/lib/callProtocol';
import { INITIAL_COMPOSER, composerReducer, resolveConfirmedSpeech } from '@/lib/composer';
import type { SpeechChoice } from '@/lib/composer';

const WS_URL = 'ws://localhost:8080/ws/call';
const RECONNECT_DELAY_MS = 1500;
const HOSPITAL_IDLE_NOTICE_MS = 5000;

const TypewriterText = ({
  text,
  speed = 230,
  onComplete
}: {
  text: string;
  speed?: number;
  onComplete?: () => void
}) => {
  const [count, setCount] = useState(0);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    setCount(0);
    const timer = setInterval(() => {
      setCount((prev) => {
        if (prev < text.length) return prev + 1;
        clearInterval(timer);
        return prev;
      });
    }, speed);
    return () => clearInterval(timer);
  }, [text, speed]);

  useEffect(() => {
    if (count >= text.length && count > 0) {
      if (onCompleteRef.current) {
        onCompleteRef.current();
      }
    }
  }, [count, text.length]);

  return <span className="whitespace-pre-line">{text.slice(0, count)}</span>;
};

const AudioPulseBar = ({ label }: { label: string }) => (
  <div className="flex items-center gap-2 bg-slate-800/90 border border-slate-700 px-3 py-1.5 rounded-full w-fit mx-auto my-2 animate-pulse shadow-md">
    <div className="flex items-end gap-1 h-3">
      <span className="w-1 bg-blue-400 rounded-full animate-bounce h-2" style={{ animationDelay: '0ms' }} />
      <span className="w-1 bg-blue-400 rounded-full animate-bounce h-3" style={{ animationDelay: '150ms' }} />
      <span className="w-1 bg-blue-400 rounded-full animate-bounce h-1.5" style={{ animationDelay: '300ms' }} />
      <span className="w-1 bg-blue-400 rounded-full animate-bounce h-2.5" style={{ animationDelay: '450ms' }} />
    </div>
    <span className="text-[11px] text-blue-300 font-medium">{label}</span>
  </div>
);

type MessageOrigin = SpeechOrigin | 'greeting' | 'notice';

interface ChatMessage {
  id: string;
  sender: 'patient' | 'hospital';
  text: string;
  origin?: MessageOrigin;
}

interface PendingSpeech {
  text: string;
  origin: SpeechOrigin;
}

interface AppointmentResult {
  appointment: AppointmentDraft;
  ai: AiMeta;
}

/** 読み上げた文がどの経路で確定したかを、吹き出しの上に出す。 */
const ORIGIN_LABELS: Record<MessageOrigin, string> = {
  greeting: '冒頭のあいさつ',
  notice: '自動案内',
  typed: '入力した文',
  ai_reviewed: 'AI案を確認',
  ai_edited: 'AI案を編集',
  suggestion: 'AI候補から選択',
  fallback_suggestion: '定型文から選択',
};

function speakerLabel(message: ChatMessage): string {
  if (message.sender === 'hospital') return '病院受付';
  return message.origin ? `あなた・${ORIGIN_LABELS[message.origin]}` : 'あなた';
}

export default function PatientApp() {
  const [isConnected, setIsConnected] = useState(false);
  const [callState, setCallState] = useState<'idle' | 'ringing' | 'connected' | 'analyzing' | 'summary'>('idle');
  const [intent, setIntent] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [patientInput, setPatientInput] = useState('');
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([]);

  const [isHospitalSpeaking, setIsHospitalSpeaking] = useState(false);
  const [liveHospitalText, setLiveHospitalText] = useState('');

  const [isGenerating, setIsGenerating] = useState(false);
  const [appointmentResult, setAppointmentResult] = useState<AppointmentResult | null>(null);

  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus | null>(null);
  const [lastAi, setLastAi] = useState<AiMeta | null>(null);
  const [suggestionsAi, setSuggestionsAi] = useState<AiMeta | null>(null);
  const [composer, dispatchComposer] = useReducer(composerReducer, INITIAL_COMPOSER);
  const [sendError, setSendError] = useState<string | null>(null);

  const [isTypingNoticeActive, setIsTypingNoticeActive] = useState(false);
  // WebSocketの受信処理から最新値を読むためのref。stateを依存に入れると接続を張り直してしまう。
  const typingNoticeActiveRef = useRef(false);
  const pendingSpeechQueueRef = useRef<PendingSpeech[]>([]);
  const hospitalIdleTimerRef = useRef<NodeJS.Timeout | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const messageIdRef = useRef(0);
  const polishRequestIdRef = useRef(0);

  const createMessage = useCallback((message: Omit<ChatMessage, 'id'>): ChatMessage => {
    messageIdRef.current += 1;
    return { id: String(messageIdRef.current), ...message };
  }, []);

  const appendMessage = useCallback((message: Omit<ChatMessage, 'id'>) => {
    const created = createMessage(message);
    setMessages((prev) => [...prev, created]);
  }, [createMessage]);

  const setTypingNoticeActive = useCallback((active: boolean) => {
    typingNoticeActiveRef.current = active;
    setIsTypingNoticeActive(active);
  }, []);

  const clearIdleTimer = useCallback(() => {
    if (hospitalIdleTimerRef.current) {
      clearTimeout(hospitalIdleTimerRef.current);
      hospitalIdleTimerRef.current = null;
    }
  }, []);

  const triggerIdleTimer = useCallback(() => {
    clearIdleTimer();
    hospitalIdleTimerRef.current = setTimeout(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        setTypingNoticeActive(true);
        appendMessage({ sender: 'patient', text: TYPING_NOTICE_TEXT, origin: 'notice' });
        wsRef.current.send(JSON.stringify({ type: 'patient_typing_notice' }));
        wsRef.current.send(JSON.stringify({ type: 'patient_speaking_status', isSpeaking: true }));
      }
    }, HOSPITAL_IDLE_NOTICE_MS);
  }, [appendMessage, clearIdleTimer, setTypingNoticeActive]);

  const handleNoticeComplete = useCallback(() => {
    setTypingNoticeActive(false);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'patient_speaking_status', isSpeaking: false }));
    }
    const queued = pendingSpeechQueueRef.current;
    pendingSpeechQueueRef.current = [];
    queued.forEach(({ text, origin }) => appendMessage({ sender: 'patient', text, origin }));
  }, [appendMessage, setTypingNoticeActive]);

  const resetLocalCall = useCallback(() => {
    clearIdleTimer();
    setCallState('idle');
    setMessages([]);
    setSuggestions([]);
    setSuggestionsAi(null);
    setIntent('');
    setPatientInput('');
    setIsHospitalSpeaking(false);
    setLiveHospitalText('');
    setAppointmentResult(null);
    setIsGenerating(false);
    setSendError(null);
    setTypingNoticeActive(false);
    dispatchComposer({ type: 'close' });
    pendingSpeechQueueRef.current = [];
  }, [clearIdleTimer, setTypingNoticeActive]);

  const handleServerMessage = useCallback((data: ServerMessage) => {
    if (data.type === 'ai_status') {
      setAiStatus({ configured: data.configured, backend: data.backend, model: data.model });
      // 接続し直すと設定が変わっている場合があるので、前の接続の結果を持ち越さない。
      setLastAi(null);
    } else if (data.type === 'speech_status') {
      setSpeechStatus(data.status);
    } else if (data.type === 'answer_call') {
      setCallState('connected');
      setMessages([createMessage({ sender: 'patient', text: data.text, origin: 'greeting' })]);
    } else if (data.type === 'hospital_speaking_start') {
      clearIdleTimer();
      setIsHospitalSpeaking(true);
      setLiveHospitalText('');
    } else if (data.type === 'transcript_interim') {
      setIsHospitalSpeaking(true);
      setLiveHospitalText(data.text);
    } else if (data.type === 'hospital_speaking_stop') {
      setIsHospitalSpeaking(false);
      setLiveHospitalText('');
    } else if (data.type === 'transcript_final') {
      setIsHospitalSpeaking(false);
      setLiveHospitalText('');
      appendMessage({ sender: 'hospital', text: data.text });
      triggerIdleTimer();
    } else if (data.type === 'generating_suggestions') {
      setIsGenerating(true);
      setSuggestions([]);
      setSuggestionsAi(null);
    } else if (data.type === 'suggestions') {
      setSuggestions(data.suggestions);
      setSuggestionsAi(data.ai);
      setLastAi(data.ai);
      setIsGenerating(false);
    } else if (data.type === 'patient_polish_result') {
      setLastAi(data.ai);
      dispatchComposer({
        type: 'result',
        requestId: data.requestId,
        polished: data.polished,
        ai: data.ai,
      });
    } else if (data.type === 'patient_speech') {
      if (typingNoticeActiveRef.current) {
        pendingSpeechQueueRef.current.push({ text: data.text, origin: data.origin });
      } else {
        appendMessage({ sender: 'patient', text: data.text, origin: data.origin });
      }
    } else if (data.type === 'call_ending') {
      setCallState('analyzing');
      clearIdleTimer();
      dispatchComposer({ type: 'close' });
    } else if (data.type === 'end_call') {
      setAppointmentResult({ appointment: data.appointment, ai: data.ai });
      setLastAi(data.ai);
      setCallState('summary');
      clearIdleTimer();
    } else if (data.type === 'reset_call') {
      resetLocalCall();
    }
  }, [appendMessage, clearIdleTimer, createMessage, resetLocalCall, triggerIdleTimer]);

  useEffect(() => {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!disposed) setIsConnected(true);
      };

      ws.onclose = () => {
        if (disposed) return;
        setIsConnected(false);
        // 整形結果はこの接続にしか届かないので、切れたら待ち続けない。
        dispatchComposer({ type: 'connection_lost' });
        retryTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      };

      ws.onerror = () => {
        if (!disposed) setIsConnected(false);
      };

      ws.onmessage = (event) => {
        if (disposed) return;
        let data: ServerMessage;
        try {
          data = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        handleServerMessage(data);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      clearIdleTimer();
      wsRef.current?.close();
    };
  }, [clearIdleTimer, handleServerMessage]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [messages, liveHospitalText, isHospitalSpeaking, isGenerating, composer.phase]);

  const greetingPreview = useMemo(() => (intent.trim() ? buildGreeting(intent) : ''), [intent]);

  const transcript = useMemo<TranscriptLine[]>(
    () => messages.map((message) => ({ id: message.id, speaker: speakerLabel(message), text: message.text })),
    [messages],
  );

  const handleStartCall = () => {
    if (!intent.trim()) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      alert('サーバーに接続できていません。');
      return;
    }
    setCallState('ringing');
    wsRef.current.send(JSON.stringify({ type: 'start_call', intent }));
  };

  /** 本人が確定した文を送る唯一の経路。textは書き換えずにそのまま渡す。 */
  const sendConfirmedSpeech = (text: string, origin: SpeechOrigin): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setSendError('サーバーに接続できていないため、送信できませんでした。');
      return false;
    }
    setSendError(null);
    clearIdleTimer();
    setSuggestions([]);
    setSuggestionsAi(null);
    setIsGenerating(false);
    ws.send(JSON.stringify({ type: 'patient_confirmed_speech', text, origin }));
    return true;
  };

  const handleSendTyped = () => {
    const text = patientInput.trim();
    if (!text || isHospitalSpeaking || composer.phase !== 'editing') return;
    if (sendConfirmedSpeech(text, 'typed')) {
      setPatientInput('');
    }
  };

  const handleRequestPolish = () => {
    const original = patientInput.trim();
    if (!original || composer.phase !== 'editing') return;

    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setSendError('サーバーに接続できていないため、AIに依頼できませんでした。');
      return;
    }
    setSendError(null);
    polishRequestIdRef.current += 1;
    const requestId = String(polishRequestIdRef.current);
    dispatchComposer({ type: 'request', requestId, original });
    ws.send(JSON.stringify({ type: 'patient_polish_request', requestId, text: original }));
  };

  const handleReviewSend = (choice: SpeechChoice) => {
    if (isHospitalSpeaking) return;
    const speech = resolveConfirmedSpeech(composer, choice);
    if (speech && sendConfirmedSpeech(speech.text, speech.origin)) {
      dispatchComposer({ type: 'close' });
      setPatientInput('');
    }
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // 日本語IMEの変換確定で発火させない。Safariは確定直後のEnterを keyCode 229 で送る。
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
    // Enterは何も送らない。AI案を作るだけなので、押し間違えても相手には届かない。
    handleRequestPolish();
  };

  const handleSendSuggestion = (text: string) => {
    if (isHospitalSpeaking) return;
    const origin = suggestionsAi?.source === 'gemini' ? 'suggestion' : 'fallback_suggestion';
    if (sendConfirmedSpeech(text, origin)) {
      // 候補で返答したら、作成中のAI案は不要なので確認画面を開かない。
      dispatchComposer({ type: 'close' });
    }
  };

  const handleEndCall = () => {
    setCallState('analyzing');
    clearIdleTimer();
    dispatchComposer({ type: 'close' });
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'end_call' }));
    }
  };

  const handleGlobalReset = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'reset_call' }));
    }
    resetLocalCall();
  };

  const isPolishing = composer.phase === 'polishing';
  const canWrite = !isHospitalSpeaking && !isPolishing;

  return (
    <div className="flex h-screen bg-slate-950 items-center justify-center p-4 relative">
      <div className="absolute top-4 right-6 z-50">
        <button
          onClick={handleGlobalReset}
          className="flex items-center gap-1.5 bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 px-3 py-1.5 rounded-full text-xs font-medium shadow-md transition active:scale-95"
          title="両端末を初期待機状態にリセット"
        >
          <RotateCcw className="w-3.5 h-3.5 text-indigo-400" />
          <span>全体リセット</span>
        </button>
      </div>

      <div className="w-[360px] h-[780px] max-h-full bg-slate-900 rounded-[3rem] border-[10px] border-slate-700 relative overflow-hidden flex flex-col shadow-2xl">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-6 bg-slate-700 rounded-b-2xl z-10" />

        <header className="pt-10 pb-3 px-5 border-b border-slate-800 flex items-center justify-between z-20">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-extrabold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
              EchoBridge
            </h1>
            <span
              className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`}
              title={isConnected ? 'サーバー接続中' : '未接続'}
            />
            <AiStatusBadge status={aiStatus} last={lastAi} />
          </div>
          {callState === 'connected' && (
            <button
              onClick={handleEndCall}
              className="flex items-center gap-1 bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/40 px-3 py-1 rounded-full text-xs font-bold transition shadow-sm active:scale-95"
            >
              <PhoneOff className="w-3.5 h-3.5" />
              <span>通話終了</span>
            </button>
          )}
        </header>

        <SpeechUnavailableNotice status={speechStatus} />

        {callState === 'idle' && (
          <div className="flex-1 flex flex-col p-6 justify-center gap-4">
            <div className="text-center space-y-1">
              <h2 className="text-xl font-bold text-white">通話の準備</h2>
              <p className="text-xs text-slate-400">病院受付に伝えたい要件を入力してください</p>
            </div>
            <textarea
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              placeholder="例：内科の初診予約をしたいです"
              maxLength={MAX_PATIENT_TEXT_LENGTH}
              className="w-full h-32 bg-slate-800 text-white rounded-xl p-4 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 border border-slate-700"
            />
            {greetingPreview && (
              <div className="space-y-1">
                <p className="text-xs text-slate-400">相手が応答すると、この文を読み上げます</p>
                <p
                  data-testid="greeting-preview"
                  className="text-sm leading-relaxed text-slate-100 bg-slate-800/70 border border-slate-700 rounded-xl px-3 py-2"
                >
                  {greetingPreview}
                </p>
              </div>
            )}
            <button
              onClick={handleStartCall}
              disabled={!intent.trim() || !isConnected}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-bold py-3 rounded-xl flex justify-center items-center gap-2 transition shadow-lg"
            >
              <Phone className="w-5 h-5" />
              {isConnected ? '発信する' : 'サーバー接続待機中...'}
            </button>
          </div>
        )}

        {callState === 'ringing' && (
          <div className="flex-1 flex flex-col items-center justify-center animate-pulse gap-4">
            <div className="w-20 h-20 rounded-full bg-indigo-500/20 flex items-center justify-center">
              <Phone className="w-10 h-10 text-indigo-400" />
            </div>
            <p className="text-indigo-300 font-bold text-sm">病院の応答を待っています...</p>
          </div>
        )}

        {callState === 'connected' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            {isHospitalSpeaking && <AudioPulseBar label="病院受付が発話中... (送信待機)" />}

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.map((msg, index) => (
                <div key={msg.id} className={`flex flex-col ${msg.sender === 'patient' ? 'items-end' : 'items-start'}`}>
                  <span className="text-[10px] text-slate-500 mb-1">{speakerLabel(msg)}</span>
                  <div
                    className={`max-w-[85%] p-3 rounded-2xl text-sm leading-relaxed ${
                      msg.sender === 'patient' ? 'bg-indigo-600 text-white rounded-tr-sm' : 'bg-slate-700 text-slate-100 rounded-tl-sm'
                    }`}
                  >
                    {msg.sender === 'patient' ? (
                      <TypewriterText
                        text={msg.text}
                        speed={230}
                        onComplete={index === messages.length - 1 && isTypingNoticeActive ? handleNoticeComplete : undefined}
                      />
                    ) : (
                      msg.text
                    )}
                  </div>
                </div>
              ))}

              {liveHospitalText && (
                <div className="flex flex-col items-start animate-in fade-in duration-100">
                  <span className="text-[10px] text-indigo-400 mb-1 flex items-center gap-1 font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-ping" />
                    病院受付 (音声認識中...)
                  </span>
                  <div className="max-w-[85%] p-3 rounded-2xl text-sm leading-relaxed bg-slate-800 text-slate-200 border border-indigo-500/40 rounded-tl-sm shadow-sm">
                    {liveHospitalText}
                  </div>
                </div>
              )}

              {isPolishing && (
                <div className="flex flex-col items-end gap-1">
                  <div className="flex items-center gap-1.5 text-xs text-indigo-400 bg-indigo-950/60 border border-indigo-800 px-3 py-1.5 rounded-full">
                    <Sparkles className="w-3.5 h-3.5 animate-spin" />
                    <span>AIが案を作っています (まだ送信されません)</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => dispatchComposer({ type: 'close' })}
                    className="text-xs text-slate-300 underline px-2 py-1"
                  >
                    やめる
                  </button>
                </div>
              )}

              <div ref={chatEndRef} />
            </div>

            <div className="bg-slate-800 border-t border-slate-700 p-4 flex flex-col gap-3 pb-8 max-h-[72%] overflow-y-auto">
              {composer.phase === 'reviewing' || composer.phase === 'failed' ? (
                <PolishReviewPanel
                  state={composer}
                  sendDisabled={isHospitalSpeaking}
                  onEditDraft={(draft) => dispatchComposer({ type: 'edit_draft', draft })}
                  onSend={handleReviewSend}
                  onClose={() => dispatchComposer({ type: 'close' })}
                />
              ) : (
                <>
                  {isGenerating ? (
                    <div className="flex flex-col items-center justify-center py-2 space-y-2">
                      <div className="w-5 h-5 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
                      <span className="text-xs text-indigo-300">返答候補を準備中...</span>
                    </div>
                  ) : suggestions.length > 0 ? (
                    <div className="space-y-2">
                      <SuggestionSourceNote ai={suggestionsAi} />
                      {suggestions.map((sug, idx) => (
                        <button
                          key={idx}
                          onClick={() => handleSendSuggestion(sug.text)}
                          disabled={isHospitalSpeaking}
                          className="w-full text-left bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:pointer-events-none p-3 rounded-xl border border-slate-600 transition flex flex-col gap-1 active:scale-[0.98]"
                        >
                          <span className="text-sm text-white leading-snug">{sug.text}</span>
                          {sug.tag && <span className="text-[10px] text-indigo-300 font-semibold">{sug.tag}</span>}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  <div className="space-y-2 mt-1">
                    <input
                      type="text"
                      aria-label="相手に伝える文"
                      value={patientInput}
                      maxLength={MAX_PATIENT_TEXT_LENGTH}
                      disabled={!canWrite}
                      onChange={(e) => setPatientInput(e.target.value)}
                      onKeyDown={handleInputKeyDown}
                      placeholder={isHospitalSpeaking ? "相手が話しています..." : "伝えたいことを入力..."}
                      className="w-full bg-slate-900 border border-slate-600 disabled:opacity-50 disabled:bg-slate-950 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleRequestPolish}
                        disabled={!patientInput.trim() || !canWrite}
                        className="flex-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 border border-slate-600 py-2.5 rounded-xl transition text-white text-sm font-medium flex justify-center items-center gap-1.5"
                      >
                        <Sparkles className="w-4 h-4" />
                        AIで整える
                      </button>
                      <button
                        type="button"
                        onClick={handleSendTyped}
                        disabled={!patientInput.trim() || !canWrite}
                        className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 py-2.5 rounded-xl transition text-white text-sm font-bold flex justify-center items-center gap-1.5"
                      >
                        <Send className="w-4 h-4" />
                        そのまま送る
                      </button>
                    </div>
                    {sendError && (
                      <p role="alert" className="text-xs text-amber-200">{sendError}</p>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {callState === 'analyzing' && (
          <div className="flex-1 flex flex-col items-center justify-center p-6 space-y-4 animate-in fade-in">
            <div className="w-12 h-12 border-3 border-indigo-400 border-t-transparent rounded-full animate-spin" />
            <h2 className="text-base font-bold text-white">通話内容から予定を確認しています...</h2>
            <p className="text-xs text-slate-400 text-center">結果は追加する前に確認できます</p>
          </div>
        )}

        {callState === 'summary' && appointmentResult && (
          <AppointmentReviewCard
            appointment={appointmentResult.appointment}
            ai={appointmentResult.ai}
            transcript={transcript}
            onBack={handleGlobalReset}
          />
        )}
      </div>
    </div>
  );
}
