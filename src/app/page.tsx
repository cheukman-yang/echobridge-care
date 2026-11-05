'use client';

import React, { useState, useRef, useCallback } from 'react';
import { Phone, PhoneOff, Mic, MicOff, Send, Calendar, CheckCircle2, AlertCircle } from 'lucide-react';
import { useAudioRecorder } from '@/hooks/useAudioRecorder';
import {
  ServerWsMessage,
  ServerWsMessageSchema,
  SuggestionItem,
  MedicalSummary,
} from '@/types/websocket';

export default function EchoBridgeApp() {
  const [isConnected, setIsConnected] = useState(false);
  const [isCalling, setIsCalling] = useState(false);
  const [transcripts, setTranscripts] = useState<{ sender: 'clinic' | 'user'; text: string }[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([]);
  const [isFallbackActive, setIsFallbackActive] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const [summary, setSummary] = useState<MedicalSummary | null>(null);

  const socketRef = useRef<WebSocket | null>(null);

  const handleAudioChunk = useCallback((audioBase64: string) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({
          type: 'AUDIO_CHUNK',
          payload: { audioBase64, sequence: Date.now() },
        })
      );
    }
  }, []);

  const { isRecording, startRecording, stopRecording } = useAudioRecorder({
    onAudioChunk: handleAudioChunk,
  });

  const startCall = () => {
    setTranscripts([]);
    setSuggestions([]);
    setSummary(null);

    const ws = new WebSocket('ws://localhost:8080/ws/call');
    socketRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      setIsCalling(true);
      ws.send(
        JSON.stringify({
          type: 'SESSION_START',
          payload: {
            callId: `call_${Date.now()}`,
            targetClinic: 'ひまわり医院',
          },
        })
      );
    };

    ws.onmessage = (event) => {
      try {
        const raw = JSON.parse(event.data);
        const parsed = ServerWsMessageSchema.safeParse(raw);
        if (!parsed.success) return;

        const msg: ServerWsMessage = parsed.data;

        switch (msg.type) {
          case 'STT_TRANSCRIPT':
            setTranscripts((prev) => [...prev, { sender: 'clinic', text: msg.payload.text }]);
            break;

          case 'AI_SUGGESTIONS':
            setSuggestions(msg.payload.suggestions);
            setIsFallbackActive(msg.payload.detected_intent === 'fallback_timeout');
            break;

          case 'CALL_SUMMARY':
            setSummary(msg.payload);
            setIsCalling(false);
            break;
        }
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      setIsCalling(false);
      stopRecording();
    };
  };

  const endCall = () => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({
          type: 'SESSION_END',
          payload: { reason: 'completed' },
        })
      );
    }
    stopRecording();
  };

  const sendSpeech = (text: string, isCustom = false) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;

    setTranscripts((prev) => [...prev, { sender: 'user', text }]);
    setSuggestions([]);
    setIsFallbackActive(false);

    socketRef.current.send(
      JSON.stringify({
        type: 'USER_SPEECH_REQUEST',
        payload: { text, isCustomInput: isCustom },
      })
    );
  };

  const handleCustomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customInput.trim()) return;
    sendSpeech(customInput.trim(), true);
    setCustomInput('');
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center p-4 md:p-8 font-sans">
      <header className="w-full max-w-4xl flex items-center justify-between pb-6 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            EchoBridge <span className="text-xs bg-indigo-900 text-indigo-300 px-2 py-0.5 rounded-full font-mono">DevFest 2026</span>
          </h1>
          <p className="text-sm text-slate-400 mt-1">AI 通話アシスタント（ひまわり医院 予約中継）</p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`inline-block w-2.5 h-2.5 rounded-full ${isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
          <span className="text-sm font-medium text-slate-300">{isConnected ? '接続中' : '未接続'}</span>
        </div>
      </header>

      <section className="w-full max-w-4xl flex-1 grid grid-cols-1 md:grid-cols-3 gap-6 my-6">
        <div className="md:col-span-2 bg-slate-900 border border-slate-800 rounded-xl flex flex-col overflow-hidden">
          <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/60">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Live Transcript</span>
            {isCalling && (
              <button
                onClick={isRecording ? stopRecording : startRecording}
                className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition ${
                  isRecording ? 'bg-rose-500 text-white animate-pulse' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                {isRecording ? <Mic className="w-3.5 h-3.5" /> : <MicOff className="w-3.5 h-3.5" />}
                {isRecording ? 'マイク収音中 (16kHz PCM)' : 'マイク待機'}
              </button>
            )}
          </div>

          <div className="flex-1 p-4 overflow-y-auto space-y-4 min-h-[360px] max-h-[460px]">
            {transcripts.length === 0 ? (
              <div className="h-full flex items-center justify-center text-slate-600 text-sm">
                「通話を開始」を押すと、相手とのやり取りが表示されます。
              </div>
            ) : (
              transcripts.map((t, idx) => (
                <div key={idx} className={`flex flex-col ${t.sender === 'user' ? 'items-end' : 'items-start'}`}>
                  <span className="text-[10px] text-slate-500 mb-1">{t.sender === 'user' ? 'あなた (合成音声)' : '相手 (医院)'}</span>
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                      t.sender === 'user'
                        ? 'bg-indigo-600 text-white rounded-br-none'
                        : 'bg-slate-800 text-slate-200 rounded-bl-none border border-slate-700'
                    }`}
                  >
                    {t.text}
                  </div>
                </div>
              ))
            )}
          </div>

          {isCalling && (
            <form onSubmit={handleCustomSubmit} className="p-3 border-t border-slate-800 flex gap-2 bg-slate-900/40">
              <input
                type="text"
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                placeholder="直接テキストを入力して発話..."
                className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
              />
              <button
                type="submit"
                className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm flex items-center gap-1 font-medium transition"
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
          )}
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">返答候補 (1タップ発話)</span>
              {isFallbackActive && (
                <span className="flex items-center gap-1 text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded">
                  <AlertCircle className="w-3 h-3" /> フォールバック
                </span>
              )}
            </div>

            <div className="space-y-3">
              {suggestions.length === 0 ? (
                <p className="text-xs text-slate-600 text-center py-8">相手の発話後にサジェストが提示されます</p>
              ) : (
                suggestions.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => sendSpeech(item.speech_text)}
                    className="w-full text-left p-3.5 rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-indigo-950 hover:border-indigo-500 transition group"
                  >
                    <div className="text-xs font-medium text-slate-200 group-hover:text-indigo-200">{item.label}</div>
                    <div className="text-[11px] text-slate-400 mt-1 line-clamp-1">{item.speech_text}</div>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="pt-6">
            {!isCalling ? (
              <button
                onClick={startCall}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-3 rounded-xl flex items-center justify-center gap-2 transition shadow-lg shadow-emerald-950"
              >
                <Phone className="w-4 h-4" /> 通話を開始
              </button>
            ) : (
              <button
                onClick={endCall}
                className="w-full bg-rose-600 hover:bg-rose-500 text-white font-medium py-3 rounded-xl flex items-center justify-center gap-2 transition"
              >
                <PhoneOff className="w-4 h-4" /> 通話を終了
              </button>
            )}
          </div>
        </div>
      </section>

      {summary && (
        <section className="w-full max-w-4xl bg-slate-900 border border-emerald-500/30 rounded-xl p-6 shadow-2xl">
          <div className="flex items-center gap-2 text-emerald-400 font-semibold mb-4">
            <CheckCircle2 className="w-5 h-5" />
            <span>通話サマリー（予約完了カルテ）</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div className="space-y-2">
              <p><span className="text-slate-400">医療機関:</span> {summary.clinic_name} ({summary.department})</p>
              <p className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-slate-400" />
                <span className="font-semibold text-white">{summary.appointment_date} {summary.appointment_time}</span>
              </p>
              <p><span className="text-slate-400">特記事項:</span> {summary.notes}</p>
            </div>
            <div>
              <span className="text-slate-400 text-xs block mb-1">当日の持ち物:</span>
              <ul className="list-disc list-inside space-y-1 text-slate-300 text-xs">
                {summary.items_to_bring.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
              <div className="mt-3 p-2.5 rounded bg-slate-950 border border-slate-800 text-xs text-slate-400">
                {summary.raw_transcript_summary}
              </div>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}