"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Globe,
  Home,
  LoaderCircle,
  Mic,
  Send,
  Sparkles,
  Square,
  Stethoscope,
  Trash2,
  Volume2,
  Wand2,
} from 'lucide-react';
import { AppHeader, CallStatus } from '@/components/AppHeader';
import { CareAiModeBadge } from '@/components/CareAiModeBadge';
import { ConsultationSummaryCard } from '@/components/ConsultationSummaryCard';
import { CustomPhrasesSection, useCareCustomPhrases } from '@/components/CustomPhrases';
import { DemoDataNotice } from '@/components/DemoDataNotice';
import { LanguageSelector } from '@/components/LanguageSelector';
import { LocalStorageBadge } from '@/components/LocalStorageBadge';
import { QuickPhraseRail } from '@/components/QuickPhraseRail';
import { Notice, actionCueClass, buttonClass, cx } from '@/components/ui';
import { useUserLanguage } from '@/contexts/UserLanguageContext';
import type { AiMeta } from '@/lib/aiMeta';
import { MAX_PATIENT_TEXT_LENGTH } from '@/lib/callProtocol';
import type { SuggestionItem } from '@/lib/callProtocol';
import {
  isBrowserSpeechRecognitionSupported,
  speakCareText,
  startBrowserSpeechRecognition,
  stopCareSpeech,
} from '@/lib/careSpeech';
import type { BrowserSpeechSession } from '@/lib/careSpeech';
import {
  createConsultationId,
  deleteConsultationRecord,
  deleteReservationRecord,
  getSavedConsultationsSnapshot,
  getSavedReservationsSnapshot,
  getServerSavedConsultationsSnapshot,
  getServerSavedReservationsSnapshot,
  saveConsultationRecord,
  subscribeSavedConsultations,
  subscribeSavedReservations,
} from '@/lib/careStorage';
import { SANDBOX_CLINIC } from '@/lib/careTypes';
import type {
  ConsultLanguagePair,
  ConsultationSummary,
  ConsultationTurn,
  DoctorLanguage,
  SavedConsultationRecord,
  SavedReservationRecord,
} from '@/lib/careTypes';
import { commitPendingCustomPhrase } from '@/lib/customPhrases';
import { requestDraftPolish } from '@/lib/draftPolish';
import {
  HOME_HUB_RESET_HREF,
  consumePendingConsultHandoff,
  getConsultResetSnapshot,
  getServerConsultResetSnapshot,
  requestConsultReset,
  requestHomeHubReset,
  subscribeConsultReset,
} from '@/lib/homeReset';
import {
  CARE_EXAMPLES,
  CONSULT_LANGUAGE_PAIR_OPTIONS,
  CONSULT_QUICK_PHRASES,
} from '@/lib/i18n';
import type { ConsultQuickPhraseItem } from '@/lib/i18n';

type ConsultPhase = 'setup' | 'active' | 'summarizing' | 'summary';

function buildLocalInitialDoctorTurn(
  userLanguage: 'ja' | 'en',
  doctorLanguage: DoctorLanguage,
): { doctorJa: string; doctorEn: string; suggestions: SuggestionItem[]; ai: AiMeta } {
  const isOverseasEnDoctor = doctorLanguage === 'en';
  return {
    doctorJa: '本日はどのような症状でしょうか？いつ頃から始まり、熱は測りましたか？',
    doctorEn:
      'What brings you in today? When did your symptoms start, and have you checked your temperature?',
    suggestions: isOverseasEnDoctor
      ? [
          {
            text: 'My throat has hurt since last night, and I had a 38.0°C fever this morning.',
            displayText: '昨日の夜から喉の痛みがあり、今朝は38.0度の熱がありました。',
            tag: '昨夜・発熱あり',
          },
          {
            text: 'My symptoms started 2 to 3 days ago with mild fatigue.',
            displayText: '2〜3日前から痛みがあり、少しだるさもあります。',
            tag: '数日前から',
          },
          {
            text: 'The pain started this morning, and I have not measured my temperature yet.',
            displayText: '今朝から痛みが出ましたが、熱はまだ測れていません。',
            tag: '今朝・未検温',
          },
        ]
      : userLanguage === 'en'
        ? [
            {
              text: '昨日の夜から喉の痛みがあり、今朝は38.0度の熱がありました。',
              displayText:
                'My throat has hurt since last night, and I had a 38.0°C fever this morning.',
              tag: 'Since last night',
            },
            {
              text: '3日前から症状が続いており、微熱とだるさがあります。',
              displayText: 'Symptoms started 3 days ago with a mild fever and fatigue.',
              tag: '3 days ago',
            },
            {
              text: '痛みは今朝からですが、まだ体温は測れていません。',
              displayText:
                'The pain started this morning, and I have not measured my temperature yet.',
              tag: 'No temp yet',
            },
          ]
        : [
            {
              text: '昨日の夜から喉の痛みがあり、今朝は38.0度の熱がありました。',
              displayText: '昨日の夜から喉の痛みがあり、今朝は38.0度の熱がありました。',
              tag: '昨夜・発熱あり',
            },
            {
              text: '2〜3日前から痛みがあり、少しだるさもあります。',
              displayText: '2〜3日前から痛みがあり、少しだるさもあります。',
              tag: '数日前から',
            },
            {
              text: '今朝から痛みが出ましたが、熱はまだ測れていません。',
              displayText: '今朝から痛みが出ましたが、熱はまだ測れていません。',
              tag: '今朝・未検温',
            },
          ],
    ai: { source: 'fallback', reason: 'not_configured' },
  };
}

