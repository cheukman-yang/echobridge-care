"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CalendarCheck,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  MapPin,
  Mic,
  Navigation,
  PhoneCall,
  PhoneOff,
  RotateCcw,
  Send,
  Square,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useUserLanguage } from '@/contexts/UserLanguageContext';
import type { AiMeta } from '@/lib/aiMeta';
import {
  buildMapsDirectionsUrl,
  buildMapsSearchUrl,
  resolveClinicMapQuery,
} from '@/lib/appointment';
import { MAX_PATIENT_TEXT_LENGTH, buildGreeting } from '@/lib/callProtocol';
import type { AppointmentResult, SpeechVoice, SuggestionItem } from '@/lib/callProtocol';
import {
  isBrowserSpeechRecognitionSupported,
  speakCareText,
  startBrowserSpeechRecognition,
  stopCareSpeech,
} from '@/lib/careSpeech';
import type { BrowserSpeechSession } from '@/lib/careSpeech';
import { createReservationId, saveReservationRecord } from '@/lib/careStorage';
import { CONSULT_PATH, SANDBOX_CLINIC } from '@/lib/careTypes';
import type {
  ClinicCandidate,
  SandboxReceptionResponse,
  SandboxTurn,
} from '@/lib/careTypes';
import { requestDraftPolish } from '@/lib/draftPolish';
import { requestConsultReset, requestHomeHubReset } from '@/lib/homeReset';
import { SANDBOX_QUICK_PHRASES } from '@/lib/i18n';
import type { UserLanguage } from '@/lib/userLanguage';
import { AppointmentReviewCard } from './AppointmentReviewCard';
import { CareAiModeBadge } from './CareAiModeBadge';
import { useCareCustomPhrases } from './CustomPhrases';
import { LocalStorageBadge } from './LocalStorageBadge';
import { QuickPhraseRail } from './QuickPhraseRail';
import { Notice, SectionHeading, actionCueClass, buttonClass, cx } from './ui';

interface SandboxCallViewProps {
  intent: string;
  voice: SpeechVoice;
  onExit: () => void;
  clinic?: ClinicCandidate;
  symptomsMemo?: string;
  preferredSlots?: string[];
  departmentLabel?: string;
  originLocation?: string;
  onAiMeta?: (ai: AiMeta) => void;
}

function hasJapaneseCharacters(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
}

/**
 * 通信失敗時でも予約通話が決して止まらないようにするクライアント側ローカルフォールバック応答。
 */
function buildClientFallbackReception(
  historySnapshot: readonly SandboxTurn[],
  userLanguage: UserLanguage,
): SandboxReceptionResponse {
  const receptionistCount = historySnapshot.filter((t) => t.sender === 'receptionist').length;
  const isEn = userLanguage === 'en';
  const fallbackAi: AiMeta = { source: 'fallback', reason: 'not_configured' };

  if (receptionistCount === 0) {
    return {
      receptionistJa:
        'お電話ありがとうございます。EchoBridge Care 模擬クリニックでございます。初診のご予約ですね。明日の午前10時30分、または午後2時30分に空きがございますが、ご都合はいかがでしょうか？',
      receptionistEn:
        'Thank you for calling EchoBridge Care Mock Clinic. For your first visit, we have openings tomorrow at 10:30 AM or 2:30 PM. Which works better for you?',
      isReservationConfirmed: false,
      suggestions: isEn
        ? [
            {
              text: '明日の午前10時30分でお願いいたします。',
              displayText: 'Tomorrow at 10:30 AM works for me, please.',
              tag: '10:30 AM',
            },
            {
              text: '明日の午後2時30分でお願いいたします。',
              displayText: 'Tomorrow at 2:30 PM, please.',
              tag: '2:30 PM',
            },
            {
              text: '本日の夕方に空きはございますでしょうか？',
              displayText: 'Do you have any slots late this afternoon?',
              tag: 'Today PM',
            },
          ]
        : [
            {
              text: '明日の午前10時30分でお願いいたします。',
              displayText: '明日の午前10時30分でお願いいたします。',
              tag: '午前10時半',
            },
            {
              text: '明日の午後2時30分でお願いいたします。',
              displayText: '明日の午後2時30分でお願いいたします。',
              tag: '午後2時半',
            },
            {
              text: '本日の午後に空きはございますでしょうか？',
              displayText: '本日の午後に空きはございますでしょうか？',
              tag: '本日確認',
            },
          ],
      ai: fallbackAi,
    };
  }

  if (receptionistCount === 1) {
    return {
      receptionistJa:
        'かしこまりました。ご希望の日時でご予約をお取りいたします。当日はマイナンバーカード（または健康保険資格確認書・パスポート等）とお薬手帳をお持ちください。',
      receptionistEn:
        'Certainly, we have reserved that time slot for you. Please bring your health insurance card / ID and current medication list on the day.',
      isReservationConfirmed: false,
      suggestions: isEn
        ? [
            {
              text: '承知いたしました。持ち物を持って伺います。',
              displayText: 'Understood. I will bring those items with me.',
              tag: 'Confirm',
            },
            {
              text: 'クリニックの住所を教えていただけますか？',
              displayText: 'Could you confirm the clinic address?',
              tag: 'Address',
            },
            {
              text: '予約時間の何分前に伺えばよろしいでしょうか？',
              displayText: 'How many minutes early should I arrive?',
              tag: 'Arrival time',
            },
          ]
        : [
            {
              text: '承知いたしました。持ち物を持って伺います。',
              displayText: '承知いたしました。持ち物を持って伺います。',
              tag: '持ち物了解',
            },
            {
              text: 'クリニックの詳しい場所を教えていただけますか？',
              displayText: 'クリニックの詳しい場所を教えていただけますか？',
              tag: '場所確認',
            },
            {
              text: '何分前に受付へ伺えばよろしいでしょうか？',
              displayText: '何分前に受付へ伺えばよろしいでしょうか？',
              tag: '受付時間',
            },
          ],
      ai: fallbackAi,
    };
  }

  return {
    receptionistJa:
      'ご予約が完了いたしました。当院は東京都千代田区丸の内1-9-1 丸の内メディカルプラザ3階でございます。お気をつけてお越しくださいませ。',
    receptionistEn:
      'Your appointment is confirmed! We are on the 3rd floor of Marunouchi Medical Plaza, 1-9-1 Marunouchi, Chiyoda-ku, Tokyo. Please take care.',
    isReservationConfirmed: true,
    suggestions: isEn
      ? [
          {
            text: 'ありがとうございます。明日よろしくお願いいたします。',
            displayText: 'Thank you very much. See you tomorrow.',
            tag: 'Thanks',
          },
          {
            text: '場所を確認して伺います。失礼いたします。',
            displayText: 'I will check the map and head over. Goodbye.',
            tag: 'Close',
          },
          {
            text: '丁寧にご案内いただき助かりました。ありがとうございます。',
            displayText: 'Thank you for your kind assistance.',
            tag: 'Gratitude',
          },
        ]
      : [
          {
            text: 'ありがとうございます。明日よろしくお願いいたします。',
            displayText: 'ありがとうございます。明日よろしくお願いいたします。',
            tag: 'お礼・終了',
          },
          {
            text: '場所を確認して伺います。失礼いたします。',
            displayText: '場所を確認して伺います。失礼いたします。',
            tag: '了解',
          },
          {
            text: '丁寧にご対応いただきありがとうございます。',
            displayText: '丁寧にご対応いただきありがとうございます。',
            tag: '感謝',
          },
        ],
    ai: fallbackAi,
  };
}

