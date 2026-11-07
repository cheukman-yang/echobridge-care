"use client";

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { PhoneOff, RotateCcw } from 'lucide-react';
import { AiStatusBadge, CallNotice, SpeechUnavailableNotice } from '@/components/AiStatusBadge';
import { AppHeader, CallStatus } from '@/components/AppHeader';
import type { CallStatusTone } from '@/components/AppHeader';
import { CallFlowGuide, CallSetupForm } from '@/components/CallSetupForm';
import { CallInviteCard } from '@/components/CallInviteCard';
import { CallSummary } from '@/components/CallSummary';
import type { TranscriptLine } from '@/components/CallSummary';
import { ConversationLog, ORIGIN_LABELS } from '@/components/ConversationLog';
import type { LogMessage } from '@/components/ConversationLog';
import { ReplyPanel } from '@/components/ReplyPanel';
import { buttonClass } from '@/components/ui';
import { useCallChannel, useCallSocket } from '@/hooks/useCallChannel';
import type { AiMeta, AiStatus } from '@/lib/aiMeta';
import {
  CALL_CLOSED_NOTICES,
  CALL_ERROR_NOTICES,
  PEER_DISCONNECTED_NOTICE,
  RECONNECTING_NOTICE,
  SEAT_TAKEN_NOTICE,
} from '@/lib/callNotices';
import { TYPING_NOTICE_TEXT } from '@/lib/callProtocol';
import type {
  AppointmentResult,
  CallInvite,
  CallPhase,
  CallSnapshot,
  CallTurn,
  PlaybackStatus,
  ServerMessage,
  SpeechOrigin,
  SpeechStatus,
  SuggestionItem,
} from '@/lib/callProtocol';
import { DEFAULT_CALL_PURPOSE } from '@/lib/callPurpose';
import type { CallPurpose } from '@/lib/callPurpose';
import { INITIAL_COMPOSER, composerReducer, resolveConfirmedSpeech } from '@/lib/composer';
import type { SpeechChoice } from '@/lib/composer';

const HOSPITAL_IDLE_NOTICE_MS = 5000;

/**
 * 自動案内を相手の端末が読み終えるまでの見込み時間（1文字あたり）。
 * 案内の間は相手が話せないので、読み終えた頃に解除する。案内には読み上げの報告がない。
 */
const NOTICE_MS_PER_CHAR = 230;

interface ChatMessage extends LogMessage {
  /** 再接続で取り戻した発言。 */
  restored?: boolean;
}

interface PendingSpeech {
  text: string;
  origin: SpeechOrigin;
  seq: number;
}

type PatientCallState = 'idle' | 'ringing' | 'connected' | 'analyzing' | 'summary';

const PHASE_TO_CALL_STATE: Record<CallPhase, PatientCallState> = {
  ringing: 'ringing',
  connected: 'connected',
  ending: 'analyzing',
  ended: 'summary',
};

/** 発言の id は seq にそろえ、再接続の前後で同じ発言を別物として描き直さない。 */
function turnToMessage(turn: CallTurn): Omit<ChatMessage, 'restored'> {
  return {
    id: String(turn.seq),
    sender: turn.sender === '病院受付' ? 'hospital' : 'patient',
    text: turn.text,
    origin: turn.origin,
  };
}

function speakerLabel(message: ChatMessage, partnerLabel: string): string {
  if (message.sender === 'hospital') return partnerLabel;
  return message.origin ? `あなた（${ORIGIN_LABELS[message.origin]}）` : 'あなた';
}

function playbackFromTurns(turns: CallTurn[]): Record<string, PlaybackStatus> {
  const entries = turns.flatMap((turn) => (turn.playback ? [[String(turn.seq), turn.playback]] : []));
  return Object.fromEntries(entries);
}

