"use client";

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Phone, PhoneOff, Send, Calendar, Check, RotateCcw, Sparkles } from 'lucide-react';

// 指定の230msスピードで文字抜けなく1文字ずつタイピング表示するコンポーネント
const TypewriterText = ({ text, speed = 230 }: { text: string; speed?: number }) => {
  const [count, setCount] = useState(0);

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

  return <span>{text.slice(0, count)}</span>;
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

interface AppointmentInfo {
  title: string;
  dateDisplay: string;
  startTimeIso: string;
  endTimeIso: string;
  location: string;
  details: string;
}

export default function PatientApp() {
  const [isConnected, setIsConnected] = useState(false);
  const [callState, setCallState] = useState<'idle' | 'ringing' | 'connected' | 'analyzing' | 'summary'>('idle');
  const [intent, setIntent] = useState('');
  const [messages, setMessages] = useState<{ id: string; sender: 'patient' | 'hospital'; text: string }[]>([]);
  const [patientInput, setPatientInput] = useState('');
  const [suggestions, setSuggestions] = useState<{ text: string; tag?: string }[]>([]);
  
  // 病院側のリアルタイム音声認識ストリーミング用
  const [isHospitalSpeaking, setIsHospitalSpeaking] = useState(false);
  const [liveHospitalText, setLiveHospitalText] = useState('');

  const [isGenerating, setIsGenerating] = useState(false);
  const [isBrushingUp, setIsBrushingUp] = useState(false);
  const [appointment, setAppointment] = useState<AppointmentInfo | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<any>(null);

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

        if (data.type === 'answer_call') {
          setCallState('connected');
          setMessages([{ id: String(Date.now()), sender: 'patient', text: data.text }]);
        } else if (data.type === 'hospital_speaking_start') {
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
          setMessages((prev) => [
            ...prev,
            { id: String(Date.now()), sender: 'hospital', text: data.text }
          ]);
        } else if (data.type === 'generating_suggestions') {
          setIsGenerating(true);
          setSuggestions([]);
        } else if (data.type === 'suggestions') {
          setSuggestions(data.suggestions || []);
          setIsGenerating(false);
        } else if (data.type === 'patient_speech') {
          setIsBrushingUp(false);
          setMessages((prev) => [
            ...prev,
            { id: String(Date.now()), sender: 'patient', text: data.text }
          ]);
        } else if (data.type === 'call_ending') {
          setCallState('analyzing');
        } else if (data.type === 'end_call') {
          if (data.appointment) {
            setAppointment(data.appointment);
          }
          setCallState('summary');
        } else if (data.type === 'reset_call') {
          setCallState('idle');
          setMessages([]);
          setSuggestions([]);
          setIntent('');
          setIsHospitalSpeaking(false);
          setLiveHospitalText('');
          setAppointment(null);
          setIsGenerating(false);
          setIsBrushingUp(false);
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
      if (wsRef.current) wsRef.current.close();
    };
  }, [connectWebSocket]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, liveHospitalText, isHospitalSpeaking, isGenerating, isBrushingUp]);

  const handleStartCall = () => {
    if (!intent.trim()) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      alert('サーバーに接続できていません。');
      return;
    }
    setCallState('ringing');
    wsRef.current.send(JSON.stringify({ type: 'start_call', intent }));
  };

  const handleSendManualInput = () => {
    if (!patientInput.trim()) return;
    const raw = patientInput;
    setPatientInput('');
    setIsBrushingUp(true);
    setSuggestions([]);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'patient_send', text: raw }));
    }
  };

  const handleSendSuggestion = (text: string) => {
    setSuggestions([]);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'patient_speech_direct', text }));
    }
  };

  const handleEndCall = () => {
    setCallState('analyzing');
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'end_call' }));
    }
  };

  const handleGlobalReset = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'reset_call' }));
    }
    setCallState('idle');
    setMessages([]);
    setSuggestions([]);
    setIntent('');
    setIsHospitalSpeaking(false);
    setLiveHospitalText('');
    setAppointment(null);
    setIsGenerating(false);
    setIsBrushingUp(false);
  };

  const openGoogleCalendar = () => {
    if (!appointment) return;
    const title = encodeURIComponent(appointment.title);
    const dates = `${appointment.startTimeIso}/${appointment.endTimeIso}`;
    const location = encodeURIComponent(appointment.location);
    const details = encodeURIComponent(appointment.details);
    const url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${dates}&location=${location}&details=${details}`;
    window.open(url, '_blank');
  };

  return (
    <div className="flex h-screen bg-slate-950 items-center justify-center p-4 relative">
      {/* 画面外 全体リセットボタン */}
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

      <div className="w-[360px] h-[780px] bg-slate-900 rounded-[3rem] border-[10px] border-slate-700 relative overflow-hidden flex flex-col shadow-2xl">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-6 bg-slate-700 rounded-b-2xl z-10" />

        {/* ヘッダー */}
        <header className="pt-10 pb-3 px-5 border-b border-slate-800 flex items-center justify-between z-20">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-extrabold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
              EchoBridge
            </h1>
            <span
              className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`}
              title={isConnected ? 'サーバー接続中' : '未接続'}
            />
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

        {callState === 'idle' && (
          <div className="flex-1 flex flex-col p-6 justify-center gap-6">
            <div className="text-center space-y-1">
              <h2 className="text-xl font-bold text-white">通話の準備</h2>
              <p className="text-xs text-slate-400">病院受付に伝えたい要件を入力してください</p>
            </div>
            <textarea
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              placeholder="例：内科の初診予約をしたいです"
              className="w-full h-32 bg-slate-800 text-white rounded-xl p-4 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 border border-slate-700"
            />
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
            {/* 病院受付がPTTボタンを押している間リアルタイムに波打つパルス */}
            {isHospitalSpeaking && <AudioPulseBar label="病院受付が発話中..." />}

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.map((msg) => (
                <div key={msg.id} className={`flex flex-col ${msg.sender === 'patient' ? 'items-end' : 'items-start'}`}>
                  <span className="text-[10px] text-slate-500 mb-1">{msg.sender === 'patient' ? 'あなた (AI音声)' : '病院受付'}</span>
                  <div
                    className={`max-w-[85%] p-3 rounded-2xl text-sm leading-relaxed ${
                      msg.sender === 'patient' ? 'bg-indigo-600 text-white rounded-tr-sm' : 'bg-slate-700 text-slate-100 rounded-tl-sm'
                    }`}
                  >
                    {/* ★患者側（AI音声）のみ230msスピードで1文字ずつ出力 */}
                    {msg.sender === 'patient' ? (
                      <TypewriterText text={msg.text} speed={230} />
                    ) : (
                      msg.text
                    )}
                  </div>
                </div>
              ))}

              {/* 病院側の音声認識中リアルタイムストリーミング吹き出し */}
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

              {isBrushingUp && (
                <div className="flex flex-col items-end">
                  <div className="flex items-center gap-1.5 text-xs text-indigo-400 bg-indigo-950/60 border border-indigo-800 px-3 py-1.5 rounded-full">
                    <Sparkles className="w-3.5 h-3.5 animate-spin" />
                    <span>AIが丁寧な敬語に整えています...</span>
                  </div>
                </div>
              )}

              <div ref={chatEndRef} />
            </div>

            <div className="bg-slate-800 border-t border-slate-700 p-4 flex flex-col gap-3 pb-8">
              {isGenerating ? (
                <div className="flex flex-col items-center justify-center py-2 space-y-2">
                  <div className="w-5 h-5 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
                  <span className="text-xs text-indigo-300">AIが返答候補を生成中...</span>
                </div>
              ) : suggestions.length > 0 ? (
                <div className="space-y-2">
                  <span className="text-[11px] text-slate-400 font-medium">返答候補 (タップで即座に発話)</span>
                  {suggestions.map((sug, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleSendSuggestion(sug.text)}
                      className="w-full text-left bg-slate-700 hover:bg-slate-600 p-3 rounded-xl border border-slate-600 transition flex flex-col gap-1 active:scale-[0.98]"
                    >
                      <span className="text-xs text-white leading-snug">{sug.text}</span>
                      {sug.tag && <span className="text-[10px] text-indigo-300 font-semibold">{sug.tag}</span>}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="flex gap-2 mt-1">
                <input
                  type="text"
                  value={patientInput}
                  onChange={(e) => setPatientInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendManualInput()}
                  placeholder="要件を入力 (自然な敬語に変換)..."
                  className="flex-1 bg-slate-900 border border-slate-600 rounded-xl px-3 text-xs text-white focus:outline-none focus:border-indigo-500"
                />
                <button
                  onClick={handleSendManualInput}
                  disabled={!patientInput.trim() || isBrushingUp}
                  className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 p-3 rounded-xl transition flex-shrink-0 text-white"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        {callState === 'analyzing' && (
          <div className="flex-1 flex flex-col items-center justify-center p-6 space-y-4 animate-in fade-in">
            <div className="w-12 h-12 border-3 border-indigo-400 border-t-transparent rounded-full animate-spin" />
            <h2 className="text-base font-bold text-white">通話内容から予定を解析中...</h2>
            <p className="text-xs text-slate-400 text-center">決定した予約日時と場所を抽出しています</p>
          </div>
        )}

        {callState === 'summary' && appointment && (
          <div className="flex-1 flex items-center justify-center p-6 animate-in fade-in zoom-in duration-300">
            <div className="w-full space-y-6 text-center">
              <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto">
                <Check className="w-8 h-8 text-green-400" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-white mb-1">通話が完了しました</h2>
                <p className="text-xs text-slate-400">通話内容から予約予定を抽出しました</p>
              </div>

              <div className="bg-slate-800 rounded-2xl p-4 text-left border border-slate-700 shadow-lg space-y-2">
                <div className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider">予約確認カード</div>
                <div className="text-base font-bold text-white">{appointment.title}</div>
                <div className="text-sm font-bold text-indigo-400">{appointment.dateDisplay}</div>
                <div className="text-xs text-slate-300">場所: {appointment.location}</div>
                {appointment.details && (
                  <div className="text-[11px] text-slate-300 bg-slate-900/80 p-2.5 rounded-lg mt-1 border border-slate-700/60 leading-relaxed">
                    <span className="text-indigo-400 font-semibold mr-1">メモ:</span>
                    {appointment.details}
                  </div>
                )}
              </div>

              <button
                onClick={openGoogleCalendar}
                className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3 rounded-xl flex justify-center items-center gap-2 transition text-sm shadow-lg active:scale-95"
              >
                <Calendar className="w-4 h-4" />
                Google カレンダーに追加
              </button>

              <button
                onClick={handleGlobalReset}
                className="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 py-2.5 rounded-xl transition text-xs font-medium"
              >
                最初の画面に戻る
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}