/**
 * 審査・検証用「EchoBridge Care 模擬クリニック」（および参考クリニックのAI予約シミュレーション）の
 * ブラウザ完結AI受付ボット予約通話画面。
 * 実在の医療機関には一切電話を発信せず、日本語音声合成TTS＋文字表示で予約通話を完走できる。
 */
export function SandboxCallView({
  intent,
  voice,
  onExit,
  clinic,
  symptomsMemo,
  preferredSlots,
  departmentLabel,
  originLocation,
  onAiMeta,
}: SandboxCallViewProps) {
  const { userLanguage } = useUserLanguage();
  const isEn = userLanguage === 'en';
  const activeClinic = clinic ?? SANDBOX_CLINIC;
  const customPhrases = useCareCustomPhrases();
  const standardQuickPhrases = SANDBOX_QUICK_PHRASES[userLanguage];

  const [phase, setPhase] = useState<'in_call' | 'summarizing' | 'completed'>('in_call');
  const [completedPage, setCompletedPage] = useState<1 | 2>(1);
  const [isDialing, setIsDialing] = useState<boolean>(() => process.env.NODE_ENV !== 'test');
  const [turns, setTurns] = useState<SandboxTurn[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([]);
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  const [isBotThinking, setIsBotThinking] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [isReservationConfirmed, setIsReservationConfirmed] = useState(false);
  const [isSavedPhrasesOpen, setIsSavedPhrasesOpen] = useState(false);
  const [inputText, setInputText] = useState('');
  const [isVoiceRecording, setIsVoiceRecording] = useState(false);
  const [voiceUnsupportedNotice, setVoiceUnsupportedNotice] = useState<string | null>(null);
  const [isPolishing, setIsPolishing] = useState(false);
  const [appointmentResult, setAppointmentResult] = useState<AppointmentResult | null>(null);
  const [savedReservationLocally, setSavedReservationLocally] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [latestAi, setLatestAi] = useState<AiMeta | null>(null);

  const isMountedRef = useRef(true);
  const bootPromiseRef = useRef<Promise<void> | null>(null);
  const speechSessionRef = useRef<BrowserSpeechSession | null>(null);
  const turnSeqRef = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);
  const onAiMetaRef = useRef(onAiMeta);
  useEffect(() => {
    onAiMetaRef.current = onAiMeta;
  }, [onAiMeta]);

  const reportAiMeta = useCallback((ai: AiMeta | undefined) => {
    if (!ai) return;
    setLatestAi(ai);
    onAiMetaRef.current?.(ai);
  }, []);

  const nextId = () => {
    turnSeqRef.current += 1;
    return `sb-${turnSeqRef.current}`;
  };

  const speakJapanese = useCallback(
    async (textJa: string, speakerVoice: SpeechVoice) => {
      if (!ttsEnabled) return;
      setIsSpeaking(true);
      await speakCareText(textJa, {
        voice: speakerVoice,
        lang: 'ja-JP',
        onEnd: () => {
          if (isMountedRef.current) setIsSpeaking(false);
        },
      });
    },
    [ttsEnabled],
  );

  const fetchReceptionTurn = useCallback(
    async (historySnapshot: SandboxTurn[]) => {
      if (!isMountedRef.current) return;
      setIsBotThinking(true);
      setErrorMessage(null);
      let data: SandboxReceptionResponse;
      try {
        const res = await fetch('/api/sandbox-reception', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'turn',
            intent,
            history: historySnapshot,
            userLanguage,
          }),
        });
        if (!res.ok) throw new Error('sandbox_turn_failed');
        data = (await res.json()) as SandboxReceptionResponse;
      } catch {
        // 通信エラー時も決して停止させず、即座にローカルフォールバック応答へ切り替えて会話を継続する
        data = buildClientFallbackReception(historySnapshot, userLanguage);
      }

      if (!isMountedRef.current) return;
      reportAiMeta(data.ai);
      const botTurn: SandboxTurn = {
        id: nextId(),
        sender: 'receptionist',
        textJa: data.receptionistJa,
        textEn: data.receptionistEn,
      };
      setTurns((prev) => [...prev, botTurn]);
      setSuggestions(data.suggestions);
      setIsSuggestionsOpen(false);
      if (data.isReservationConfirmed) {
        setIsReservationConfirmed(true);
      }
      setIsBotThinking(false);
      void speakJapanese(data.receptionistJa, 'female');
    },
    [intent, reportAiMeta, speakJapanese, userLanguage],
  );

  // React Strict Mode（useEffect二重実行）のクリーンアップで初回接続がキャンセルされない Promise 直列初期化
  useEffect(() => {
    isMountedRef.current = true;

    if (!bootPromiseRef.current) {
      const japaneseIntentForGreeting =
        intent && hasJapaneseCharacters(intent)
          ? intent
          : '昨日の夜から発熱と喉の痛みがあり、初診の予約をお願いしたいです';
      const greetingJa = buildGreeting(japaneseIntentForGreeting, 'medical');
      const openingTurn: SandboxTurn = {
        id: nextId(),
        sender: 'patient',
        textJa: greetingJa,
        textEn: isEn
          ? `(Spoken in polite Japanese): "${intent || 'I would like to book a first-visit appointment.'}"`
          : undefined,
        origin: 'greeting',
      };

      bootPromiseRef.current = (async () => {
        if (process.env.NODE_ENV !== 'test') {
          await new Promise<void>((resolve) => setTimeout(resolve, 800));
        } else {
          await Promise.resolve();
        }
        if (!isMountedRef.current) return;
        setIsDialing(false);
        setTurns([openingTurn]);
        await fetchReceptionTurn([openingTurn]);
      })();
    }

    return () => {
      isMountedRef.current = false;
      speechSessionRef.current?.abort();
      stopCareSpeech();
    };
  }, [fetchReceptionTurn, intent, isEn]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [turns, isBotThinking, isDialing]);

  const handleToggleVoiceInput = () => {
    if (isVoiceRecording) {
      speechSessionRef.current?.stop();
      return;
    }
    if (!isBrowserSpeechRecognitionSupported()) {
      setVoiceUnsupportedNotice(
        isEn
          ? 'Voice input is not supported in this browser. Please type in the box below.'
          : 'このブラウザでは音声認識が利用できません。テキスト入力欄をお使いください。',
      );
      return;
    }
    setVoiceUnsupportedNotice(null);
    setIsVoiceRecording(true);
    const session = startBrowserSpeechRecognition({
      lang: isEn ? 'en-US' : 'ja-JP',
      onInterim: (text) => setInputText(text),
      onFinal: (text) => setInputText(text),
      onError: () => setIsVoiceRecording(false),
      onEnd: () => setIsVoiceRecording(false),
    });
    if (!session) {
      setIsVoiceRecording(false);
      return;
    }
    speechSessionRef.current = session;
  };

  const sendPatientTurn = async (
    textJa: string,
    textEn?: string,
    origin: SandboxTurn['origin'] = 'suggestion',
  ) => {
    if (!textJa.trim() || isBotThinking || isDialing) return;
    const patientTurn: SandboxTurn = {
      id: nextId(),
      sender: 'patient',
      textJa: textJa.trim(),
      textEn,
      origin,
    };
    const updated = [...turns, patientTurn];
    setTurns(updated);
    setSuggestions([]);
    setIsSuggestionsOpen(false);
    setInputText('');

    if (ttsEnabled) {
      await speakCareText(patientTurn.textJa, { voice, lang: 'ja-JP' });
    }
    await fetchReceptionTurn(updated);
  };

  const handleSendSavedCustomPhrase = async (rawPhrase: string) => {
    const cleaned = rawPhrase.trim();
    if (!cleaned || isBotThinking || isDialing || isPolishing) return;
    setIsSavedPhrasesOpen(false);

    if (isEn && !hasJapaneseCharacters(cleaned)) {
      setIsPolishing(true);
      try {
        const res = await fetch('/api/sandbox-reception', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'polish',
            text: cleaned,
            userLanguage,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            japaneseMedicalText: string;
            englishText: string;
            ai?: AiMeta;
          };
          reportAiMeta(data.ai);
          setIsPolishing(false);
          await sendPatientTurn(data.japaneseMedicalText, data.englishText || cleaned, 'quick_phrase');
          return;
        }
      } catch {
        // fallback below
      } finally {
        setIsPolishing(false);
      }
    }

    await sendPatientTurn(cleaned, isEn ? cleaned : undefined, 'quick_phrase');
  };

  /** 下部自由入力欄：[✨ AI整形 / AI Polish]（入力欄のテキストを丁寧な医療表現へ書き換え、編集可能にする） */
  const handleRequestPolish = async () => {
    const raw = inputText.trim();
    if (!raw || isPolishing || isBotThinking || isDialing) return;
    setIsPolishing(true);
    setErrorMessage(null);
    try {
      const { polishedText, aiSource } = await requestDraftPolish({
        text: raw,
        field: 'intent',
        userLanguage,
      });
      reportAiMeta(
        aiSource === 'gemini'
          ? { source: 'gemini', model: 'gemini-2.5-flash' }
          : { source: 'fallback', reason: 'not_configured' },
      );
      if (polishedText) {
        setInputText(polishedText);
      }
    } finally {
      setIsPolishing(false);
    }
  };

  /** 下部自由入力欄：[📤 送信 / Send]（英語入力時は日本語受付表現へ変換して読み上げ送信する） */
  const handleSendTypedInput = async () => {
    const raw = inputText.trim();
    if (!raw || isPolishing || isBotThinking || isDialing) return;
    setErrorMessage(null);

    if (isEn && !hasJapaneseCharacters(raw)) {
      setIsPolishing(true);
      try {
        const res = await fetch('/api/sandbox-reception', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'polish',
            text: raw,
            userLanguage,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            japaneseMedicalText: string;
            englishText: string;
            ai?: AiMeta;
          };
          reportAiMeta(data.ai);
          setIsPolishing(false);
          await sendPatientTurn(
            data.japaneseMedicalText,
            data.englishText || raw,
            'typed',
          );
          return;
        }
      } catch {
        // fallback below
      } finally {
        setIsPolishing(false);
      }
      await sendPatientTurn(raw, raw, 'typed');
      return;
    }

    await sendPatientTurn(raw, undefined, 'typed');
  };

  const persistReservation = (resolved: AppointmentResult) => {
    const persisted = saveReservationRecord({
      id: createReservationId(),
      createdAt: new Date().toISOString(),
      clinicName: activeClinic.name,
      clinicNameEn: activeClinic.nameEn,
      address: resolved.appointment.address || activeClinic.address,
      originLocation: originLocation?.trim() || undefined,
      date: resolved.appointment.date,
      startTime: resolved.appointment.startTime,
      symptomsMemo: symptomsMemo?.trim() || intent.trim(),
      preferredSlots: (preferredSlots ?? []).map((s) => s.trim()).filter(Boolean),
      departmentLabel: departmentLabel?.trim() || activeClinic.departments[0] || '',
      turns,
      userLanguage,
    });
    setSavedReservationLocally(persisted);
  };

  const handleFinishCall = async () => {
    speechSessionRef.current?.abort();
    setIsVoiceRecording(false);
    stopCareSpeech();
    setCompletedPage(1);
    setPhase('summarizing');
    let finalSummary: AppointmentResult;
    try {
      const res = await fetch('/api/sandbox-reception', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'summary',
          intent,
          history: turns,
        }),
      });
      if (!res.ok) throw new Error('summary_failed');
      const summary = (await res.json()) as AppointmentResult;
      finalSummary = {
        ...summary,
        appointment: {
          ...summary.appointment,
          location: activeClinic.name,
          address: activeClinic.address || summary.appointment.address,
        },
      };
    } catch {
      finalSummary = {
        appointment: {
          title: isEn
            ? `First Visit (${activeClinic.nameEn ?? activeClinic.name})`
            : `初診予約（${activeClinic.name}）`,
          date: null,
          startTime: '10:30',
          endTime: '11:00',
          location: isEn && activeClinic.nameEn ? activeClinic.nameEn : activeClinic.name,
          address: activeClinic.address,
          details: isEn
            ? 'Items to bring: Health insurance card / ID, current medication list'
            : '持ち物：マイナンバーカードまたは健康保険資格確認書、お薬手帳',
          aiFields: ['title', 'startTime', 'location', 'address', 'details'],
        },
        ai: { source: 'fallback', reason: 'not_configured' },
      };
    }
    reportAiMeta(finalSummary.ai);
    setAppointmentResult(finalSummary);
    persistReservation(finalSummary);
    setPhase('completed');
  };

  if (phase === 'summarizing') {
    return (
      <div className="mx-auto w-full max-w-md space-y-4 px-4 py-10" aria-live="polite">
        <h1 className="text-[22px] font-bold text-ink">
          {isEn ? 'Preparing Appointment & Directions...' : '予約内容と経路案内を作成中...'}
        </h1>
        <p className="flex items-center gap-2 text-[14px] text-ink-2">
          <LoaderCircle className="size-4 shrink-0 animate-spin text-voice" aria-hidden />
          {isEn
            ? 'Extracting your appointment date, time, and required items from the call.'
            : '模擬クリニックとの通話内容から予約日時・持ち物を整理しています。'}
        </p>
      </div>
    );
  }

  if (phase === 'completed' && appointmentResult) {
    const displayClinicName =
      isEn && activeClinic.nameEn ? activeClinic.nameEn : activeClinic.name;
    const displayAddress =
      isEn && activeClinic.addressEn ? activeClinic.addressEn : activeClinic.address;
    // 架空の模擬クリニック名・ビル名・階数を除去した同一の実在住所・駅ランドマークを両リンクに共通指定
    const mapQuery = resolveClinicMapQuery(
      activeClinic,
      appointmentResult.appointment.address,
    );
    const trimmedOrigin = originLocation?.trim() || '';
    const directionsUrl = buildMapsDirectionsUrl(
      mapQuery,
      trimmedOrigin || undefined,
    );
    const searchUrl = buildMapsSearchUrl(mapQuery);

    return (
      <div className="h-full overflow-y-auto" data-testid="sandbox-call-completed">
        <div className="mx-auto w-full max-w-md space-y-4 px-4 py-5">
          {/* 完了画面2ステップインジケーター */}
          <div className="space-y-2 rounded-xl border border-line bg-surface px-3.5 py-2.5">
            <div className="flex items-center justify-between gap-2">
              {completedPage === 2 ? (
                <button
                  type="button"
                  data-testid="sandbox-completed-back-button"
                  onClick={() => setCompletedPage(1)}
                  className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-line-strong bg-canvas px-2.5 py-1 text-[12px] font-bold text-ink hover:border-voice"
                >
                  <ArrowLeft className="size-3.5 shrink-0" aria-hidden />
                  <span>{isEn ? 'Back to Directions' : '経路案内に戻る'}</span>
                </button>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-voice-soft px-2.5 py-0.5 text-[11px] font-bold text-voice-strong">
                  <Bot className="size-3.5" aria-hidden />
                  {isEn ? 'Call Completed' : '予約通話完了'}
                </span>
              )}
              <div className="flex items-center gap-1.5">
                <span
                  data-testid="sandbox-completed-page-indicator"
                  className="rounded-full bg-voice-soft px-2.5 py-0.5 text-[11px] font-bold text-voice-strong"
                >
                  {isEn ? `Page ${completedPage}/2` : `完了 ${completedPage}/2`}
                </span>
                <CareAiModeBadge ai={latestAi ?? appointmentResult.ai} compact />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5" aria-hidden>
              {[1, 2].map((stepNum) => (
                <span
                  key={stepNum}
                  className={cx(
                    'h-1.5 rounded-full transition-colors',
                    stepNum <= completedPage ? 'bg-voice' : 'bg-line-strong/50',
                  )}
                />
              ))}
            </div>
          </div>

          {completedPage === 1 ? (
            <div className="space-y-4" data-testid="sandbox-completed-page-1">
              <div className="space-y-1">
                <h1 className="text-[21px] font-bold leading-snug text-ink">
                  {isEn ? '1. Clinic Directions & Saved Summary' : '1. 病院への経路案内・予約保存サマリー'}
                </h1>
                <p className="text-[13px] leading-relaxed text-ink-2">
                  {isEn
                    ? 'Your booking details were saved locally on this device. Check directions first, then proceed to Google Calendar registration.'
                    : '予約情報をこの端末（localStorage）に自動保存しました。経路を確認したら、次の画面で Google Calendar 登録と対話ログへ進めます。'}
                </p>
              </div>

              <LocalStorageBadge />

              {savedReservationLocally && (
                <div
                  data-testid="reservation-saved-banner"
                  className="flex items-start gap-2 rounded-xl border border-voice/40 bg-voice-soft px-3.5 py-2.5 text-[13px] font-bold text-voice-strong"
                >
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>
                    {isEn
                      ? 'Appointment record saved on this device (Clinic name, date/time & symptom memo).'
                      : '予約記録（クリニック名・日時・主訴メモ）を端末内に自動保存しました。'}
                  </span>
                </div>
              )}

              {/* Google Maps 経路案内リンク（Directions URL + 任意出発地反映） */}
              <section
                aria-labelledby="sandbox-directions-heading"
                className="space-y-3 rounded-xl border border-voice/40 bg-voice-soft p-4"
              >
                <SectionHeading id="sandbox-directions-heading">
                  {isEn ? 'Google Maps Directions' : '病院への経路案内（Google Maps）'}
                </SectionHeading>
                <div className="space-y-1">
                  <p className="text-[14px] font-bold text-ink">{displayClinicName}</p>
                  <p className="text-[13px] text-ink-2">{displayAddress}</p>
                  <p className="text-[12px] font-bold text-voice-strong" data-testid="directions-origin-label">
                    {isEn
                      ? `Origin: ${trimmedOrigin || 'Current Location'}`
                      : `出発地：${trimmedOrigin || '現在地'}`}
                  </p>
                </div>
                <div className="flex flex-col gap-2">
                  {directionsUrl && (
                    <a
                      href={directionsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="maps-directions-link"
                      className={buttonClass('primary', 'md', 'w-full')}
                    >
                      <Navigation className="size-4 shrink-0" aria-hidden />
                      <span>
                        {isEn
                          ? 'Open Directions in Google Maps'
                          : 'Google Maps で病院への経路案内を開く'}
                      </span>
                    </a>
                  )}
                  {searchUrl && (
                    <a
                      href={searchUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="maps-area-search-link"
                      className={buttonClass('secondary', 'md', 'w-full text-[13px]')}
                    >
                      <MapPin className="size-4 shrink-0" aria-hidden />
                      <span>{isEn ? 'View Area Map' : '周辺地図を確認する'}</span>
                    </a>
                  )}
                </div>
              </section>

              <button
                type="button"
                data-testid="sandbox-completed-next-button"
                onClick={() => setCompletedPage(2)}
                className={buttonClass(
                  'primary',
                  'lg',
                  cx('w-full ring-4 ring-teal-300/60', actionCueClass(true)),
                )}
              >
                <span>
                  {isEn
                    ? '[Next: Proceed to Google Calendar Registration →]'
                    : '[次へ：Google Calendar 予約登録へ進む →]'}
                </span>
                <ArrowRight className="size-5 shrink-0" aria-hidden />
              </button>
            </div>
          ) : (
            <div className="space-y-5" data-testid="sandbox-completed-page-2">
              <div className="space-y-1">
                <h1 className="text-[21px] font-bold leading-snug text-ink">
                  {isEn ? '2. Google Calendar & Call Transcript' : '2. Google Calendar 予約登録・対話ログ'}
                </h1>
                <p className="text-[13px] leading-relaxed text-ink-2">
                  {isEn
                    ? 'Add your appointment to Google Calendar, review the call transcript, or carry your booking straight into Face-to-Face Mode.'
                    : 'Google Calendar への予約登録や通話ログの確認を行い、来院後はそのまま「対面診察モード」へ引き継げます。'}
                </p>
              </div>

              {/* Google Calendar 予約登録プレビュー */}
              <section aria-labelledby="sandbox-calendar-heading" className="space-y-3">
                <SectionHeading id="sandbox-calendar-heading">
                  {isEn ? 'Google Calendar Preview' : 'Google Calendar 予約登録プレビュー'}
                </SectionHeading>
                <AppointmentReviewCard
                  appointment={appointmentResult.appointment}
                  source={{
                    kind: 'ai',
                    model:
                      appointmentResult.ai.source === 'gemini'
                        ? appointmentResult.ai.model
                        : 'sandbox-fallback',
                  }}
                />
              </section>

              {/* 予約通話の対話ログを見る（端末ローカル保存）折りたたみアコーディオン */}
              <details
                data-testid="sandbox-call-transcript-details"
                className="rounded-xl border border-line bg-surface"
              >
                <summary className="flex min-h-11 cursor-pointer items-center justify-between px-4 py-3 text-[14px] font-bold text-ink">
                  <span>
                    {isEn
                      ? 'View Booking Call Transcript (Saved Locally)'
                      : '予約通話の対話ログを見る（端末ローカル保存）'}
                  </span>
                  <span className="shrink-0 font-normal text-ink-2">
                    {isEn ? `${turns.length} turns` : `${turns.length}件`}
                  </span>
                </summary>
                <ol className="space-y-2.5 border-t border-line px-4 py-3 text-[14px]">
                  {turns.map((turn) => {
                    const isReceptionist = turn.sender === 'receptionist';
                    return (
                      <li key={turn.id} className="space-y-0.5">
                        <p className="text-[12px] font-bold text-ink-2">
                          {isReceptionist
                            ? isEn
                              ? 'AI Receptionist'
                              : 'AI模擬受付'
                            : isEn
                            ? 'You (Patient)'
                            : 'あなた（患者）'}
                        </p>
                        <p className="text-ink">{turn.textJa}</p>
                        {turn.textEn && <p className="text-[12px] text-ink-2">🇺🇸 {turn.textEn}</p>}
                      </li>
                    );
                  })}
                </ol>
              </details>

              {/* 最下部：病院到着後の「対面診察モード」シームレス引き継ぎボタン */}
              <section className="space-y-3 rounded-2xl border-2 border-voice bg-voice-soft p-4 shadow-sm">
                <p className="text-[13px] font-bold text-voice-strong">
                  {isEn
                    ? 'Seamless Clinic Arrival Handoff'
                    : '来院後のシームレス引き継ぎ'}
                </p>
                <Link
                  href={CONSULT_PATH}
                  onClick={() => {
                    requestConsultReset();
                    requestHomeHubReset();
                  }}
                  data-testid="handoff-to-consult-link"
                  className={buttonClass(
                    'primary',
                    'lg',
                    cx(
                      'w-full py-3.5 text-center leading-snug ring-4 ring-teal-300/60',
                      actionCueClass(true),
                    ),
                  )}
                >
                  <span>
                    {isEn
                      ? '🩺 Arrived at the Clinic: Open Face-to-Face Mode (Carry Over Booking Info)'
                      : '🩺 病院に着いたら：このまま「対面診察モード」を開く（予約情報を引き継ぐ）'}
                  </span>
                </Link>
              </section>

              <button
                type="button"
                onClick={() => {
                  requestHomeHubReset();
                  onExit();
                }}
                className={buttonClass('secondary', 'md', 'w-full')}
              >
                {isEn ? 'Back to Home Hub' : 'トップ画面に戻る'}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-canvas" data-testid="sandbox-call-view">
      {/* サンドボックス通話ヘッダー帯 */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-voice-soft px-3.5 py-2">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="flex items-center gap-1.5 text-[12px] font-bold text-voice-strong">
              <Bot className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">
                {isEn && activeClinic.nameEn ? activeClinic.nameEn : activeClinic.name}
              </span>
            </p>
            <CareAiModeBadge ai={latestAi} compact />
          </div>
          <p className="text-[11px] text-ink-2">
            {isEn
              ? 'In-browser AI receptionist call (no external phone call placed)'
              : 'ブラウザ内AI模擬受付ボット通話中（外部への電話発信は行いません）'}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              if (ttsEnabled) stopCareSpeech();
              setTtsEnabled((prev) => !prev);
            }}
            aria-pressed={ttsEnabled}
            className={buttonClass('secondary', 'md', 'min-h-9 px-2.5 text-[12px] whitespace-nowrap')}
          >
            {ttsEnabled ? <Volume2 className="size-3.5" aria-hidden /> : <VolumeX className="size-3.5" aria-hidden />}
            <span>{ttsEnabled ? (isEn ? 'TTS ON' : 'TTS音声ON') : isEn ? 'Audio OFF' : '音声OFF'}</span>
          </button>
          <button
            type="button"
            onClick={() => void handleFinishCall()}
            className={buttonClass('danger', 'md', 'min-h-9 px-3 text-[12px] whitespace-nowrap')}
          >
            <PhoneOff className="size-3.5" aria-hidden />
            <span>{isEn ? 'End Call & Review' : '通話終了・予約確認'}</span>
          </button>
        </div>
      </div>

      {/* 対話ログ */}
      <div
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 py-4"
        role="log"
        aria-label={isEn ? 'Mock clinic call transcript' : '模擬クリニック通話ログ'}
      >
        {isDialing && (
          <div
            data-testid="sandbox-dialing-indicator"
            className="flex items-center gap-2.5 rounded-2xl border border-voice/40 bg-voice-soft px-4 py-3 text-[14px] font-bold text-voice-strong"
          >
            <PhoneCall className="size-4 shrink-0 animate-pulse" aria-hidden />
            <span>
              {isEn
                ? 'Dialing & Connecting to AI Receptionist…'
                : '発信・接続中…（模擬クリニック受付へつないでいます）'}
            </span>
          </div>
        )}

        {turns.map((turn) => {
          const isReceptionist = turn.sender === 'receptionist';
          return (
            <div
              key={turn.id}
              className={cx('flex flex-col gap-1', isReceptionist ? 'items-start' : 'items-end')}
            >
              <div className="flex items-center gap-2 px-1 text-[12px] text-ink-2">
                <span className="font-bold text-ink">
                  {isReceptionist
                    ? isEn
                      ? 'AI Receptionist (JP Voice)'
                      : 'AI模擬受付（日本語TTS）'
                    : isEn
                    ? 'You (Patient)'
                    : 'あなた（患者）'}
                </span>
                {isReceptionist && (
                  <button
                    type="button"
                    onClick={() => void speakCareText(turn.textJa, { voice: 'female', lang: 'ja-JP' })}
                    className="inline-flex items-center gap-1 font-bold text-voice-strong hover:underline"
                  >
                    <RotateCcw className="size-3" aria-hidden />
                    {isEn ? 'Replay' : '再生'}
                  </button>
                )}
              </div>
              <div
                className={cx(
                  'max-w-[92%] space-y-1.5 rounded-2xl px-3.5 py-2.5 text-[15px] leading-relaxed',
                  isReceptionist
                    ? 'border border-line-strong bg-surface text-ink'
                    : 'bg-voice text-on-voice',
                )}
              >
                <p className="text-pretty break-words">{turn.textJa}</p>
                {isEn && turn.textEn && (
                  <p
                    className={cx(
                      'border-t pt-1.5 text-[13px] leading-snug',
                      isReceptionist ? 'border-line text-ink-2' : 'border-white/25 text-white/90',
                    )}
                  >
                    🇺🇸 {turn.textEn}
                  </p>
                )}
              </div>
            </div>
          );
        })}

        {isBotThinking && (
          <p className="flex items-center gap-2 rounded-xl bg-subtle px-3.5 py-2.5 text-[13px] text-ink-2">
            <LoaderCircle className="size-4 shrink-0 animate-spin text-voice" aria-hidden />
            {isEn ? 'AI receptionist is preparing a reply...' : 'AI模擬受付が返答を作成しています...'}
          </p>
        )}

        {isReservationConfirmed && (
          <div className="rounded-xl border border-voice bg-voice-soft p-3.5">
            <p className="flex items-center gap-1.5 text-[14px] font-bold text-voice-strong">
              <CalendarCheck className="size-4 shrink-0" aria-hidden />
              {isEn ? 'Appointment details confirmed' : '予約日時の案内が完了しました'}
            </p>
            <p className="mt-1 text-[12px] text-ink-2">
              {isEn
                ? 'Tap below to finish the call, save your booking locally, and view Google Maps & Calendar.'
                : '「通話を終了して予約・経路を確認」を押すと、予約情報を保存して Google Maps 経路案内と Google Calendar 登録画面へ進みます。'}
            </p>
            <button
              type="button"
              onClick={() => void handleFinishCall()}
              className={buttonClass('guidePulse', 'md', 'mt-2.5 w-full text-[14px]')}
            >
              <CalendarCheck className="size-4 shrink-0" aria-hidden />
              <span>
                {isEn
                  ? 'End Call & View Appointment / Directions'
                  : '通話を終了して予約・経路を確認'}
              </span>
            </button>
          </div>
        )}

        {errorMessage && (
          <Notice tone="danger" role="alert">
            {errorMessage}
          </Notice>
        )}
        <div ref={logEndRef} />
      </div>

      {/* 下部：3択回答候補 ＋ 即答フレーズ専用バー＆「📌 登録文（○件）」トグル ＋ 自由入力 */}
      <div className="shrink-0 space-y-2.5 border-t border-line bg-surface px-3.5 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {isSpeaking && (
          <p className="flex items-center gap-1.5 text-[12px] font-bold text-voice-strong">
            <span aria-hidden className="eb-live-dot size-2 rounded-full bg-voice" />
            {isEn ? 'Speaking synthesized Japanese audio...' : '日本語合成音声（TTS）を読み上げ中...'}
          </p>
        )}

        {suggestions.length > 0 && (
          <div
            data-testid="sandbox-suggestions-drawer"
            className="rounded-xl border border-voice/40 bg-voice-soft/50 p-1.5"
          >
            <button
              type="button"
              data-testid="sandbox-toggle-suggestions-button"
              aria-expanded={isSuggestionsOpen}
              disabled={isBotThinking || isDialing}
              onClick={() => setIsSuggestionsOpen((prev) => !prev)}
              className={cx(
                'flex min-h-10 w-full items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-left text-[13px] font-bold transition-all disabled:opacity-50',
                isSuggestionsOpen
                  ? 'border-line-strong bg-surface text-ink hover:border-voice'
                  : 'border-voice bg-voice text-on-voice shadow-xs ring-2 ring-teal-300/60 hover:bg-voice-strong',
                actionCueClass(
                  !isSuggestionsOpen &&
                    suggestions.length > 0 &&
                    !isReservationConfirmed &&
                    !isBotThinking &&
                    !isDialing,
                ),
              )}
            >
              <span>
                {isSuggestionsOpen
                  ? isEn
                    ? `💡 Close AI 3-Choice Replies (${suggestions.length}) ▼`
                    : `💡 AI3択回答候補を閉じる（${suggestions.length}件） ▼`
                  : isEn
                  ? `💡 Open AI 3-Choice Replies (${suggestions.length}) ▲`
                  : `💡 AI3択回答候補を開く（${suggestions.length}件） ▲`}
              </span>
              <span className="shrink-0 text-[11px] font-normal opacity-90">
                {isEn ? 'JP TTS' : '日本語読み上げ'}
              </span>
            </button>

            {isSuggestionsOpen && (
              <div className="grid gap-1.5 pt-1.5" data-testid="sandbox-suggestions">
                {suggestions.map((item, idx) => {
                  const primary = item.displayText ?? item.text;
                  const showSubJa = Boolean(item.displayText && item.displayText !== item.text);
                  return (
                    <button
                      key={`${idx}-${item.text}`}
                      type="button"
                      disabled={isBotThinking || isDialing}
                      onClick={() =>
                        void sendPatientTurn(
                          item.text,
                          isEn ? primary : undefined,
                          'suggestion',
                        )
                      }
                      className="flex w-full flex-col items-start gap-0.5 rounded-xl border border-line-strong bg-surface px-3.5 py-2 text-left transition-colors hover:border-voice hover:bg-voice-soft disabled:opacity-50"
                    >
                      <span className="text-[14px] font-bold leading-snug text-ink">{primary}</span>
                      {showSubJa && (
                        <span className="text-[12px] text-ink-2">
                          🇯🇵 {isEn ? 'Spoken:' : '読み上げ:'} {item.text}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* 常時表示バー（即答フレーズ専用） ＋ 切り替えボタン「📌 登録文（○件）」 */}
        <div className="space-y-1.5" data-testid="sandbox-quick-phrases-bar">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-bold text-ink-2">
              {isEn ? 'Quick Phrases (1-Tap):' : '即答フレーズ（ワンタップ読み上げ）：'}
            </p>
            <button
              type="button"
              data-testid="sandbox-toggle-saved-phrases-button"
              aria-expanded={isSavedPhrasesOpen}
              onClick={() => setIsSavedPhrasesOpen((prev) => !prev)}
              className={cx(
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-bold transition-colors',
                isSavedPhrasesOpen
                  ? 'border-voice bg-voice text-on-voice'
                  : 'border-voice/50 bg-voice-soft text-voice-strong hover:bg-voice hover:text-on-voice',
              )}
            >
              <span>
                {isEn
                  ? `📌 Saved Phrases (${customPhrases.length})`
                  : `📌 登録文（${customPhrases.length}件）`}
              </span>
              {isSavedPhrasesOpen ? (
                <ChevronUp className="size-3 shrink-0" aria-hidden />
              ) : (
                <ChevronDown className="size-3 shrink-0" aria-hidden />
              )}
            </button>
          </div>

          {/* 常時表示バー：標準即答フレーズのみを優先表示（右スワイプ＋右端フェード誘導） */}
          <QuickPhraseRail
            itemCount={standardQuickPhrases.length}
            isEn={isEn}
            testIdPrefix="sandbox-quick-phrases"
          >
            {standardQuickPhrases.map((item) => (
              <button
                key={item.id}
                type="button"
                disabled={isBotThinking || isDialing}
                onClick={() =>
                  void sendPatientTurn(
                    item.textJa,
                    isEn ? item.textEn ?? item.label : undefined,
                    'quick_phrase',
                  )
                }
                className="shrink-0 rounded-full border border-line-strong bg-canvas px-3 py-1 text-[12px] font-bold text-ink transition-colors hover:border-voice hover:bg-voice-soft disabled:opacity-50"
              >
                {item.label}
              </button>
            ))}
          </QuickPhraseRail>

          {/* トグル展開時のみ：登録済みのよく使う文一覧 */}
          {isSavedPhrasesOpen && (
            <div
              data-testid="sandbox-saved-phrases-panel"
              className="max-h-32 space-y-1 overflow-y-auto rounded-xl border border-voice/40 bg-voice-soft/60 p-2"
            >
              {customPhrases.length > 0 ? (
                customPhrases.map((phrase) => (
                  <button
                    key={`saved-${phrase.id}`}
                    type="button"
                    disabled={isBotThinking || isDialing || isPolishing}
                    onClick={() => void handleSendSavedCustomPhrase(phrase.text)}
                    className="flex w-full items-center justify-between gap-2 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-left text-[12px] font-bold text-ink transition-colors hover:border-voice hover:bg-voice-soft disabled:opacity-50"
                  >
                    <span className="line-clamp-2 break-words">{phrase.text}</span>
                    <Send className="size-3.5 shrink-0 text-voice-strong" aria-hidden />
                  </button>
                ))
              ) : (
                <p className="px-1 py-0.5 text-[12px] text-ink-2">
                  {isEn
                    ? 'No saved phrases yet. You can add them in Step 3.'
                    : '登録済みの文はありません（Step 3で登録できます）。'}
                </p>
              )}
            </div>
          )}
        </div>

        {voiceUnsupportedNotice && (
          <div data-testid="sandbox-voice-unsupported-notice">
            <Notice tone="caution" role="status">
              {voiceUnsupportedNotice}
            </Notice>
          </div>
        )}

        <div data-testid="sandbox-active-input-container" className="space-y-1.5">
          {/* 1段目（上段）：テキスト入力欄を横幅いっぱい（w-full）に広く確保 */}
          <input
            id="sandbox-free-input"
            type="text"
            aria-label={isEn ? 'Message for clinic reception' : '受付に伝える内容'}
            value={inputText}
            maxLength={MAX_PATIENT_TEXT_LENGTH}
            onChange={(event) => setInputText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void handleSendTypedInput();
              }
            }}
            placeholder={
              isEn
                ? 'Type or speak — edit after AI Polish, then tap Send'
                : '自由入力・音声入力（「✨ AI整形」で編集、「📤 送信」で伝える）'
            }
            className="min-h-11 w-full rounded-lg border border-line-strong bg-canvas px-3.5 text-[14px] text-ink placeholder:text-ink-2/70 focus:border-voice"
          />

          {/* 2段目（下段）：左から [🎤 音声入力]・[✨ AI整形 / AI Polish]・[📤 送信 / Send] をバランスよく横並び配置 */}
          <div
            data-testid="sandbox-active-action-row"
            className="grid grid-cols-3 gap-1.5"
          >
            <button
              type="button"
              data-testid="sandbox-voice-input-button"
              disabled={isBotThinking || isDialing}
              onClick={handleToggleVoiceInput}
              aria-pressed={isVoiceRecording}
              aria-label={
                isEn
                  ? isVoiceRecording
                    ? 'Stop voice input'
                    : 'Voice input'
                  : isVoiceRecording
                  ? '音声入力を停止'
                  : '音声で入力'
              }
              className={buttonClass(
                isVoiceRecording ? 'danger' : 'secondary',
                'md',
                'min-h-10 w-full px-2 text-[12px] whitespace-nowrap',
              )}
            >
              {isVoiceRecording ? (
                <Square className="size-3.5 shrink-0" aria-hidden />
              ) : (
                <Mic className="size-3.5 shrink-0" aria-hidden />
              )}
              <span>
                {isEn
                  ? isVoiceRecording
                    ? 'Stop'
                    : '🎤 Voice'
                  : isVoiceRecording
                  ? '停止'
                  : '🎤 音声入力'}
              </span>
            </button>

            <button
              type="button"
              data-testid="sandbox-active-polish-button"
              disabled={!inputText.trim() || isPolishing || isBotThinking || isDialing}
              onClick={() => void handleRequestPolish()}
              className={buttonClass(
                'secondary',
                'md',
                'min-h-10 w-full px-2 text-[12px] whitespace-nowrap',
              )}
            >
              {isPolishing && (
                <LoaderCircle className="size-3.5 shrink-0 animate-spin text-voice" aria-hidden />
              )}
              <span>{isEn ? '✨ AI Polish' : '✨ AI整形'}</span>
            </button>

            <button
              type="button"
              data-testid="sandbox-send-button"
              disabled={!inputText.trim() || isPolishing || isBotThinking || isDialing}
              onClick={() => void handleSendTypedInput()}
              className={buttonClass(
                'primary',
                'md',
                'min-h-10 w-full px-2 text-[12px] whitespace-nowrap',
              )}
            >
              <span>{isEn ? '📤 Send' : '📤 送信'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