export default function FaceToFaceConsultPage() {
  const consultResetGeneration = useSyncExternalStore(
    subscribeConsultReset,
    getConsultResetSnapshot,
    getServerConsultResetSnapshot,
  );

  useEffect(() => {
    const consumeResetParam = () => {
      if (typeof window === 'undefined') return;
      const params = new URLSearchParams(window.location.search);
      if (params.get('reset') === '1') {
        requestConsultReset();
        params.delete('reset');
        const nextQuery = params.toString();
        const cleanUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash}`;
        window.history.replaceState(window.history.state, '', cleanUrl);
      }
    };

    consumeResetParam();
    window.addEventListener('popstate', consumeResetParam);
    return () => {
      window.removeEventListener('popstate', consumeResetParam);
    };
  }, [consultResetGeneration]);

  return <FaceToFaceConsultContent key={consultResetGeneration} />;
}

function FaceToFaceConsultContent() {
  const { userLanguage, setUserLanguage } = useUserLanguage();
  const isEn = userLanguage === 'en';
  const [overseasDoctorEn, setOverseasDoctorEn] = useState(false);

  // アプリ言語選択と自動連動しつつ、海外受診（患者:日本語 ⇄ 医師:English）も選択可能
  const languagePair: ConsultLanguagePair = isEn
    ? 'en_ja'
    : overseasDoctorEn
    ? 'ja_en'
    : 'ja_ja';
  const doctorLanguage: DoctorLanguage = languagePair === 'ja_en' ? 'en' : 'ja';
  const isOverseasEnDoctor = doctorLanguage === 'en';

  // トップ画面の履歴セクションから引き継ぎ指定で遷移してきた場合は初期レンダーで反映して準備 Step 2 へ進める
  const [initialHandoff] = useState(() => consumePendingConsultHandoff());

  const [phase, setPhase] = useState<ConsultPhase>('setup');
  const [setupStep, setSetupStep] = useState<1 | 2>(() => (initialHandoff ? 2 : 1));
  const [clinicName, setClinicName] = useState(
    () => initialHandoff?.clinicName || SANDBOX_CLINIC.name,
  );
  const [clinicAddress, setClinicAddress] = useState(() => {
    if (!initialHandoff) return SANDBOX_CLINIC.address;
    return (
      initialHandoff.clinicAddress ??
      (initialHandoff.clinicName.includes('EchoBridge Care') ? SANDBOX_CLINIC.address : '')
    );
  });
  const [chiefComplaint, setChiefComplaint] = useState(
    () => initialHandoff?.chiefComplaint ?? '',
  );
  const [isPolishingComplaint, setIsPolishingComplaint] = useState(false);
  const [allergyMemo, setAllergyMemo] = useState('');
  const [handoffAppliedId, setHandoffAppliedId] = useState<string | null>(() =>
    initialHandoff ? (initialHandoff.reservationId ?? 'history-handoff') : null,
  );
  const [isStartingConsult, setIsStartingConsult] = useState(false);
  const [lastAiMeta, setLastAiMeta] = useState<AiMeta | null>(null);

  const [turns, setTurns] = useState<ConsultationTurn[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([]);
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  const [patientInput, setPatientInput] = useState('');

  const [isDoctorSimulating, setIsDoctorSimulating] = useState(false);
  const [isPatientPolishing, setIsPatientPolishing] = useState(false);
  const [isSendingToDoctor, setIsSendingToDoctor] = useState(false);
  const [isDoctorRecording, setIsDoctorRecording] = useState(false);
  const [doctorLiveText, setDoctorLiveText] = useState('');
  const [doctorManualOpen, setDoctorManualOpen] = useState(false);
  const [doctorManualText, setDoctorManualText] = useState('');
  const [isPatientRecording, setIsPatientRecording] = useState(false);
  const [isSavedPhrasesOpen, setIsSavedPhrasesOpen] = useState(false);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

  const [summary, setSummary] = useState<ConsultationSummary | null>(null);
  const [savedLocally, setSavedLocally] = useState(true);
  const [viewingSavedRecord, setViewingSavedRecord] = useState<SavedConsultationRecord | null>(null);

  const savedRecords = useSyncExternalStore(
    subscribeSavedConsultations,
    getSavedConsultationsSnapshot,
    getServerSavedConsultationsSnapshot,
  );

  const savedReservations = useSyncExternalStore(
    subscribeSavedReservations,
    getSavedReservationsSnapshot,
    getServerSavedReservationsSnapshot,
  );

  const customPhrases = useCareCustomPhrases();
  const standardQuickPhrases = CONSULT_QUICK_PHRASES[languagePair];

  const doctorSpeechRef = useRef<BrowserSpeechSession | null>(null);
  const patientSpeechRef = useRef<BrowserSpeechSession | null>(null);
  const timelineEndRef = useRef<HTMLDivElement>(null);
  const turnSeqRef = useRef(0);

  useEffect(() => {
    return () => {
      doctorSpeechRef.current?.abort();
      patientSpeechRef.current?.abort();
      stopCareSpeech();
    };
  }, []);

  useEffect(() => {
    if (phase === 'active') {
      timelineEndRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
    }
  }, [phase, turns.length, isDoctorSimulating]);

  const nextTurnId = () => {
    turnSeqRef.current += 1;
    return `ct-${turnSeqRef.current}`;
  };

  const latestPatientTurn = [...turns].reverse().find((t) => t.speaker === 'patient') ?? null;
  const latestDoctorTurn = [...turns].reverse().find((t) => t.speaker === 'doctor') ?? null;

  // 患者が返答を送信した直後（3択候補が空になり、医師の次の発言待ち状態）のときだけワンタップ進行ボタンをハイライト誘導
  const shouldHighlightAdvanceDoctorButton =
    phase === 'active' &&
    !isDoctorSimulating &&
    suggestions.length === 0 &&
    turns.length > 0 &&
    turns[turns.length - 1]?.speaker === 'patient';

  const handleSelectLanguagePair = (pair: ConsultLanguagePair) => {
    if (pair === 'ja_ja') {
      setOverseasDoctorEn(false);
      setUserLanguage('ja');
    } else if (pair === 'en_ja') {
      setOverseasDoctorEn(false);
      setUserLanguage('en');
    } else {
      setOverseasDoctorEn(true);
      setUserLanguage('ja');
    }
  };

  const handleApplyReservationHandoff = (record: SavedReservationRecord) => {
    const resolvedClinic =
      isEn && record.clinicNameEn ? record.clinicNameEn : record.clinicName;
    setClinicName(resolvedClinic);
    setClinicAddress(
      record.address?.trim() ||
        (record.clinicName.includes('EchoBridge Care') ? SANDBOX_CLINIC.address : ''),
    );
    setChiefComplaint(record.symptomsMemo);
    setHandoffAppliedId(record.id);
  };

  const handleFillSample = () => {
    setChiefComplaint(CARE_EXAMPLES[userLanguage].consultChiefComplaint);
    setAllergyMemo(CARE_EXAMPLES[userLanguage].consultAllergyMemo);
  };

  const handlePolishChiefComplaint = async () => {
    if (!chiefComplaint.trim() || isPolishingComplaint) return;
    setIsPolishingComplaint(true);
    try {
      const { polishedText } = await requestDraftPolish({
        text: chiefComplaint,
        field: 'consult_memo',
        userLanguage,
      });
      if (polishedText) setChiefComplaint(polishedText);
    } finally {
      setIsPolishingComplaint(false);
    }
  };

  const buildCombinedInitialNote = (): string => {
    const parts: string[] = [];
    if (chiefComplaint.trim()) parts.push(chiefComplaint.trim());
    if (allergyMemo.trim()) {
      parts.push(
        isEn
          ? `Allergies / Medications: ${allergyMemo.trim()}`
          : `アレルギー・服用薬メモ：${allergyMemo.trim()}`,
      );
    }
    return parts.join(isEn ? ' / ' : '。');
  };

  const speakDoctorTurn = (doctorJa: string, doctorEn: string) => {
    if (isOverseasEnDoctor) {
      void speakCareText(doctorEn || doctorJa, { voice: 'male', lang: 'en-US' });
    } else {
      void speakCareText(doctorJa, { voice: 'male', lang: 'ja-JP' });
    }
  };

  const speakPatientToDoctor = (japaneseText: string, englishText?: string) => {
    if (isOverseasEnDoctor) {
      void speakCareText(englishText || japaneseText, { voice: 'female', lang: 'en-US' });
    } else {
      void speakCareText(japaneseText, { voice: 'female', lang: 'ja-JP' });
    }
  };

  const handleStartConsultation = async () => {
    if (isStartingConsult) return;
    // テキストエリアに入力途中で未確定のまま残っているよく使う文があれば自動的にリストへ保存する
    commitPendingCustomPhrase(userLanguage);
    setIsStartingConsult(true);
    setViewingSavedRecord(null);
    setSummary(null);
    setIsSavedPhrasesOpen(false);
    setErrorNotice(null);
    const initialTurns: ConsultationTurn[] = [];
    const combinedNote = buildCombinedInitialNote();

    try {
      if (combinedNote) {
        let jaText = combinedNote;
        let enText = combinedNote;
        try {
          const res = await fetch('/api/consult', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'patient_polish',
              text: combinedNote,
              history: [],
              userLanguage,
              doctorLanguage,
            }),
          });
          if (res.ok) {
            const data = (await res.json()) as {
              japaneseMedicalText: string;
              englishText: string;
              ai?: AiMeta;
            };
            jaText = data.japaneseMedicalText;
            enText = data.englishText;
            if (data.ai) setLastAiMeta(data.ai);
          }
        } catch {
          // オフライン・失敗時はそのまま初期表示する
        }
        initialTurns.push({
          id: nextTurnId(),
          speaker: 'patient',
          japaneseText: jaText,
          englishText: enText,
          rawInput: combinedNote,
          timestamp: new Date().toISOString(),
        });
      }

      // Step 2 開始直後に最初の医師の問いかけ＋3択回答候補を1ターン自動表示する
      let initialDoctor = buildLocalInitialDoctorTurn(userLanguage, doctorLanguage);
      try {
        const simRes = await fetch('/api/consult', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'simulate_doctor',
            chiefComplaint: combinedNote,
            history: initialTurns,
            userLanguage,
            doctorLanguage,
          }),
        });
        if (simRes.ok) {
          const simData = (await simRes.json()) as {
            doctorJa?: string;
            doctorEn?: string;
            suggestions?: SuggestionItem[];
            ai?: AiMeta;
          };
          if (simData.doctorJa && Array.isArray(simData.suggestions)) {
            initialDoctor = {
              doctorJa: simData.doctorJa,
              doctorEn: simData.doctorEn ?? simData.doctorJa,
              suggestions: simData.suggestions,
              ai: simData.ai ?? initialDoctor.ai,
            };
          }
        }
      } catch {
        // ローカル初期問診をそのまま使用
      }

      setLastAiMeta(initialDoctor.ai);
      initialTurns.push({
        id: nextTurnId(),
        speaker: 'doctor',
        japaneseText: initialDoctor.doctorJa,
        englishText: initialDoctor.doctorEn,
        timestamp: new Date().toISOString(),
      });

      setTurns(initialTurns);
      setSuggestions(initialDoctor.suggestions);
      setIsSuggestionsOpen(false);
      setPhase('active');
      speakDoctorTurn(initialDoctor.doctorJa, initialDoctor.doctorEn);
    } finally {
      setIsStartingConsult(false);
    }
  };

  /** 審査員の一人検証用：[ワンタップで医師の次の質問を進める（審査・デモ用）] */
  const handleSimulateDoctor = async () => {
    if (isDoctorSimulating) return;
    setIsDoctorSimulating(true);
    setIsSuggestionsOpen(false);
    setErrorNotice(null);
    const combinedNote = buildCombinedInitialNote();
    try {
      const res = await fetch('/api/consult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'simulate_doctor',
          chiefComplaint: combinedNote,
          history: turns,
          userLanguage,
          doctorLanguage,
        }),
      });
      if (!res.ok) throw new Error('simulate_failed');
      const data = (await res.json()) as {
        doctorJa?: string;
        doctorEn?: string;
        suggestions?: SuggestionItem[];
        ai?: AiMeta;
      };
      if (!data.doctorJa) throw new Error('invalid_simulate_payload');
      if (data.ai) setLastAiMeta(data.ai);
      const doctorTurn: ConsultationTurn = {
        id: nextTurnId(),
        speaker: 'doctor',
        japaneseText: data.doctorJa,
        englishText: data.doctorEn ?? data.doctorJa,
        timestamp: new Date().toISOString(),
      };
      setTurns((prev) => [...prev, doctorTurn]);
      setSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
      setIsSuggestionsOpen(false);
      speakDoctorTurn(data.doctorJa, data.doctorEn ?? data.doctorJa);
    } catch {
      setErrorNotice(
        isEn
          ? 'Failed to advance doctor question. Please try again.'
          : '医師の質問進行に失敗しました。もう一度お試しください。',
      );
    } finally {
      setIsDoctorSimulating(false);
    }
  };

  /** 医師の音声認識または手入力が確定したとき */
  const submitDoctorSpeech = async (spokenText: string) => {
    const trimmed = spokenText.trim();
    if (!trimmed) return;
    setIsDoctorSimulating(true);
    setIsSuggestionsOpen(false);
    setErrorNotice(null);
    const combinedNote = buildCombinedInitialNote();
    try {
      const res = await fetch('/api/consult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'doctor_speech',
          doctorJapaneseText: trimmed,
          chiefComplaint: combinedNote,
          history: turns,
          userLanguage,
          doctorLanguage,
        }),
      });
      if (!res.ok) throw new Error('doctor_speech_failed');
      const data = (await res.json()) as {
        doctorJa?: string;
        doctorEn?: string;
        suggestions?: SuggestionItem[];
        ai?: AiMeta;
      };
      if (!data.doctorJa) throw new Error('invalid_doctor_speech_payload');
      if (data.ai) setLastAiMeta(data.ai);
      const doctorTurn: ConsultationTurn = {
        id: nextTurnId(),
        speaker: 'doctor',
        japaneseText: data.doctorJa,
        englishText: data.doctorEn ?? data.doctorJa,
        timestamp: new Date().toISOString(),
      };
      setTurns((prev) => [...prev, doctorTurn]);
      setSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
      setIsSuggestionsOpen(false);
    } catch {
      setTurns((prev) => [
        ...prev,
        {
          id: nextTurnId(),
          speaker: 'doctor',
          japaneseText: trimmed,
          englishText: trimmed,
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setIsDoctorSimulating(false);
    }
  };

  /** 医師側Push-to-Talk（押しながら話す / タップ切替） */
  const startDoctorPushToTalk = () => {
    if (isDoctorRecording) {
      doctorSpeechRef.current?.stop();
      return;
    }
    if (!isBrowserSpeechRecognitionSupported()) {
      setDoctorManualOpen(true);
      return;
    }
    setDoctorLiveText('');
    setIsDoctorRecording(true);
    const session = startBrowserSpeechRecognition({
      lang: isOverseasEnDoctor ? 'en-US' : 'ja-JP',
      onInterim: (interim) => setDoctorLiveText(interim),
      onFinal: (finalText) => {
        setDoctorLiveText('');
        void submitDoctorSpeech(finalText);
      },
      onError: () => {
        setIsDoctorRecording(false);
        setDoctorManualOpen(true);
      },
      onEnd: () => {
        setIsDoctorRecording(false);
      },
    });
    if (!session) {
      setIsDoctorRecording(false);
      setDoctorManualOpen(true);
      return;
    }
    doctorSpeechRef.current = session;
  };

  const stopDoctorPushToTalk = () => {
    if (!isDoctorRecording) return;
    doctorSpeechRef.current?.stop();
  };

  /** 患者が3択回答ボタンをタップしたとき */
  const handleSelectSuggestion = (item: SuggestionItem) => {
    setIsSuggestionsOpen(false);
    if (isOverseasEnDoctor) {
      // ja_en モード：displayText が患者向け日本語、text が医師向け英語医療表現
      const jaText = item.displayText ?? item.text;
      const enText = item.text;
      const patientTurn: ConsultationTurn = {
        id: nextTurnId(),
        speaker: 'patient',
        japaneseText: jaText,
        englishText: enText,
        timestamp: new Date().toISOString(),
      };
      setTurns((prev) => [...prev, patientTurn]);
      setSuggestions([]);
      speakPatientToDoctor(jaText, enText);
      return;
    }

    const patientTurn: ConsultationTurn = {
      id: nextTurnId(),
      speaker: 'patient',
      japaneseText: item.text,
      englishText: item.displayText && item.displayText !== item.text ? item.displayText : undefined,
      timestamp: new Date().toISOString(),
    };
    setTurns((prev) => [...prev, patientTurn]);
    setSuggestions([]);
    speakPatientToDoctor(item.text, patientTurn.englishText);
  };

  /** 患者が標準即答フレーズチップをタップしたとき */
  const handleSelectStandardQuickPhrase = (item: ConsultQuickPhraseItem) => {
    const turn: ConsultationTurn = {
      id: nextTurnId(),
      speaker: 'patient',
      japaneseText: item.japaneseText,
      englishText: item.englishText,
      timestamp: new Date().toISOString(),
    };
    setTurns((prev) => [...prev, turn]);
    setSuggestions([]);
    setIsSuggestionsOpen(false);
    speakPatientToDoctor(item.japaneseText, item.englishText);
  };

  /** 患者が登録済みの「よく使う文」をタップしたとき */
  const handleSendCustomPhraseInConsult = async (phraseText: string) => {
    const trimmed = phraseText.trim();
    if (!trimmed || isPatientPolishing || isSendingToDoctor) return;
    setIsSavedPhrasesOpen(false);
    if (isEn || isOverseasEnDoctor) {
      setIsSendingToDoctor(true);
      try {
        const res = await fetch('/api/consult', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'patient_polish',
            text: trimmed,
            history: turns,
            userLanguage,
            doctorLanguage,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            japaneseMedicalText: string;
            englishText: string;
            ai?: AiMeta;
          };
          if (data.ai) setLastAiMeta(data.ai);
          const turn: ConsultationTurn = {
            id: nextTurnId(),
            speaker: 'patient',
            japaneseText: data.japaneseMedicalText,
            englishText: data.englishText,
            rawInput: trimmed,
            timestamp: new Date().toISOString(),
          };
          setTurns((prev) => [...prev, turn]);
          setSuggestions([]);
          setIsSuggestionsOpen(false);
          speakPatientToDoctor(data.japaneseMedicalText, data.englishText);
          return;
        }
      } catch {
        // fallback below
      } finally {
        setIsSendingToDoctor(false);
      }
    }
    const directTurn: ConsultationTurn = {
      id: nextTurnId(),
      speaker: 'patient',
      japaneseText: trimmed,
      englishText: trimmed,
      rawInput: trimmed,
      timestamp: new Date().toISOString(),
    };
    setTurns((prev) => [...prev, directTurn]);
    setSuggestions([]);
    setIsSuggestionsOpen(false);
    speakPatientToDoctor(trimmed, trimmed);
  };

  /** 診察中の下部自由入力欄：[✨ AI整形]（入力欄のテキストを医療表現へ書き換え、編集可能にする） */
  const handlePolishActivePatientInput = async () => {
    const raw = patientInput.trim();
    if (!raw || isPatientPolishing || isSendingToDoctor) return;
    setIsPatientPolishing(true);
    setErrorNotice(null);
    try {
      const { polishedText, aiSource } = await requestDraftPolish({
        text: raw,
        field: 'consult_memo',
        userLanguage,
      });
      setLastAiMeta(
        aiSource === 'gemini'
          ? { source: 'gemini', model: 'gemini-2.5-flash' }
          : { source: 'fallback', reason: 'not_configured' },
      );
      if (polishedText) setPatientInput(polishedText);
    } finally {
      setIsPatientPolishing(false);
    }
  };

  /** 診察中の下部自由入力欄：[📤 医師へ表示]（入力欄のテキストを確定して上部180度画面へ表示） */
  const handleSendPatientInput = async () => {
    const raw = patientInput.trim();
    if (!raw || isSendingToDoctor || isPatientPolishing) return;
    setErrorNotice(null);

    // 国内受診（日本語 ⇄ 日本語）では、AI整形後にユーザーが微調整した文面をそのまま上部180度画面に表示する
    if (!isEn && !isOverseasEnDoctor) {
      const directTurn: ConsultationTurn = {
        id: nextTurnId(),
        speaker: 'patient',
        japaneseText: raw,
        englishText: raw,
        rawInput: raw,
        timestamp: new Date().toISOString(),
      };
      setTurns((prev) => [...prev, directTurn]);
      setPatientInput('');
      setSuggestions([]);
      setIsSuggestionsOpen(false);
      speakPatientToDoctor(raw, raw);
      return;
    }

    // 異言語ペア（EN ⇄ JA または JA ⇄ EN）では医師側の言語へ翻訳して表示する
    setIsSendingToDoctor(true);
    try {
      const res = await fetch('/api/consult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'patient_polish',
          text: raw,
          history: turns,
          userLanguage,
          doctorLanguage,
        }),
      });
      if (!res.ok) throw new Error('patient_polish_failed');
      const data = (await res.json()) as {
        japaneseMedicalText: string;
        englishText: string;
        ai?: AiMeta;
      };
      if (data.ai) setLastAiMeta(data.ai);
      const patientTurn: ConsultationTurn = {
        id: nextTurnId(),
        speaker: 'patient',
        japaneseText: data.japaneseMedicalText,
        englishText: data.englishText,
        rawInput: raw,
        timestamp: new Date().toISOString(),
      };
      setTurns((prev) => [...prev, patientTurn]);
      setPatientInput('');
      setSuggestions([]);
      setIsSuggestionsOpen(false);
      speakPatientToDoctor(data.japaneseMedicalText, data.englishText);
    } catch {
      const fallbackTurn: ConsultationTurn = {
        id: nextTurnId(),
        speaker: 'patient',
        japaneseText: raw,
        englishText: raw,
        rawInput: raw,
        timestamp: new Date().toISOString(),
      };
      setTurns((prev) => [...prev, fallbackTurn]);
      setPatientInput('');
      setSuggestions([]);
      setIsSuggestionsOpen(false);
      speakPatientToDoctor(raw, raw);
    } finally {
      setIsSendingToDoctor(false);
    }
  };

  /** 患者用の音声入力ボタン */
  const handleTogglePatientVoiceInput = () => {
    if (isPatientRecording) {
      patientSpeechRef.current?.stop();
      return;
    }
    if (!isBrowserSpeechRecognitionSupported()) {
      setErrorNotice(
        isEn
          ? 'Voice input is not supported in this browser. Please type in the box below.'
          : 'このブラウザでは音声認識が利用できません。テキスト入力欄をお使いください。',
      );
      return;
    }
    setIsPatientRecording(true);
    const session = startBrowserSpeechRecognition({
      lang: isEn ? 'en-US' : 'ja-JP',
      onInterim: (text) => setPatientInput(text),
      onFinal: (text) => setPatientInput(text),
      onError: () => setIsPatientRecording(false),
      onEnd: () => setIsPatientRecording(false),
    });
    if (!session) {
      setIsPatientRecording(false);
      return;
    }
    patientSpeechRef.current = session;
  };

  /** 診察終了：Gemini構造化要約＋再診日抽出＋localStorageのみ保存 */
  const handleEndConsultation = async () => {
    stopCareSpeech();
    doctorSpeechRef.current?.abort();
    patientSpeechRef.current?.abort();
    setPhase('summarizing');
    const combinedNote = buildCombinedInitialNote();
    const resolvedClinicName = clinicName.trim() || SANDBOX_CLINIC.name;
    const resolvedClinicAddress = clinicAddress.trim() || undefined;
    try {
      const res = await fetch('/api/consult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'summary',
          turns,
          chiefComplaint: combinedNote,
          clinicName: resolvedClinicName,
          userLanguage,
          doctorLanguage,
        }),
      });
      if (!res.ok) throw new Error('summary_failed');
      const generatedSummary = (await res.json()) as ConsultationSummary;
      setLastAiMeta(generatedSummary.ai);
      setSummary(generatedSummary);

      const record: SavedConsultationRecord = {
        id: createConsultationId(),
        createdAt: new Date().toISOString(),
        clinicName: resolvedClinicName,
        clinicAddress: resolvedClinicAddress,
        userLanguage,
        doctorLanguage,
        turns,
        summary: generatedSummary,
      };
      const persisted = saveConsultationRecord(record);
      setSavedLocally(persisted);
    } catch {
      const fallbackAi: AiMeta = { source: 'fallback', reason: 'unavailable' };
      const complaintJa = combinedNote || latestPatientTurn?.japaneseText || '外来受診相談';
      const complaintEn =
        combinedNote || latestPatientTurn?.englishText || 'Outpatient consultation';
      const fallbackSummary: ConsultationSummary = {
        chiefComplaint: complaintJa,
        chiefComplaintEn: complaintEn,
        diagnosticPoints: [
          `主訴：${complaintJa}`,
          allergyMemo.trim()
            ? `既往・アレルギー：${allergyMemo.trim()}`
            : '所見：診察時の伝達内容を構造化して記録',
        ],
        diagnosticPointsEn: [
          `Chief complaint: ${complaintEn}`,
          allergyMemo.trim()
            ? `Allergies / History: ${allergyMemo.trim()}`
            : 'Findings: Structured clinical notes recorded on device',
        ],
        prescriptionsAndInstructions: [
          '療養指示：安静と十分な水分補給を心がけ、症状悪化時は再受診',
        ],
        prescriptionsAndInstructionsEn: [
          'Care instructions: Rest well, stay hydrated, and return if symptoms worsen',
        ],
        followUp: {
          spokenText: null,
          recommendedDate: null,
          recommendedStartTime: '',
          title: isEn
            ? `Follow-up Visit (${resolvedClinicName})`
            : `再診予定（${resolvedClinicName}）`,
          details: '',
        },
        ai: fallbackAi,
      };
      setLastAiMeta(fallbackAi);
      setSummary(fallbackSummary);
      const persisted = saveConsultationRecord({
        id: createConsultationId(),
        createdAt: new Date().toISOString(),
        clinicName: resolvedClinicName,
        clinicAddress: resolvedClinicAddress,
        userLanguage,
        doctorLanguage,
        turns,
        summary: fallbackSummary,
      });
      setSavedLocally(persisted);
    } finally {
      setPhase('summary');
    }
  };

  const doctorDisplayMessage = latestPatientTurn
    ? isOverseasEnDoctor
      ? latestPatientTurn.englishText || latestPatientTurn.japaneseText
      : latestPatientTurn.japaneseText
    : null;

  return (
    <div className="flex h-dvh flex-col bg-canvas">
      <AppHeader
        compactOnMobile={phase === 'active'}
        slim={phase === 'active'}
        status={
          <div className="flex flex-wrap items-center gap-2">
            {phase === 'active' ? (
              <CallStatus
                tone="live"
                label={isEn ? 'Active · Consult' : '診察中'}
                detail={
                  isOverseasEnDoctor
                    ? '✈️ JA ⇄ Doctor EN'
                    : isEn
                    ? 'Flat 180° UI'
                    : '机上平置きUI'
                }
              />
            ) : phase === 'summarizing' ? (
              <CallStatus tone="waiting" label={isEn ? 'Creating Summary' : '診察要約を作成中'} />
            ) : phase === 'summary' ? (
              <CallStatus tone="ended" label={isEn ? 'Summary Ready' : '診察要約完了'} />
            ) : (
              <CallStatus
                tone="idle"
                label={
                  isEn
                    ? `Prep Step ${setupStep}/2`
                    : `準備 Step ${setupStep}/2`
                }
              />
            )}
            <CareAiModeBadge ai={lastAiMeta} compact />
          </div>
        }
        actions={
          phase === 'active' ? undefined : (
            <Link
              href={HOME_HUB_RESET_HREF}
              onClick={() => {
                requestConsultReset();
                requestHomeHubReset();
              }}
              data-testid="consult-header-home-link"
              className={buttonClass('secondary', 'md', 'px-3 text-[13px] whitespace-nowrap')}
            >
              <Home className="size-4 shrink-0" aria-hidden />
              <span>{isEn ? 'Home' : 'トップへ'}</span>
            </Link>
          )
        }
      />

      {/* 準備2ステップ／診察後要約インジケーター（診察中の集中画面では非表示） */}
      {!viewingSavedRecord && phase !== 'active' && (
        <div className="shrink-0 border-b border-line bg-surface px-4 py-2.5">
          <div className="mx-auto w-full max-w-md space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {phase === 'setup' && setupStep === 2 && (
                  <button
                    type="button"
                    data-testid="consult-setup-back-button"
                    onClick={() => setSetupStep(1)}
                    className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-line-strong bg-canvas px-2.5 py-1 text-[12px] font-bold text-ink hover:border-voice"
                  >
                    <ArrowLeft className="size-3.5" aria-hidden />
                    <span>{isEn ? 'Back' : '戻る'}</span>
                  </button>
                )}
                <span
                  data-testid="consult-step-indicator"
                  className="inline-flex items-center rounded-full bg-voice-soft px-2.5 py-0.5 text-[12px] font-bold text-voice-strong"
                >
                  {phase === 'setup'
                    ? isEn
                      ? `Prep Step ${setupStep}/2`
                      : `準備 Step ${setupStep}/2`
                    : isEn
                    ? 'Summary & Follow-up'
                    : '診察要約・再診登録'}
                </span>
              </div>
              <span className="truncate text-[12px] font-bold text-ink-2">
                {phase === 'setup'
                  ? setupStep === 1
                    ? isEn
                      ? 'Language Pair & Booking'
                      : '対話言語ペア・予約選択'
                    : isEn
                    ? 'Symptoms & Quick Phrases'
                    : '症状メモ・登録文の確認'
                  : isEn
                  ? 'Post-Consultation Summary & Follow-up'
                  : '診察後の構造化要約・再診登録'}
              </span>
            </div>
            {phase === 'setup' && (
              <div className="grid grid-cols-2 gap-1.5" aria-hidden>
                {[1, 2].map((n) => (
                  <span
                    key={n}
                    className={cx(
                      'h-1.5 rounded-full transition-colors',
                      n <= setupStep ? 'bg-voice' : 'bg-line-strong/50',
                    )}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <main className="min-h-0 flex-1">
        {/* ==================== 準備 Step 1/2: 対話言語ペア ＆ 予約記録の選択 ==================== */}
        {phase === 'setup' && setupStep === 1 && !viewingSavedRecord && (
          <div className="h-full overflow-y-auto" data-testid="consult-setup-step-1">
            <div className="mx-auto w-full max-w-md space-y-4 px-4 py-4">
              <div className="space-y-1">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-voice-soft px-2.5 py-0.5 text-[12px] font-bold text-voice-strong">
                  <Stethoscope className="size-3.5" aria-hidden />
                  Face-to-Face Consultation
                </span>
                <h1 className="text-[22px] font-bold leading-snug text-ink">
                  {isEn ? 'Face-to-Face Consultation' : '対面診察モード'}
                </h1>
                <p className="text-[13px] leading-relaxed text-ink-2">
                  {isEn
                    ? 'Place your phone flat on the desk: top 1/3 rotates 180° for the doctor, bottom 2/3 stays upright for you.'
                    : isOverseasEnDoctor
                    ? '海外の英語圏クリニック対応：上部1/3に英語医療表現を医師向け180度反転表示し、下部2/3に日本語訳と3択回答を正立表示します。'
                    : 'スマホを診察机に平置きし、上部1/3を医師向けに上下反転表示、下部2/3をあなた向けに正立表示して双方向対話を支援します。'}
                </p>
              </div>

              {/* 上部：アプリ表示言語切替（🇯🇵 日本語 / 🇺🇸 English） */}
              <LanguageSelector compact />

              {/* 双方向言語モード：対話言語ペア 3択セレクター */}
              <section
                data-testid="consult-language-pair-selector"
                className="space-y-2.5 rounded-2xl border border-line bg-surface p-3.5"
              >
                <div className="space-y-0.5">
                  <p className="flex items-center gap-1.5 text-[14px] font-bold text-ink">
                    <Globe className="size-4 shrink-0 text-voice-strong" aria-hidden />
                    <span>
                      {isEn
                        ? '1. Consultation Language Pair (Patient ⇄ Doctor)'
                        : '1. 対話言語ペア（国内受診・海外受診の双方向切替）'}
                    </span>
                  </p>
                  <p className="text-[12px] text-ink-2">
                    {isEn
                      ? 'Linked to your language above — or choose overseas JA ⇄ EN doctor mode.'
                      : '国内受診の音声・筆談サポートから、海外の英語圏クリニック受診まで切り替えられます。'}
                  </p>
                </div>

                <div
                  role="radiogroup"
                  aria-label={isEn ? 'Consultation Language Pair' : '対話言語ペア'}
                  className="grid gap-2"
                >
                  {CONSULT_LANGUAGE_PAIR_OPTIONS.map((option) => {
                    const checked = languagePair === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        data-testid={`lang-pair-${option.id}`}
                        onClick={() => handleSelectLanguagePair(option.id)}
                        className={cx(
                          'flex w-full flex-col items-start gap-0.5 rounded-xl border-2 px-3.5 py-2 text-left transition-colors',
                          checked
                            ? 'border-voice bg-voice-soft'
                            : 'border-line-strong bg-canvas hover:border-voice/60',
                        )}
                      >
                        <span className="text-[13px] sm:text-[14px] font-bold text-ink">
                          {isEn ? option.labelEn : option.labelJa}
                        </span>
                        <span className="text-[11px] sm:text-[12px] text-ink-2">
                          {isEn ? option.descEn : option.descJa}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* 📋 保存済み予約記録からの引き継ぎ（または予約なしで新規開始） */}
              {savedReservations.length > 0 ? (
                <section
                  data-testid="reservation-handoff-card"
                  className="space-y-2.5 rounded-2xl border-2 border-voice bg-voice-soft p-3.5 shadow-sm"
                >
                  <h2 className="text-[14px] font-bold leading-snug text-voice-strong">
                    {isEn
                      ? '2. 📋 Carry Over from Saved Appointment (Optional)'
                      : '2. 📋 予約済みの診察記録から引き継ぐ（任意・予約なしでも可）'}
                  </h2>

                  <div className="space-y-2">
                    {savedReservations.slice(0, 3).map((rec, index) => {
                      const displayClinic =
                        isEn && rec.clinicNameEn ? rec.clinicNameEn : rec.clinicName;
                      const isApplied = handoffAppliedId === rec.id;
                      return (
                        <div
                          key={rec.id}
                          className="space-y-2 rounded-xl border border-voice/40 bg-surface p-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1 space-y-0.5">
                              <p className="truncate text-[14px] font-bold text-ink">
                                {displayClinic}
                              </p>
                              {(rec.date || rec.startTime) && (
                                <p className="text-[12px] font-medium text-voice-strong">
                                  {isEn ? 'Booked:' : '予約日時:'} {rec.date ?? ''}{' '}
                                  {rec.startTime ?? ''}
                                </p>
                              )}
                              <p className="line-clamp-2 text-[12px] leading-relaxed text-ink-2">
                                {rec.symptomsMemo}
                              </p>
                            </div>
                            <button
                              type="button"
                              aria-label={
                                isEn
                                  ? 'Delete saved booking record'
                                  : 'この予約記録を削除'
                              }
                              onClick={() => deleteReservationRecord(rec.id)}
                              className="rounded-md p-1.5 text-ink-2 hover:bg-danger-soft hover:text-danger-strong"
                            >
                              <Trash2 className="size-4" aria-hidden />
                            </button>
                          </div>

                          <button
                            type="button"
                            data-testid={
                              index === 0
                                ? 'apply-reservation-handoff-button'
                                : `apply-reservation-handoff-${index}`
                            }
                            onClick={() => handleApplyReservationHandoff(rec)}
                            className={buttonClass(
                              isApplied ? 'secondary' : 'accent',
                              'md',
                              cx(
                                'w-full text-[13px]',
                                actionCueClass(index === 0 && !handoffAppliedId),
                              ),
                            )}
                          >
                            <ClipboardPaste className="size-4 shrink-0" aria-hidden />
                            <span>
                              {isApplied
                                ? isEn
                                  ? '✓ Loaded — Tap "Next" Below'
                                  : '✓ 予約情報を読み込みました（下の「次へ進む」へ）'
                                : isEn
                                ? 'Load This Booking in 1 Tap'
                                : '1タップでこの予約情報（病院名・症状）を読み込む'}
                            </span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : (
                <section className="rounded-2xl border border-line bg-surface p-3.5">
                  <p className="text-[13px] font-bold text-ink">
                    {isEn
                      ? '2. Walk-in / No Prior Booking Needed'
                      : '2. 予約なしでそのまま新規開始できます'}
                  </p>
                  <p className="mt-0.5 text-[12px] text-ink-2">
                    {isEn
                      ? 'Proceed to Step 2 to optionally enter a symptom memo or start immediately.'
                      : '飛び込み受診や再診時も、次のステップで症状メモ（任意）を確認してすぐ開始できます。'}
                  </p>
                </section>
              )}

              <LocalStorageBadge />

              <button
                type="button"
                data-testid="consult-setup-next-button"
                onClick={() => setSetupStep(2)}
                className={buttonClass(
                  handoffAppliedId ? 'guidePulse' : 'primary',
                  'lg',
                  cx('w-full', actionCueClass(savedReservations.length === 0 && !handoffAppliedId)),
                )}
              >
                <span>
                  {isEn
                    ? 'Next: Symptoms & Saved Phrases (Step 2/2)'
                    : '次へ進む（症状メモ・登録文の確認へ）'}
                </span>
                <ArrowRight className="size-5 shrink-0" aria-hidden />
              </button>

              {/* 端末ローカル保存済みの診察要約履歴（折りたたみで縦長防止） */}
              {savedRecords.length > 0 && (
                <details className="rounded-xl border border-line bg-surface">
                  <summary className="flex min-h-11 cursor-pointer items-center justify-between px-4 py-2.5 text-[13px] font-bold text-ink">
                    <span>
                      {isEn
                        ? `Saved Consultation Summaries (${savedRecords.length})`
                        : `この端末に保存された診察要約（${savedRecords.length}件）`}
                    </span>
                    <span className="text-[11px] font-normal text-ink-2">localStorage</span>
                  </summary>
                  <ul className="space-y-2 border-t border-line p-3">
                    {savedRecords.map((rec) => (
                      <li
                        key={rec.id}
                        className="flex items-center justify-between gap-2 rounded-lg border border-line bg-canvas px-3 py-2"
                      >
                        <button
                          type="button"
                          onClick={() => setViewingSavedRecord(rec)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <p className="truncate text-[13px] font-bold text-ink">
                            {isEn && rec.summary.chiefComplaintEn
                              ? rec.summary.chiefComplaintEn
                              : rec.summary.chiefComplaint}
                          </p>
                          <p className="truncate text-[11px] text-ink-2">
                            {new Date(rec.createdAt).toLocaleDateString(isEn ? 'en-US' : 'ja-JP')} ・ {rec.clinicName}
                          </p>
                        </button>
                        <button
                          type="button"
                          aria-label={
                            isEn
                              ? 'Delete this record from device'
                              : 'この記録を端末から削除'
                          }
                          onClick={() => deleteConsultationRecord(rec.id)}
                          className="rounded-md p-2 text-ink-2 hover:bg-danger-soft hover:text-danger-strong"
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </div>
        )}

        {/* ==================== 準備 Step 2/2: 症状・アレルギーメモ ＆ 登録文確認 ==================== */}
        {phase === 'setup' && setupStep === 2 && !viewingSavedRecord && (
          <div className="h-full overflow-y-auto" data-testid="consult-setup-step-2">
            <div className="mx-auto w-full max-w-md space-y-4 px-4 py-4">
              <DemoDataNotice side="user" />

              {handoffAppliedId && (
                <p
                  data-testid="consult-handoff-applied-banner"
                  className="flex items-center gap-1.5 rounded-xl border border-voice bg-voice-soft px-3.5 py-2 text-[13px] font-bold text-voice-strong"
                >
                  <CheckCircle2 className="size-4 shrink-0" aria-hidden />
                  <span>
                    {isEn
                      ? 'Booking info carried over (you can edit or add allergies below).'
                      : '予約記録を引き継ぎ済み（下で自由に追記・編集できます）'}
                  </span>
                </p>
              )}

              {/* 症状・アレルギーメモ入力カード */}
              <section
                data-testid="consult-without-reservation-section"
                className="space-y-3.5 rounded-2xl border border-line bg-surface p-4"
              >
                <div className="space-y-0.5">
                  <h1 className="text-[17px] font-bold text-ink">
                    {isEn
                      ? 'Pre-Consultation Symptom & Allergy Memo'
                      : '診察前の症状・アレルギーメモ（任意）'}
                  </h1>
                  <p className="text-[12px] text-ink-2">
                    {isEn
                      ? 'Optional — you can also leave fields blank and start right away.'
                      : '空のままでもすぐ診察を開始できます。審査時は「例を入力」が便利です。'}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label htmlFor="consult-complaint" className="min-w-0 text-[14px] font-bold text-ink">
                      {isEn ? 'Today’s Symptoms / Notes (Optional)' : '最初に医師へ見せる主訴メモ（任意）'}
                    </label>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        data-testid="consult-ai-polish-button"
                        disabled={!chiefComplaint.trim() || isPolishingComplaint}
                        title={
                          !chiefComplaint.trim()
                            ? isEn
                              ? 'Enter your symptoms first to polish with AI'
                              : 'メモを入力するとAIブラッシュアップが使えます'
                            : undefined
                        }
                        onClick={() => void handlePolishChiefComplaint()}
                        className={buttonClass(
                          'secondary',
                          'md',
                          'min-h-9 shrink-0 px-2.5 text-[12px] whitespace-nowrap',
                        )}
                      >
                        {isPolishingComplaint ? (
                          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-voice" aria-hidden />
                        ) : (
                          <Sparkles className="size-3.5 shrink-0 text-voice-strong" aria-hidden />
                        )}
                        <span>
                          {isPolishingComplaint
                            ? isEn
                              ? 'Polishing...'
                              : '整形中...'
                            : isEn
                            ? '✨ AI Polish'
                            : '✨ AIブラッシュアップ'}
                        </span>
                      </button>
                      <button
                        type="button"
                        data-testid="consult-fill-example-button"
                        onClick={handleFillSample}
                        className={buttonClass(
                          'accent',
                          'md',
                          cx(
                            'min-h-9 shrink-0 px-3 text-[12px] whitespace-nowrap',
                            actionCueClass(!chiefComplaint.trim() && !handoffAppliedId),
                          ),
                        )}
                      >
                        <Wand2 className="size-3.5 shrink-0 text-voice-strong" aria-hidden />
                        <span>{isEn ? 'Fill Example' : '例を入力'}</span>
                      </button>
                    </div>
                  </div>
                  <textarea
                    id="consult-complaint"
                    rows={2}
                    value={chiefComplaint}
                    maxLength={MAX_PATIENT_TEXT_LENGTH}
                    onChange={(event) => setChiefComplaint(event.target.value)}
                    placeholder={
                      isEn
                        ? 'e.g., Sore throat and 38.0°C fever since last night'
                        : '例：昨日の夜から喉の痛みがあり、今朝は38.0度の熱がありました'
                    }
                    className="w-full resize-none rounded-lg border border-line-strong bg-canvas px-3 py-2 text-[14px] leading-relaxed text-ink placeholder:text-ink-2/70 focus:border-voice"
                  />
                </div>

                {/* アレルギー・服薬メモ */}
                <label className="block space-y-1">
                  <span className="block text-[13px] font-bold text-ink">
                    {isEn
                      ? 'Allergies & Current Medications (Optional)'
                      : 'アレルギー・服用中のお薬メモ（任意）'}
                  </span>
                  <input
                    type="text"
                    data-testid="consult-allergy-input"
                    value={allergyMemo}
                    maxLength={160}
                    onChange={(event) => setAllergyMemo(event.target.value)}
                    placeholder={
                      isEn
                        ? 'e.g., No drug allergies. Not taking any medications.'
                        : '例：薬・食物アレルギーなし。現在服用中の薬はありません。'
                    }
                    className="min-h-10 w-full rounded-lg border border-line-strong bg-canvas px-3 text-[13px] text-ink placeholder:text-ink-2/70 focus:border-voice"
                  />
                </label>

                {/* 受診先の医療機関名 */}
                <label className="block space-y-1">
                  <span className="block text-[12px] font-bold text-ink-2">
                    {isEn
                      ? 'Clinic Name (for follow-up calendar)'
                      : '受診先の医療機関名（再診カレンダー登録用）'}
                  </span>
                  <input
                    type="text"
                    data-testid="consult-clinic-name-input"
                    value={clinicName}
                    onChange={(event) => {
                      const nextName = event.target.value;
                      setClinicName(nextName);
                      if (!nextName.includes('EchoBridge Care') && clinicAddress === SANDBOX_CLINIC.address) {
                        setClinicAddress('');
                      } else if (nextName.includes('EchoBridge Care') && !clinicAddress.trim()) {
                        setClinicAddress(SANDBOX_CLINIC.address);
                      }
                    }}
                    className="min-h-10 w-full rounded-lg border border-line-strong bg-canvas px-3 text-[13px] text-ink"
                  />
                </label>
              </section>

              {/* 折りたたみ式の「よく使う文の登録・確認（任意）」 */}
              <CustomPhrasesSection mode="setup" prominentConfirm />

              <button
                type="button"
                data-testid="start-consult-button"
                disabled={isStartingConsult}
                onClick={() => void handleStartConsultation()}
                className={buttonClass(
                  'primary',
                  'lg',
                  cx(
                    'w-full ring-4 ring-teal-300/60',
                    actionCueClass(
                      (Boolean(chiefComplaint.trim()) || Boolean(handoffAppliedId)) &&
                        !isStartingConsult,
                    ),
                  ),
                )}
              >
                {isStartingConsult ? (
                  <LoaderCircle className="size-5 shrink-0 animate-spin" aria-hidden />
                ) : (
                  <Stethoscope className="size-5 shrink-0" aria-hidden />
                )}
                <span>
                  {isEn
                    ? '[Start Consultation (Flat-on-Desk 180° UI)]'
                    : '[診察を開始する（机上平置きUIへ）]'}
                </span>
              </button>
            </div>
          </div>
        )}

        {/* 保存済み履歴の閲覧 */}
        {phase === 'setup' && viewingSavedRecord && (
          <div className="h-full overflow-y-auto">
            <ConsultationSummaryCard
              clinicName={viewingSavedRecord.clinicName}
              clinicAddress={viewingSavedRecord.clinicAddress}
              userLanguage={userLanguage}
              doctorLanguage={viewingSavedRecord.doctorLanguage}
              summary={viewingSavedRecord.summary}
              turns={viewingSavedRecord.turns}
              savedLocally={true}
              onStartNew={() => setViewingSavedRecord(null)}
            />
          </div>
        )}

        {/* ==================== Step 2: 診察中（机上平置き・上下反転集中UI） ==================== */}
        {phase === 'active' && (
          <div className="flex h-full flex-col overflow-hidden" data-testid="consult-step-2">
            {/* 上部：医師側エリア（机上平置き時に医師から正立して読めるよう 180度回転・タイムライン優先のコンパクト高さ） */}
            <section
              aria-label={
                isOverseasEnDoctor
                  ? 'Doctor rotated display area in English (180°)'
                  : isEn
                  ? 'Doctor rotated display area (180°)'
                  : '医師側表示エリア（180度回転）'
              }
              data-testid="doctor-rotated-area"
              style={{ transform: 'rotate(180deg)' }}
              className="flex h-[20%] min-h-[96px] max-h-[132px] shrink-0 flex-col justify-between overflow-y-auto border-t-2 border-voice bg-voice-soft px-2.5 py-1"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="rounded-full bg-voice px-2 py-0.5 text-[10px] font-bold text-on-voice">
                  {isOverseasEnDoctor
                    ? 'Doctor View (Patient Message in English)'
                    : `医師側画面（患者からの伝達）${isEn ? ' · Doctor View' : ''}`}
                </span>
                {doctorDisplayMessage && (
                  <button
                    type="button"
                    onClick={() =>
                      speakPatientToDoctor(
                        latestPatientTurn?.japaneseText ?? '',
                        latestPatientTurn?.englishText,
                      )
                    }
                    className="inline-flex items-center gap-1 rounded-md border border-voice/40 bg-surface px-2 py-0.5 text-[10px] font-bold text-voice-strong"
                  >
                    <Volume2 className="size-3" aria-hidden />
                    {isOverseasEnDoctor ? 'Play Audio (EN)' : '音声で聞く'}
                  </button>
                )}
              </div>

              <div className="my-0.5 min-h-0 flex-1 overflow-y-auto rounded-lg border border-voice/30 bg-surface px-2.5 py-1">
                {doctorDisplayMessage ? (
                  <p
                    data-testid="doctor-patient-message"
                    className="text-[15px] sm:text-[16px] font-bold leading-snug text-ink text-pretty break-words"
                  >
                    {doctorDisplayMessage}
                  </p>
                ) : (
                  <p className="text-[12px] leading-snug text-ink-2">
                    {isOverseasEnDoctor
                      ? 'When the patient selects or types a message, clear English medical phrasing will appear here.'
                      : '患者が症状・返答を選ぶと、ここに日本語の医療表現が大きく表示されます。'}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onPointerDown={startDoctorPushToTalk}
                  onPointerUp={stopDoctorPushToTalk}
                  onClick={() => {
                    if (!isBrowserSpeechRecognitionSupported()) {
                      setDoctorManualOpen((prev) => !prev);
                    }
                  }}
                  aria-pressed={isDoctorRecording}
                  className={cx(
                    'flex min-h-8 flex-1 touch-none items-center justify-center gap-1.5 rounded-lg px-2 py-0.5 text-[12px] font-bold transition-colors',
                    isDoctorRecording
                      ? 'bg-danger text-white'
                      : 'bg-voice text-on-voice hover:bg-voice-strong',
                  )}
                >
                  <Mic className="size-3.5 shrink-0" aria-hidden />
                  <span className="truncate">
                    {isDoctorRecording
                      ? isOverseasEnDoctor
                        ? `Listening… ${doctorLiveText || '(Release to send)'}`
                        : `聞き取り中… ${doctorLiveText || '（離すと送信）'}`
                      : isOverseasEnDoctor
                      ? 'Doctor Push-to-Talk (Hold & Speak in English)'
                      : '医師用 Push-to-Talk（押しながら話す）'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setDoctorManualOpen((prev) => !prev)}
                  className="min-h-8 shrink-0 rounded-lg border border-line-strong bg-surface px-2 py-0.5 text-[11px] font-bold text-ink"
                >
                  {isOverseasEnDoctor ? 'Type (EN)' : '手入力'}
                </button>
              </div>
            </section>

            {/* 中央アクションバー：1行横並び（grid-cols-2 gap-2）に圧縮 ＆ 回答送信直後は左ボタンを閃光＋マイクロ振動で誘導 */}
            <div
              data-testid="consult-central-action-bar"
              className="grid shrink-0 grid-cols-2 gap-2 border-y border-line bg-subtle px-2.5 py-1.5"
            >
              <button
                type="button"
                data-testid="simulate-doctor-button"
                data-highlighted={shouldHighlightAdvanceDoctorButton ? 'true' : 'false'}
                disabled={isDoctorSimulating}
                onClick={() => void handleSimulateDoctor()}
                className={buttonClass(
                  shouldHighlightAdvanceDoctorButton ? 'guidePulse' : 'secondary',
                  'md',
                  'min-h-9 w-full px-2 py-1 text-[12px] whitespace-nowrap',
                )}
              >
                {isDoctorSimulating && (
                  <LoaderCircle className="size-3.5 shrink-0 animate-spin text-voice" aria-hidden />
                )}
                <span className="truncate">
                  {isEn ? '🤖 Next Question (Demo)' : '🤖 次の質問(デモ用)'}
                </span>
              </button>

              <button
                type="button"
                data-testid="end-consult-bar-button"
                onClick={() => void handleEndConsultation()}
                className={buttonClass(
                  'danger',
                  'md',
                  'min-h-9 w-full px-2 py-1 text-[12px] whitespace-nowrap',
                )}
              >
                <span className="truncate">
                  {isEn ? '✅ End & Summarize' : '✅ 診察終了・要約へ'}
                </span>
              </button>
            </div>

            {doctorManualOpen && (
              <div className="flex shrink-0 gap-1.5 border-b border-line bg-surface px-3 py-1.5">
                <input
                  type="text"
                  value={doctorManualText}
                  onChange={(event) => setDoctorManualText(event.target.value)}
                  placeholder={
                    isOverseasEnDoctor
                      ? "Type doctor's statement in English to test..."
                      : '医師の発言（日本語）を入力してテスト...'
                  }
                  className="min-h-8 flex-1 rounded-lg border border-line-strong bg-canvas px-2.5 text-[13px] text-ink"
                />
                <button
                  type="button"
                  disabled={!doctorManualText.trim() || isDoctorSimulating}
                  onClick={() => {
                    const text = doctorManualText;
                    setDoctorManualText('');
                    setDoctorManualOpen(false);
                    void submitDoctorSpeech(text);
                  }}
                  className={buttonClass('primary', 'md', 'min-h-8 px-3 text-[12px] whitespace-nowrap')}
                >
                  {isOverseasEnDoctor ? 'Send as Doctor (EN)' : '医師として発言'}
                </button>
              </div>
            )}

            {/* 下部：患者側エリア（正立表示：画面高さの約55〜60%を占める吹き出し会話タイムライン ＋ デフォルト格納1行3択バー ＋ 即答フレーズ＆自由入力） */}
            <section
              aria-label={isEn ? 'Patient upright control area' : '患者側操作エリア（正立表示）'}
              data-testid="patient-upright-area"
              className="flex min-h-0 flex-1 flex-col justify-between bg-canvas"
            >
              {/* LINE/WhatsApp風の吹き出し会話タイムライン（医師＝左寄せ・原文＋翻訳、患者＝右寄せ・直近2〜3往復を常時見渡せる広い領域） */}
              <div
                data-testid="consult-timeline-log"
                role="log"
                aria-label={isEn ? 'Consultation conversation timeline' : '診察の会話タイムライン'}
                className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2.5"
              >
                {errorNotice && (
                  <Notice tone="caution" role="alert">
                    {errorNotice}
                  </Notice>
                )}

                {turns.length === 0 && (
                  <p className="rounded-xl border border-line bg-surface px-3.5 py-3 text-[13px] leading-relaxed text-ink-2">
                    {isEn
                      ? 'Tap "🤖 Next Question (Demo)" above to start the doctor consultation.'
                      : '上の「🤖 次の質問(デモ用)」を押すと問診が進みます。'}
                  </p>
                )}

                {turns.map((turn) => {
                  const isDoctor = turn.speaker === 'doctor';
                  const isLatestDoctor = isDoctor && turn.id === latestDoctorTurn?.id;

                  if (isDoctor) {
                    return (
                      <div
                        key={turn.id}
                        data-testid={`timeline-turn-doctor-${turn.id}`}
                        className="flex flex-col items-start gap-1"
                      >
                        <div className="flex items-center gap-2 px-1">
                          <span
                            data-testid={isLatestDoctor ? 'patient-doctor-box-header' : undefined}
                            className="text-[11px] font-bold text-voice-strong"
                          >
                            {isEn
                              ? "🩺 Doctor's Question (Translated for Patient)"
                              : '🩺 医師からの質問・説明（患者用・翻訳表示）'}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              speakDoctorTurn(
                                turn.japaneseText,
                                turn.englishText ?? turn.japaneseText,
                              )
                            }
                            className="inline-flex items-center gap-1 rounded-full bg-voice-soft px-2 py-0.5 text-[10px] font-bold text-voice-strong hover:bg-voice hover:text-on-voice"
                          >
                            <Volume2 className="size-3" aria-hidden />
                            {isOverseasEnDoctor ? '英語再生' : isEn ? 'Replay' : '読み上げ'}
                          </button>
                        </div>

                        <div
                          data-testid={isLatestDoctor ? 'patient-doctor-transcript' : undefined}
                          className={cx(
                            'max-w-[92%] space-y-1.5 rounded-2xl rounded-tl-xs border bg-surface px-3.5 py-2.5 shadow-xs',
                            isLatestDoctor ? 'border-2 border-voice/50' : 'border-line-strong',
                          )}
                        >
                          {isOverseasEnDoctor ? (
                            <>
                              {turn.englishText && (
                                <p
                                  data-testid={isLatestDoctor ? 'patient-doctor-english' : undefined}
                                  className="text-[13px] font-medium leading-relaxed text-ink-2 text-pretty break-words"
                                >
                                  🇺🇸 {turn.englishText}
                                </p>
                              )}
                              <p
                                data-testid={isLatestDoctor ? 'patient-doctor-japanese' : undefined}
                                className="rounded-xl bg-voice-soft px-3 py-1.5 text-[15px] font-bold leading-relaxed text-voice-strong text-pretty break-words"
                              >
                                🇯🇵 {turn.japaneseText}
                              </p>
                            </>
                          ) : (
                            <>
                              <p className="text-[15px] font-bold leading-relaxed text-ink text-pretty break-words">
                                {turn.japaneseText}
                              </p>
                              {isEn && turn.englishText && (
                                <p
                                  data-testid={isLatestDoctor ? 'patient-doctor-english' : undefined}
                                  className="rounded-xl bg-voice-soft px-3 py-1.5 text-[14px] font-bold leading-relaxed text-voice-strong text-pretty break-words"
                                >
                                  🇺🇸 {turn.englishText}
                                </p>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  }

                  const patientPrimary =
                    isEn && turn.englishText ? turn.englishText : turn.japaneseText;
                  const showDoctorSub =
                    isOverseasEnDoctor
                      ? Boolean(turn.englishText && turn.englishText !== turn.japaneseText)
                      : Boolean(isEn && turn.englishText && turn.englishText !== turn.japaneseText);

                  return (
                    <div
                      key={turn.id}
                      data-testid={`timeline-turn-patient-${turn.id}`}
                      className="flex flex-col items-end gap-0.5"
                    >
                      <span className="px-1 text-[11px] font-bold text-ink-2">
                        {isEn ? '🙋 You (Patient)' : '🙋 あなた（患者）'}
                      </span>
                      <div className="max-w-[88%] space-y-1 rounded-2xl rounded-tr-xs bg-voice px-3.5 py-2 text-on-voice shadow-xs">
                        <p className="text-[14px] font-bold leading-relaxed text-pretty break-words">
                          {patientPrimary}
                        </p>
                        {showDoctorSub && (
                          <p className="border-t border-white/25 pt-1 text-[11px] leading-snug text-white/90 text-pretty break-words">
                            {isOverseasEnDoctor
                              ? `🇺🇸 医師表示 (EN): ${turn.englishText}`
                              : `🇯🇵 Shown to Doctor: ${turn.japaneseText}`}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}

                {isDoctorSimulating && (
                  <div className="flex items-center gap-2 rounded-2xl rounded-tl-xs border border-line bg-surface px-3.5 py-2 text-[12px] text-ink-2">
                    <LoaderCircle className="size-3.5 shrink-0 animate-spin text-voice" aria-hidden />
                    <span>
                      {isEn
                        ? 'Doctor is responding & preparing 3-choice replies...'
                        : '医師の発言と3択回答候補を準備しています...'}
                    </span>
                  </div>
                )}

                <div ref={timelineEndRef} />
              </div>

              {/* 下部固定ドック：デフォルト格納の1行「💡 AI3択回答候補を開く（3件） ▲」バー ＋ 即答フレーズ＆登録文トグル ＋ 自由入力欄 */}
              <div className="shrink-0 border-t border-line bg-surface">
                <div
                  data-testid="consult-suggestions-drawer"
                  className="border-b border-line bg-voice-soft/40 px-3 py-1.5"
                >
                  <button
                    type="button"
                    data-testid="toggle-suggestions-drawer-button"
                    aria-expanded={isSuggestionsOpen}
                    disabled={isDoctorSimulating && !isSuggestionsOpen}
                    onClick={() => setIsSuggestionsOpen((prev) => !prev)}
                    className={cx(
                      'flex min-h-9 w-full items-center justify-between gap-2 rounded-lg border px-3 py-1 text-left text-[12px] sm:text-[13px] font-bold transition-all disabled:opacity-60',
                      isSuggestionsOpen
                        ? 'border-line-strong bg-surface text-ink hover:border-voice'
                        : suggestions.length > 0
                        ? 'border-voice bg-voice text-on-voice shadow-xs ring-2 ring-teal-300/60 hover:bg-voice-strong'
                        : 'border-voice/40 bg-surface text-voice-strong hover:border-voice',
                      actionCueClass(
                        !isSuggestionsOpen && suggestions.length > 0 && !isDoctorSimulating,
                      ),
                    )}
                  >
                    <span data-testid="suggestions-drawer-title" className="truncate">
                      {isDoctorSimulating
                        ? isEn
                          ? '💡 Preparing AI 3-Choice Replies...'
                          : '💡 AI3択回答候補を生成中...'
                        : isSuggestionsOpen
                        ? isEn
                          ? `💡 Close AI 3-Choice Replies (${suggestions.length}) ▼`
                          : `💡 AI3択回答候補を閉じる（${suggestions.length}件） ▼`
                        : suggestions.length > 0
                        ? isEn
                          ? `💡 Open AI 3-Choice Replies (${suggestions.length}) ▲`
                          : `💡 AI3択回答候補を開く（${suggestions.length}件） ▲`
                        : isEn
                        ? '✓ Sent — Tap "🤖 Next Question (Demo)" above'
                        : '✓ 返答送信済み（上の「🤖 次の質問(デモ用)」へ）'}
                    </span>
                  </button>

                  {isSuggestionsOpen && (
                    <div className="max-h-44 overflow-y-auto pt-1.5">
                      {isDoctorSimulating ? (
                        <p className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-[12px] text-ink-2">
                          <LoaderCircle className="size-4 shrink-0 animate-spin text-voice" aria-hidden />
                          {isEn
                            ? 'Preparing 3 context-aware replies...'
                            : '文脈から3択回答を生成しています...'}
                        </p>
                      ) : suggestions.length > 0 ? (
                        <div className="grid gap-1" data-testid="consult-suggestions">
                          {suggestions.map((item, idx) => {
                            const primary = item.displayText ?? item.text;
                            const showDoctorSub = Boolean(
                              item.displayText && item.displayText !== item.text,
                            );
                            return (
                              <button
                                key={`${idx}-${item.text}`}
                                type="button"
                                onClick={() => handleSelectSuggestion(item)}
                                className="flex w-full flex-col items-start gap-0.5 rounded-xl border border-line-strong bg-surface px-3 py-1.5 text-left transition-colors hover:border-voice hover:bg-voice-soft"
                              >
                                <span className="text-[13px] sm:text-[14px] font-bold leading-snug text-ink">
                                  {primary}
                                </span>
                                {showDoctorSub && (
                                  <span className="text-[11px] leading-tight text-ink-2">
                                    {isOverseasEnDoctor
                                      ? `🇺🇸 医師表示 (EN): ${item.text}`
                                      : `🇯🇵 ${isEn ? 'Shown to Doctor:' : '医師表示:'} ${item.text}`}
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="rounded-xl border border-dashed border-voice/60 bg-surface px-3 py-1.5 text-[12px] font-medium text-voice-strong">
                          {isEn
                            ? '✓ Sent to Doctor View. Tap "🤖 Next Question (Demo)" above for the next question.'
                            : '✓ 返答を医師側画面に表示しました。光っている中央バーの「🤖 次の質問(デモ用)」を押すと次の質問へ進みます。'}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* 常時表示バー（即答フレーズ専用）＆「📌 登録文（○件）」トグル ＋ 患者用自由入力欄 */}
                <div className="space-y-1.5 px-3 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
                  <div className="space-y-1" data-testid="consult-quick-phrases-bar">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-bold text-ink-2">
                        {isEn ? 'Quick Phrases (1-Tap):' : '即答フレーズ（ワンタップ伝達）：'}
                      </p>
                      <button
                        type="button"
                        data-testid="consult-toggle-saved-phrases-button"
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

                    {/* 常時表示バー：標準即答フレーズのみを優先表示（右スワイプ・横スクロールインジケーター対応） */}
                    <QuickPhraseRail
                      itemCount={standardQuickPhrases.length}
                      isEn={isEn}
                      testIdPrefix="consult-quick-phrases"
                    >
                      {standardQuickPhrases.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => handleSelectStandardQuickPhrase(item)}
                          className="shrink-0 rounded-full border border-line-strong bg-canvas px-2.5 py-0.5 text-[12px] font-bold text-ink transition-colors hover:border-voice hover:bg-voice-soft"
                        >
                          {item.label}
                        </button>
                      ))}
                    </QuickPhraseRail>

                    {/* トグル展開時のみ：登録済みのよく使う文一覧 */}
                    {isSavedPhrasesOpen && (
                      <div
                        data-testid="consult-saved-phrases-panel"
                        className="max-h-28 space-y-1 overflow-y-auto rounded-xl border border-voice/40 bg-voice-soft/60 p-2"
                      >
                        {customPhrases.length > 0 ? (
                          customPhrases.map((phrase) => (
                            <button
                              key={`saved-${phrase.id}`}
                              type="button"
                              disabled={isPatientPolishing || isSendingToDoctor}
                              onClick={() => void handleSendCustomPhraseInConsult(phrase.text)}
                              className="flex w-full items-center justify-between gap-2 rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-left text-[12px] font-bold text-ink transition-colors hover:border-voice hover:bg-voice-soft disabled:opacity-50"
                            >
                              <span className="line-clamp-2 break-words">{phrase.text}</span>
                              <Send className="size-3.5 shrink-0 text-voice-strong" aria-hidden />
                            </button>
                          ))
                        ) : (
                          <p className="px-1 py-0.5 text-[12px] text-ink-2">
                            {isEn
                              ? 'No saved phrases yet. You can add them in Prep Step 2.'
                              : '登録済みの文はありません（準備 Step 2で登録できます）。'}
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  <div
                    data-testid="consult-active-input-container"
                    className="space-y-1.5"
                  >
                    {/* 1段目（上段）：テキスト入力欄を横幅いっぱい（w-full）に広く確保 */}
                    <input
                      type="text"
                      aria-label={isEn ? 'Message for the doctor' : '医師に伝える内容'}
                      value={patientInput}
                      maxLength={MAX_PATIENT_TEXT_LENGTH}
                      onChange={(event) => setPatientInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          void handleSendPatientInput();
                        }
                      }}
                      placeholder={
                        isOverseasEnDoctor
                          ? '日本語で入力（「✨ AI整形」で編集、「📤 英語で表示」で確定）'
                          : isEn
                          ? 'Type or speak your message — edit after AI Polish, then Show to Doctor'
                          : '症状や質問を入力（「✨ AI整形」で編集、「📤 医師へ表示」で確定）'
                      }
                      className="min-h-10 w-full rounded-lg border border-line-strong bg-canvas px-3 text-[14px] text-ink placeholder:text-ink-2/70 focus:border-voice"
                    />

                    {/* 2段目（下段）：左から [🎤 音声入力]・[✨ AI整形]・[📤 医師へ表示] を横並び配置 */}
                    <div
                      data-testid="consult-active-action-row"
                      className="grid grid-cols-[0.9fr_1fr_1.25fr] gap-1.5 sm:grid-cols-3"
                    >
                      <button
                        type="button"
                        data-testid="consult-voice-input-button"
                        onClick={handleTogglePatientVoiceInput}
                        aria-pressed={isPatientRecording}
                        aria-label={
                          isEn
                            ? isPatientRecording
                              ? 'Stop voice input'
                              : 'Voice input'
                            : isPatientRecording
                            ? '音声入力を停止'
                            : '患者の音声入力'
                        }
                        className={buttonClass(
                          isPatientRecording ? 'danger' : 'secondary',
                          'md',
                          'min-h-10 w-full px-2 text-[12px] whitespace-nowrap',
                        )}
                      >
                        {isPatientRecording ? (
                          <Square className="size-3.5 shrink-0" aria-hidden />
                        ) : (
                          <Mic className="size-3.5 shrink-0" aria-hidden />
                        )}
                        <span>
                          {isEn
                            ? isPatientRecording
                              ? 'Stop'
                              : '🎤 Voice'
                            : isPatientRecording
                            ? '停止'
                            : '🎤 音声入力'}
                        </span>
                      </button>

                      <button
                        type="button"
                        data-testid="consult-active-polish-button"
                        disabled={!patientInput.trim() || isPatientPolishing || isSendingToDoctor}
                        onClick={() => void handlePolishActivePatientInput()}
                        className={buttonClass(
                          'secondary',
                          'md',
                          'min-h-10 w-full px-2 text-[12px] whitespace-nowrap',
                        )}
                      >
                        {isPatientPolishing && (
                          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-voice" aria-hidden />
                        )}
                        <span>{isEn ? '✨ AI Polish' : '✨ AI整形'}</span>
                      </button>

                      <button
                        type="button"
                        data-testid="consult-send-to-doctor-button"
                        disabled={!patientInput.trim() || isSendingToDoctor || isPatientPolishing}
                        onClick={() => void handleSendPatientInput()}
                        className={buttonClass(
                          'primary',
                          'md',
                          'min-h-10 w-full px-2 text-[12px] whitespace-nowrap',
                        )}
                      >
                        {isSendingToDoctor && (
                          <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden />
                        )}
                        <span>
                          {isOverseasEnDoctor
                            ? '📤 英語で表示'
                            : isEn
                            ? '📤 Show to Doctor'
                            : '📤 医師へ表示'}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>
        )}

        {/* 診察終了後の要約作成中 */}
        {phase === 'summarizing' && (
          <div className="mx-auto w-full max-w-md space-y-3 px-4 py-12" aria-live="polite">
            <h1 className="text-[22px] font-bold text-ink">
              {isEn ? 'Summarizing Consultation...' : '診察内容を要約しています...'}
            </h1>
            <p className="flex items-center gap-2 text-[14px] text-ink-2">
              <LoaderCircle className="size-4 shrink-0 animate-spin text-voice" aria-hidden />
              {isEn
                ? 'Structuring your Chief Complaint, Key Points, Prescriptions, and Follow-up Date, saving strictly to this browser.'
                : '対話ログから「主訴・診断ポイント・処方/指示・次回受診日」を構造化し、端末ローカルに安全保存しています。'}
            </p>
            <LocalStorageBadge />
          </div>
        )}

        {/* ==================== 診察後（構造化要約＆再診カレンダー登録） ==================== */}
        {phase === 'summary' && summary && (
          <div className="h-full overflow-y-auto" data-testid="consult-step-3">
            <ConsultationSummaryCard
              clinicName={clinicName.trim() || SANDBOX_CLINIC.name}
              clinicAddress={clinicAddress}
              userLanguage={userLanguage}
              doctorLanguage={doctorLanguage}
              summary={summary}
              turns={turns}
              savedLocally={savedLocally}
              onStartNew={() => {
                setSummary(null);
                setTurns([]);
                setSuggestions([]);
                setIsSuggestionsOpen(false);
                setIsSavedPhrasesOpen(false);
                setSetupStep(1);
                setPhase('setup');
              }}
            />
          </div>
        )}
      </main>
    </div>
  );
}