export default function PatientApp() {
  const [callState, setCallState] = useState<PatientCallState>('idle');
  const [intent, setIntent] = useState('');
  const [purpose, setPurpose] = useState<CallPurpose>(DEFAULT_CALL_PURPOSE);
  const [partnerName, setPartnerName] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // 相手の端末での読み上げの状態。発言のidごとに持ち、発言の表示より先に届いても失わない。
  const [playback, setPlayback] = useState<Record<string, PlaybackStatus>>({});
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
  const [invite, setInvite] = useState<CallInvite | null>(null);
  const [peerConnected, setPeerConnected] = useState(false);
  const [callNotice, setCallNotice] = useState<string | null>(null);

  const channel = useCallChannel('patient');

  const [isTypingNoticeActive, setIsTypingNoticeActive] = useState(false);
  // WebSocketの受信処理から最新値を読むためのref。stateを依存に入れると接続を張り直してしまう。
  const typingNoticeActiveRef = useRef(false);
  const pendingSpeechQueueRef = useRef<PendingSpeech[]>([]);
  const hospitalIdleTimerRef = useRef<NodeJS.Timeout | null>(null);

  const messageIdRef = useRef(0);
  const polishRequestIdRef = useRef(0);

  /** 通知のようにサーバーの記録にない吹き出しを足す。 */
  const appendLocalMessage = useCallback((message: Omit<ChatMessage, 'id'>) => {
    messageIdRef.current += 1;
    const created = { id: `local-${messageIdRef.current}`, ...message };
    setMessages((prev) => [...prev, created]);
  }, []);

  const appendTurn = useCallback((turn: CallTurn) => {
    setMessages((prev) => [...prev, turnToMessage(turn)]);
  }, []);

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
      if (channel.send({ type: 'patient_typing_notice' })) {
        setTypingNoticeActive(true);
        appendLocalMessage({ sender: 'patient', text: TYPING_NOTICE_TEXT, origin: 'notice' });
        channel.send({ type: 'patient_speaking_status', isSpeaking: true });
      }
    }, HOSPITAL_IDLE_NOTICE_MS);
  }, [appendLocalMessage, channel, clearIdleTimer, setTypingNoticeActive]);

  const handleNoticeComplete = useCallback(() => {
    setTypingNoticeActive(false);
    channel.send({ type: 'patient_speaking_status', isSpeaking: false });
    const queued = pendingSpeechQueueRef.current;
    pendingSpeechQueueRef.current = [];
    queued.forEach(({ text, origin, seq }) => appendTurn({ sender: '患者', text, origin, seq }));
  }, [appendTurn, channel, setTypingNoticeActive]);

  const resetLocalCall = useCallback(() => {
    clearIdleTimer();
    setCallState('idle');
    setMessages([]);
    setPlayback({});
    setSuggestions([]);
    setSuggestionsAi(null);
    setIntent('');
    setPartnerName('');
    setPatientInput('');
    setIsHospitalSpeaking(false);
    setLiveHospitalText('');
    setAppointmentResult(null);
    setIsGenerating(false);
    setSendError(null);
    setInvite(null);
    setPeerConnected(false);
    setTypingNoticeActive(false);
    dispatchComposer({ type: 'close' });
    pendingSpeechQueueRef.current = [];
  }, [clearIdleTimer, setTypingNoticeActive]);

  /** サーバーの状態に画面を合わせる。切断中に届かなかった分もここで取り戻す。 */
  const applySnapshot = useCallback((snapshot: CallSnapshot) => {
    clearIdleTimer();
    setTypingNoticeActive(false);
    pendingSpeechQueueRef.current = [];
    setCallState(PHASE_TO_CALL_STATE[snapshot.phase]);
    setPurpose(snapshot.purpose);
    setPartnerName(snapshot.partnerName);
    setMessages(snapshot.turns.map((turn) => ({ ...turnToMessage(turn), restored: true })));
    setPlayback(playbackFromTurns(snapshot.turns));
    setSuggestions(snapshot.suggestions?.suggestions ?? []);
    setSuggestionsAi(snapshot.suggestions?.ai ?? null);
    setIsGenerating(snapshot.isGeneratingSuggestions);
    setIsHospitalSpeaking(snapshot.isHospitalSpeaking);
    setLiveHospitalText('');
    setAppointmentResult(snapshot.appointment);
    setInvite(snapshot.invite);
    setPeerConnected(snapshot.peerConnected);
    setCallNotice(null);
  }, [clearIdleTimer, setTypingNoticeActive]);

  const handleServerMessage = useCallback((data: ServerMessage) => {
    if (data.type === 'ai_status') {
      setAiStatus({ configured: data.configured, backend: data.backend, model: data.model });
      // 接続し直すと設定が変わっている場合があるので、前の接続の結果を持ち越さない。
      setLastAi(null);
    } else if (data.type === 'speech_status') {
      setSpeechStatus(data.status);
    } else if (data.type === 'call_joined') {
      applySnapshot(data.snapshot);
    } else if (data.type === 'call_error') {
      const notice = CALL_ERROR_NOTICES[data.code];
      if (data.code === 'call_not_found') {
        resetLocalCall();
      } else if (!channel.hasSeat()) {
        // 発信を断られた。入力した用件は残し、そのままかけ直せるようにする。
        setCallState('idle');
      }
      if (notice) setCallNotice(notice);
    } else if (data.type === 'call_closed') {
      // リセットは本人の操作で、画面はもう戻っている。
      if (data.reason === 'reset') return;
      if (data.reason === 'retention_expired') {
        // 確認中の予定は画面に残す。カレンダーへの追加にサーバーは要らない。
        setCallNotice(CALL_CLOSED_NOTICES.retention_expired);
        return;
      }
      resetLocalCall();
      setCallNotice(CALL_CLOSED_NOTICES[data.reason]);
    } else if (data.type === 'peer_status') {
      setPeerConnected(data.connected);
    } else if (data.type === 'answer_call') {
      setCallState('connected');
      setInvite(null);
      setMessages([turnToMessage({ sender: '患者', text: data.text, origin: 'greeting', seq: data.seq })]);
      setPlayback({});
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
      appendTurn({ sender: '病院受付', text: data.text, seq: data.seq });
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
        pendingSpeechQueueRef.current.push({ text: data.text, origin: data.origin, seq: data.seq });
      } else {
        appendTurn({ sender: '患者', text: data.text, origin: data.origin, seq: data.seq });
      }
    } else if (data.type === 'speech_playback') {
      setPlayback((prev) => ({ ...prev, [String(data.seq)]: data.status }));
    } else if (data.type === 'call_ending') {
      setCallState('analyzing');
      clearIdleTimer();
      dispatchComposer({ type: 'close' });
    } else if (data.type === 'end_call') {
      setAppointmentResult({ appointment: data.appointment, ai: data.ai });
      setLastAi(data.ai);
      setCallState('summary');
      clearIdleTimer();
    }
  }, [appendTurn, applySnapshot, channel, clearIdleTimer, resetLocalCall, triggerIdleTimer]);

  const isConnected = useCallSocket(channel, {
    onMessage: handleServerMessage,
    onDisconnected: () => {
      // 整形結果は切断後の接続へ返すとは限らないので、切れたら待ち続けない。
      dispatchComposer({ type: 'connection_lost' });
      // 発信の返事を受け取る前に切れたら、戻る席がないので最初の画面に戻す。
      if (callState === 'ringing' && !channel.hasSeat()) setCallState('idle');
    },
    onSeatTaken: () => {
      resetLocalCall();
      setCallNotice(SEAT_TAKEN_NOTICE);
    },
  });

  useEffect(() => clearIdleTimer, [clearIdleTimer]);

  // 自動案内を相手が聞き終えた頃に、相手の発話の禁止を解き、待たせていた文を表示する。
  useEffect(() => {
    if (!isTypingNoticeActive) return;
    const timer = setTimeout(handleNoticeComplete, TYPING_NOTICE_TEXT.length * NOTICE_MS_PER_CHAR);
    return () => clearTimeout(timer);
  }, [handleNoticeComplete, isTypingNoticeActive]);

  const partnerLabel = partnerName.trim() || '相手';

  const transcript = useMemo<TranscriptLine[]>(
    () =>
      messages.map((message) => ({
        id: message.id,
        speaker: speakerLabel(message, partnerLabel),
        text: message.text,
      })),
    [messages, partnerLabel],
  );

  const latestPartnerText = useMemo(() => {
    const last = [...messages].reverse().find((message) => message.sender === 'hospital');
    return last?.text ?? null;
  }, [messages]);

  const handleStartCall = () => {
    if (!intent.trim()) return;
    if (!channel.send({ type: 'start_call', intent, purpose, partnerName: partnerName.trim() })) {
      setCallNotice('サーバーに接続できていないため、発信できませんでした。');
      return;
    }
    setCallNotice(null);
    setCallState('ringing');
  };

  /** 本人が確定した文を送る唯一の経路。textは書き換えずにそのまま渡す。 */
  const sendConfirmedSpeech = (text: string, origin: SpeechOrigin): boolean => {
    if (!channel.send({ type: 'patient_confirmed_speech', text, origin })) {
      setSendError('サーバーに接続できていないため、送信できませんでした。');
      return false;
    }
    setSendError(null);
    clearIdleTimer();
    setSuggestions([]);
    setSuggestionsAi(null);
    setIsGenerating(false);
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

    polishRequestIdRef.current += 1;
    const requestId = String(polishRequestIdRef.current);
    if (!channel.send({ type: 'patient_polish_request', requestId, text: original })) {
      setSendError('サーバーに接続できていないため、AIに依頼できませんでした。');
      return;
    }
    setSendError(null);
    dispatchComposer({ type: 'request', requestId, original });
  };

  const handleReviewSend = (choice: SpeechChoice) => {
    if (isHospitalSpeaking) return;
    const speech = resolveConfirmedSpeech(composer, choice);
    if (speech && sendConfirmedSpeech(speech.text, speech.origin)) {
      dispatchComposer({ type: 'close' });
      setPatientInput('');
    }
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 日本語IMEの変換確定で発火させない。Safariは確定直後のEnterを keyCode 229 で送る。
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
    // 改行は読み上げに意味がないので入れない。
    event.preventDefault();
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

  /** 定型の返事を送る。ボタンの文がそのまま読み上げられる。 */
  const handleSendQuickPhrase = (text: string) => {
    if (isHospitalSpeaking) return;
    if (sendConfirmedSpeech(text, 'quick_phrase')) {
      dispatchComposer({ type: 'close' });
    }
  };

  const handleEndCall = () => {
    if (!channel.send({ type: 'end_call' })) {
      setSendError('サーバーに接続できていないため、通話を終了できませんでした。');
      return;
    }
    setCallState('analyzing');
    clearIdleTimer();
    dispatchComposer({ type: 'close' });
  };

  /** この通話だけを閉じる。ほかの通話には届かない。 */
  const handleResetCall = () => {
    channel.send({ type: 'reset_call' });
    channel.forgetSeat();
    setCallNotice(null);
    resetLocalCall();
  };

  /**
   * 見出しのリセット。通話中は会話の記録が消え、相手との通話も切れるので、確かめてから行う。
   * 「通話を終了」の隣にあり、手の動きに制約がある人の押し間違いを防ぐ。
   */
  const handleHeaderReset = () => {
    const losesConversation = callState === 'connected' || callState === 'analyzing';
    if (
      losesConversation &&
      !window.confirm('この通話をリセットしますか？\n相手との通話が切れ、会話の記録と予定の下書きは残りません。')
    ) {
      return;
    }
    handleResetCall();
  };

  const connectionNotice = !isConnected && callState !== 'idle'
    ? RECONNECTING_NOTICE
    : callState === 'connected' && !peerConnected
    ? PEER_DISCONNECTED_NOTICE
    : null;

  const status = describeCallStatus(callState, isConnected, peerConnected, isHospitalSpeaking);
  const isInCall = callState === 'connected';
  const bannerText = connectionNotice ?? callNotice;
  const hasNotices = speechStatus === 'unavailable' || Boolean(bannerText);

  return (
    <div className="flex h-dvh flex-col bg-canvas">
      <AppHeader
        compactOnMobile={isInCall}
        status={
          callState === 'idle' ? undefined : (
            <CallStatus
              tone={status.tone}
              label={status.label}
              detail={partnerName.trim() ? `${partnerName.trim()}との通話` : undefined}
            />
          )
        }
        actions={
          <>
            <AiStatusBadge status={aiStatus} last={lastAi} />
            {callState !== 'idle' && (
              <button
                type="button"
                onClick={handleHeaderReset}
                aria-label="この通話をリセット"
                title="この通話だけを終了して最初の画面に戻ります。記録は残りません"
                className={buttonClass('quiet', 'md', 'max-sm:px-3')}
              >
                <RotateCcw className="size-4" aria-hidden />
                <span className="max-sm:hidden">リセット</span>
              </button>
            )}
            {isInCall && (
              <button
                type="button"
                onClick={handleEndCall}
                aria-label="通話を終了"
                className={buttonClass('danger', 'md', 'max-sm:px-3')}
              >
                <PhoneOff className="size-4" aria-hidden />
                <span>
                  <span className="max-sm:hidden">通話を</span>終了
                </span>
              </button>
            )}
          </>
        }
      />

      {hasNotices && (
        <div className="border-b border-line bg-surface">
          <div className="mx-auto max-w-[1440px] space-y-2 px-4 py-2.5 lg:px-6">
            <SpeechUnavailableNotice status={speechStatus} />
            <CallNotice text={bannerText} />
          </div>
        </div>
      )}

      <main className="min-h-0 flex-1">
        {callState === 'idle' && (
          <div className="h-full overflow-y-auto">
            <div className="mx-auto grid w-full max-w-5xl gap-8 px-4 py-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-12 lg:py-12">
              <CallSetupForm
                purpose={purpose}
                partnerName={partnerName}
                intent={intent}
                isConnected={isConnected}
                onPurposeChange={setPurpose}
                onPartnerNameChange={setPartnerName}
                onIntentChange={setIntent}
                onStart={handleStartCall}
              />
              <div className="lg:pt-14">
                <CallFlowGuide />
              </div>
            </div>
          </div>
        )}

        {callState === 'ringing' && (
          <div className="h-full overflow-y-auto">
            <div className="mx-auto w-full max-w-xl px-4 py-8 lg:py-12">
              <CallInviteCard
                invite={invite}
                peerConnected={peerConnected}
                partnerLabel={partnerLabel}
                onCancel={handleResetCall}
              />
            </div>
          </div>
        )}

        {isInCall && (
          <div className="mx-auto flex h-full max-w-[1440px] flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(26rem,34rem)]">
            <section aria-label="会話" className="min-h-0 flex-1 lg:border-r lg:border-line">
              <ConversationLog
                messages={messages}
                playback={playback}
                partnerLabel={partnerLabel}
                isPartnerSpeaking={isHospitalSpeaking}
                liveText={liveHospitalText}
              />
            </section>
            <section
              aria-label="返答"
              className="max-h-[58%] shrink-0 overflow-y-auto border-t border-line bg-surface px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] lg:max-h-none lg:border-t-0 lg:px-6 lg:py-6"
            >
              <ReplyPanel
                partnerLabel={partnerLabel}
                latestPartnerText={latestPartnerText}
                isPartnerSpeaking={isHospitalSpeaking}
                isGenerating={isGenerating}
                suggestions={suggestions}
                suggestionsAi={suggestionsAi}
                composer={composer}
                input={patientInput}
                sendError={sendError}
                onInputChange={setPatientInput}
                onInputKeyDown={handleInputKeyDown}
                onRequestPolish={handleRequestPolish}
                onCancelPolish={() => dispatchComposer({ type: 'close' })}
                onSendTyped={handleSendTyped}
                onSendSuggestion={handleSendSuggestion}
                onSendQuickPhrase={handleSendQuickPhrase}
                onEditDraft={(draft) => dispatchComposer({ type: 'edit_draft', draft })}
                onReviewSend={handleReviewSend}
                onCloseReview={() => dispatchComposer({ type: 'close' })}
              />
            </section>
          </div>
        )}

        {callState === 'analyzing' && (
          <div className="h-full overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-12" aria-live="polite">
              <h1 className="text-[26px] font-bold leading-snug">通話を終了しました</h1>
              <p className="flex items-center gap-2 text-[15px] text-ink-2">
                <span aria-hidden className="eb-live-dot size-2 rounded-full bg-voice" />
                会話の内容から予定を探しています。結果は追加する前に確認できます。
              </p>
            </div>
          </div>
        )}

        {callState === 'summary' && appointmentResult && (
          <div className="h-full overflow-y-auto">
            <CallSummary
              result={appointmentResult}
              partnerLabel={partnerLabel}
              transcript={transcript}
              onBack={handleResetCall}
            />
          </div>
        )}
      </main>
    </div>
  );
}

function describeCallStatus(
  callState: PatientCallState,
  isConnected: boolean,
  peerConnected: boolean,
  isPartnerSpeaking: boolean,
): { tone: CallStatusTone; label: string } {
  if (!isConnected) return { tone: 'warning', label: '再接続中' };
  switch (callState) {
    case 'ringing':
      return { tone: 'waiting', label: peerConnected ? '応答待ち' : '参加待ち' };
    case 'connected':
      if (!peerConnected) return { tone: 'warning', label: '相手の接続待ち' };
      return { tone: 'live', label: isPartnerSpeaking ? '相手が発話中' : '通話中' };
    case 'analyzing':
      return { tone: 'ended', label: '終了処理中' };
    case 'summary':
      return { tone: 'ended', label: '通話終了' };
    default:
      return { tone: 'idle', label: '準備' };
  }
}
