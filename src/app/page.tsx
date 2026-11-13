"use client";

import { useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CalendarClock,
  CheckCircle2,
  LoaderCircle,
  LocateFixed,
  MapPin,
  Navigation,
  Phone,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Wand2,
} from 'lucide-react';
import { AppHeader, CallStatus } from '@/components/AppHeader';
import { CareAiModeBadge } from '@/components/CareAiModeBadge';
import { CustomPhrasesSection } from '@/components/CustomPhrases';
import { DemoDataNotice } from '@/components/DemoDataNotice';
import { HomeHistorySection } from '@/components/HomeHistorySection';
import { LanguageSelector } from '@/components/LanguageSelector';
import { SandboxCallView } from '@/components/SandboxCallView';
import { Notice, actionCueClass, buttonClass, cx } from '@/components/ui';
import { useUserLanguage } from '@/contexts/UserLanguageContext';
import type { AiMeta } from '@/lib/aiMeta';
import {
  DEFAULT_SPEECH_VOICE,
  MAX_PATIENT_TEXT_LENGTH,
  SPEECH_VOICES,
  buildGreeting,
} from '@/lib/callProtocol';
import type { SpeechVoice } from '@/lib/callProtocol';
import { MAX_PARTNER_NAME_LENGTH } from '@/lib/callPurpose';
import { stopCareSpeech } from '@/lib/careSpeech';
import { CONSULT_PATH, SANDBOX_CLINIC } from '@/lib/careTypes';
import type {
  ClinicCandidate,
  ClinicSearchResult,
  DepartmentChoice,
} from '@/lib/careTypes';
import { commitPendingCustomPhrase } from '@/lib/customPhrases';
import {
  ensureHomeHubReset,
  getHomeResetSnapshot,
  getServerHomeResetSnapshot,
  requestConsultReset,
  setTrackedHomeMode,
  subscribeHomeReset,
} from '@/lib/homeReset';
import {
  CARE_EXAMPLES,
  DEPARTMENT_OPTIONS,
  PREFERRED_SLOT_PRESETS,
  buildWizardOpeningMessage,
  getDepartmentLabel,
  getVoiceLabel,
} from '@/lib/i18n';
import { requestDraftPolish } from '@/lib/draftPolish';

type HomeMode = 'hub' | 'wizard';
type WizardStep = 1 | 2 | 3 | 4;

const STEP_TITLES: Record<'ja' | 'en', Record<WizardStep, string>> = {
  ja: {
    1: '症状・診療科・希望日時・エリア',
    2: '医療機関の検索結果＆選択',
    3: '発信前の最終確認＆よく使う文',
    4: 'AI模擬クリニック通話＆予約完了',
  },
  en: {
    1: 'Symptoms, Dept, Preferred Times & Area',
    2: 'Clinic Search Results & Selection',
    3: 'Final Pre-Call Review & Quick Phrases',
    4: 'AI Mock Clinic Call & Post-Call Actions',
  },
};

function hasJapaneseCharacters(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
}

export default function EchoBridgeCareHomePage() {
  const resetGeneration = useSyncExternalStore(
    subscribeHomeReset,
    getHomeResetSnapshot,
    getServerHomeResetSnapshot,
  );

  // `/?reset=1` での直接アクセスや Next.js 16 Activity 再表示時にも確実に初期2択ハブへリセットする
  useEffect(() => {
    const consumeResetParam = () => {
      if (typeof window === 'undefined') return;
      const params = new URLSearchParams(window.location.search);
      if (params.get('reset') === '1') {
        ensureHomeHubReset();
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
  }, [resetGeneration]);

  return <EchoBridgeCareHomeContent key={resetGeneration} />;
}

function EchoBridgeCareHomeContent() {
  const { userLanguage } = useUserLanguage();
  const isEn = userLanguage === 'en';

  const [mode, setMode] = useState<HomeMode>('hub');
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);

  useEffect(() => {
    setTrackedHomeMode(mode);
  }, [mode]);

  // Step 1 state
  const [symptoms, setSymptoms] = useState('');
  const [isPolishingSymptoms, setIsPolishingSymptoms] = useState(false);
  const [preferredDepartment, setPreferredDepartment] = useState<DepartmentChoice>('ai_auto');
  const [preferredSlots, setPreferredSlots] = useState<[string, string, string]>(['', '', '']);
  const [area, setArea] = useState('');
  const [originLocation, setOriginLocation] = useState('');
  const [usingGpsLocation, setUsingGpsLocation] = useState(false);
  const [gpsStatus, setGpsStatus] = useState<string | null>(null);
  const [isLocating, setIsLocating] = useState(false);
  const [lastAiMeta, setLastAiMeta] = useState<AiMeta | null>(null);

  // Step 2 state
  const [isSearchingClinics, setIsSearchingClinics] = useState(false);
  const [searchResult, setSearchResult] = useState<ClinicSearchResult | null>(null);
  const [selectedClinic, setSelectedClinic] = useState<ClinicCandidate>(SANDBOX_CLINIC);

  // Step 3 state
  const [partnerName, setPartnerName] = useState('');
  const [intent, setIntent] = useState('');
  const [isPolishingIntent, setIsPolishingIntent] = useState(false);
  const [voice, setVoice] = useState<SpeechVoice>(DEFAULT_SPEECH_VOICE);

  const slotPresets = PREFERRED_SLOT_PRESETS[userLanguage];

  const updateSlot = (index: 0 | 1 | 2, value: string) => {
    setPreferredSlots((prev) => {
      const next: [string, string, string] = [prev[0], prev[1], prev[2]];
      next[index] = value;
      return next;
    });
  };

  const handleFillStep1Example = () => {
    const example = CARE_EXAMPLES[userLanguage];
    setSymptoms(example.clinicSymptoms);
    setPreferredDepartment('internal');
    setPreferredSlots([
      example.preferredSlots[0],
      example.preferredSlots[1],
      example.preferredSlots[2],
    ]);
    setArea(example.clinicArea);
    setOriginLocation(example.clinicOrigin);
    setUsingGpsLocation(false);
    setGpsStatus(null);
  };

  const handlePolishStep1Symptoms = async () => {
    if (!symptoms.trim() || isPolishingSymptoms) return;
    setIsPolishingSymptoms(true);
    try {
      const deptLabel =
        preferredDepartment !== 'ai_auto'
          ? getDepartmentLabel(preferredDepartment, userLanguage)
          : '';
      const { polishedText } = await requestDraftPolish({
        text: symptoms,
        field: 'symptoms',
        userLanguage,
        departmentLabel: deptLabel,
        preferredSlots,
      });
      if (polishedText) setSymptoms(polishedText);
    } finally {
      setIsPolishingSymptoms(false);
    }
  };

  const handleUseCurrentLocation = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setArea((prev) => prev || (isEn ? 'Near Tokyo Station (Manual Area)' : '東京駅周辺（手入力エリア）'));
      setUsingGpsLocation(false);
      setGpsStatus(
        isEn
          ? 'GPS is unavailable in this browser. Filled a sample station area — feel free to edit manually.'
          : 'このブラウザではGPS測位が利用できないため、駅名エリア欄から手入力できます。',
      );
      return;
    }

    setIsLocating(true);
    setGpsStatus(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setIsLocating(false);
        const lat = pos.coords.latitude.toFixed(3);
        const lng = pos.coords.longitude.toFixed(3);
        const label = isEn
          ? `Current Location (${lat}, ${lng})`
          : `現在地周辺（北緯${lat}・東経${lng}）`;
        setArea(label);
        setUsingGpsLocation(true);
        setOriginLocation('');
        setGpsStatus(
          isEn
            ? 'Applied your current GPS area (directions will start from Current Location).'
            : '現在地の座標エリアを反映しました（経路案内の出発地も「現在地」を使用します）。',
        );
      },
      () => {
        setIsLocating(false);
        setUsingGpsLocation(false);
        setGpsStatus(
          isEn
            ? 'Location permission was declined. Please enter a station or neighborhood manually below.'
            : '現在地の共有がオフのため、下の入力欄に駅名・地域名を手入力してください。',
        );
      },
      { timeout: 3500, maximumAge: 60_000 },
    );
  };

  const applyClinicSelectionToStep3 = (
    clinic: ClinicCandidate,
    resolvedSearch: ClinicSearchResult | null,
  ) => {
    setSelectedClinic(clinic);
    const displayClinicName = isEn && clinic.nameEn ? clinic.nameEn : clinic.name;
    setPartnerName(displayClinicName);

    const generatedIntent = buildWizardOpeningMessage({
      symptoms,
      department: preferredDepartment,
      preferredSlots,
      suggestedIntent: resolvedSearch?.suggestedIntent,
      lang: userLanguage,
    });
    setIntent(generatedIntent);
    setWizardStep(3);
  };

  const handleStep1Next = async () => {
    setIsSearchingClinics(true);
    const effectiveSymptoms =
      symptoms.trim() || CARE_EXAMPLES[userLanguage].clinicSymptoms;
    const cleanedSlots = preferredSlots.map((s) => s.trim()).filter(Boolean);

    let resolved: ClinicSearchResult;
    try {
      const response = await fetch('/api/clinic-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symptoms: effectiveSymptoms,
          area: area.trim(),
          preferredDepartment,
          preferredSlots: cleanedSlots,
          userLanguage,
        }),
      });
      if (!response.ok) throw new Error('clinic_search_failed');
      resolved = (await response.json()) as ClinicSearchResult;
    } catch {
      const deptLabel =
        preferredDepartment === 'ai_auto'
          ? isEn
            ? 'Internal Medicine'
            : '内科'
          : getDepartmentLabel(preferredDepartment, userLanguage);
      resolved = {
        organizedSymptoms: effectiveSymptoms,
        organizedSymptomsEn: effectiveSymptoms,
        recommendedDepartments: [deptLabel],
        urgencyNote: isEn
          ? 'If you have difficulty breathing or severe chest pain, please seek emergency care (#7119 or 119 in Japan).'
          : '強い呼吸苦や胸痛などの緊急症状がある場合は、救急相談（#7119）または119番をご利用ください。',
        suggestedIntent: buildWizardOpeningMessage({
          symptoms: effectiveSymptoms,
          department: preferredDepartment,
          preferredSlots,
          lang: userLanguage,
        }),
        clinics: [SANDBOX_CLINIC],
        ai: { source: 'fallback', reason: 'not_configured' },
      };
    } finally {
      setIsSearchingClinics(false);
    }

    setLastAiMeta(resolved.ai);
    setSearchResult(resolved);
    setSelectedClinic(SANDBOX_CLINIC);
    setWizardStep(2);
  };

  const handleFillStep3Example = () => {
    const example = CARE_EXAMPLES[userLanguage];
    if (!partnerName.trim()) {
      setPartnerName(isEn && SANDBOX_CLINIC.nameEn ? SANDBOX_CLINIC.nameEn : SANDBOX_CLINIC.name);
    }
    setIntent(
      buildWizardOpeningMessage({
        symptoms: symptoms.trim() || example.clinicSymptoms,
        department: preferredDepartment === 'ai_auto' ? 'internal' : preferredDepartment,
        preferredSlots: preferredSlots.some((s) => s.trim())
          ? preferredSlots
          : example.preferredSlots,
        lang: userLanguage,
      }),
    );
  };

  const handleWizardBack = () => {
    if (wizardStep === 4) {
      stopCareSpeech();
      setWizardStep(3);
      return;
    }
    if (wizardStep === 3) {
      setWizardStep(2);
      return;
    }
    if (wizardStep === 2) {
      setWizardStep(1);
      return;
    }
    setMode('hub');
  };

  const handleExitWizardToHub = () => {
    stopCareSpeech();
    setMode('hub');
    setWizardStep(1);
  };

  const japaneseGreetingPreview = (() => {
    const trimmed = intent.trim();
    if (!trimmed) return null;
    if (hasJapaneseCharacters(trimmed)) return buildGreeting(trimmed, 'medical');
    return buildGreeting(
      '発熱と症状の相談のため、初診の受診予約をお願いしたいです',
      'medical',
    );
  })();

  const resolvedDepartmentLabel =
    preferredDepartment !== 'ai_auto'
      ? getDepartmentLabel(preferredDepartment, userLanguage)
      : searchResult?.recommendedDepartments?.[0] ?? '';

  const handlePolishStep3Intent = async () => {
    if (!intent.trim() || isPolishingIntent) return;
    setIsPolishingIntent(true);
    try {
      const { polishedText } = await requestDraftPolish({
        text: intent,
        field: 'intent',
        userLanguage,
        departmentLabel: resolvedDepartmentLabel,
        preferredSlots,
      });
      if (polishedText) setIntent(polishedText);
    } finally {
      setIsPolishingIntent(false);
    }
  };

  return (
    <div className="flex h-dvh flex-col bg-canvas">
      <AppHeader
        compactOnMobile={mode === 'wizard' && wizardStep === 4}
        status={
          mode === 'wizard' ? (
            <div className="flex flex-wrap items-center gap-2">
              <CallStatus
                tone={wizardStep === 4 ? 'live' : 'idle'}
                label={
                  wizardStep === 4
                    ? isEn
                      ? 'AI Reception Call'
                      : 'AI模擬受付通話'
                    : `Step ${wizardStep}/4`
                }
                detail={
                  wizardStep === 4
                    ? isEn
                      ? 'No real call'
                      : '外部発信なし'
                    : STEP_TITLES[userLanguage][wizardStep]
                }
              />
              <CareAiModeBadge ai={lastAiMeta} compact />
            </div>
          ) : lastAiMeta ? (
            <CareAiModeBadge ai={lastAiMeta} compact />
          ) : undefined
        }
        actions={
          mode === 'wizard' ? (
            <Link
              href={CONSULT_PATH}
              onClick={() => requestConsultReset()}
              className={buttonClass('secondary', 'md', 'px-3 text-[12px] whitespace-nowrap')}
            >
              <Stethoscope className="size-4 shrink-0" aria-hidden />
              <span>{isEn ? 'Consult Mode' : '対面診察へ'}</span>
            </Link>
          ) : undefined
        }
      />

      {/* 予約ウィザード進行インジケーターバー（Step 1/4 〜 Step 4/4 ＋ 戻るボタン） */}
      {mode === 'wizard' && (
        <div className="shrink-0 border-b border-line bg-surface px-4 py-2.5">
          <div className="mx-auto flex w-full max-w-md flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                data-testid="wizard-back-button"
                onClick={handleWizardBack}
                className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-line-strong bg-canvas px-2.5 py-1 text-[13px] font-bold text-ink hover:bg-subtle"
              >
                <ArrowLeft className="size-4 shrink-0" aria-hidden />
                <span>
                  {wizardStep === 1
                    ? isEn
                      ? 'Back to Home'
                      : 'トップへ戻る'
                    : isEn
                    ? 'Back'
                    : '戻る'}
                </span>
              </button>
              <div className="text-right">
                <span
                  data-testid="wizard-step-indicator"
                  className="inline-flex items-center rounded-full bg-voice-soft px-2.5 py-0.5 text-[12px] font-bold text-voice-strong"
                >
                  Step {wizardStep}/4
                </span>
                <p className="mt-0.5 text-[11px] font-bold text-ink-2">
                  {STEP_TITLES[userLanguage][wizardStep]}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-1.5" aria-hidden>
              {([1, 2, 3, 4] as const).map((s) => (
                <div
                  key={s}
                  className={cx(
                    'h-1.5 rounded-full transition-colors',
                    s <= wizardStep ? 'bg-voice' : 'bg-line-strong/50',
                  )}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      <main className="min-h-0 flex-1">
        {/* ==================== トップ画面：スッキリした2択ハブ ==================== */}
        {mode === 'hub' && (
          <div className="h-full overflow-y-auto" data-testid="home-hub">
            <div className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 py-6">
              <div className="space-y-1.5">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-voice-soft px-3 py-1 text-[12px] font-bold text-voice-strong">
                  <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
                  {isEn
                    ? 'Medical Access & Consultation Bridge'
                    : '医療アクセス・受診サポート特化モデル'}
                </span>
                <h1 className="text-[24px] font-bold leading-snug text-ink">
                  {isEn
                    ? 'How would you like to use EchoBridge Care?'
                    : 'どちらの場面で使いますか？'}
                </h1>
                <p className="text-[14px] leading-relaxed text-ink-2">
                  {isEn
                    ? 'Select your language first, then choose phone booking or in-room consultation.'
                    : 'まずあなたの言語を選び、電話予約または診察室での対話サポートを選んでください。'}
                </p>
              </div>

              {/* 言語切替スイッチ（🇯🇵 日本語 / 🇺🇸 English） */}
              <LanguageSelector />

              {/* 2つの大きなモード選択カード */}
              <div className="grid gap-4">
                <button
                  type="button"
                  data-testid="hub-card-booking"
                  onClick={() => {
                    setMode('wizard');
                    setWizardStep(1);
                  }}
                  className={cx(
                    'group flex w-full flex-col items-start gap-3 rounded-2xl border-2 border-voice bg-surface p-5 text-left shadow-sm ring-2 ring-teal-400/20 transition-all hover:bg-voice-soft hover:shadow-md hover:ring-4 hover:ring-teal-300/45 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-400/55',
                    actionCueClass(true),
                  )}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-voice px-3 py-1 text-[12px] font-bold text-on-voice">
                      <Phone className="size-3.5" aria-hidden />
                      {isEn ? 'Step-by-Step AI Booking' : '4ステップ電話予約ウィザード'}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[12px] font-bold text-voice-strong">
                      {isEn ? 'Start' : '開始'}
                      <ArrowRight
                        className="size-4 shrink-0 transition-transform group-hover:translate-x-0.5"
                        aria-hidden
                      />
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    <h2 className="text-[20px] font-bold leading-snug text-ink">
                      {isEn
                        ? '🏥 Find a Clinic & Book by AI Call'
                        : '🏥 病院を探す・AIで予約電話する'}
                    </h2>
                    <p className="text-[14px] leading-relaxed text-ink-2">
                      {isEn
                        ? 'Organize your symptoms & 3 preferred times, pick a clinic (including the safe Mock Clinic sandbox), and book via AI voice.'
                        : '症状・診療科・希望日時3候補を整理してクリニックを選び、AI音声（審査用「模擬クリニック」対応）で安全に予約します。'}
                    </p>
                  </div>
                </button>

                <Link
                  href={CONSULT_PATH}
                  onClick={() => requestConsultReset()}
                  data-testid="hub-card-consult"
                  className="group flex w-full flex-col items-start gap-3 rounded-2xl border-2 border-voice/60 bg-surface p-5 text-left shadow-sm transition-all hover:border-voice hover:bg-voice-soft hover:shadow-md hover:ring-4 hover:ring-teal-300/45 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-400/55"
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-voice-soft px-3 py-1 text-[12px] font-bold text-voice-strong">
                      <Stethoscope className="size-3.5" aria-hidden />
                      {isEn ? 'Flat-on-Desk 180° Split UI' : '机上平置き・上部180°反転UI'}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[12px] font-bold text-voice-strong">
                      {isEn ? 'Open' : '開く'}
                      <ArrowRight
                        className="size-4 shrink-0 transition-transform group-hover:translate-x-0.5"
                        aria-hidden
                      />
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    <h2 className="text-[20px] font-bold leading-snug text-ink">
                      {isEn
                        ? '🩺 Use in Exam Room (Face-to-Face 180° Mode)'
                        : '🩺 診察室で使う（対面診察・上下反転モード）'}
                    </h2>
                    <p className="text-[14px] leading-relaxed text-ink-2">
                      {isEn
                        ? 'Place your phone flat on the desk to communicate with the doctor via 180° medical Japanese display, instant 3-choice replies & summary.'
                        : 'スマホを診察机に平置きし、医師側の180度反転表示・リアルタイム翻訳・3択返答・診察後サマリーで対話を支援します。'}
                    </p>
                  </div>
                </Link>
              </div>

              {/* 控えめなローカル履歴セクション（予約・受診件数と直近1件プレビュー、展開して確認・再予約・対面診察引き継ぎ） */}
              <HomeHistorySection
                onStartRebooking={({ clinicName: name, symptomsMemo, originLocation: prevOrigin }) => {
                  setSymptoms(symptomsMemo);
                  setPartnerName(name);
                  if (prevOrigin) setOriginLocation(prevOrigin);
                  setMode('wizard');
                  setWizardStep(1);
                }}
              />
            </div>
          </div>
        )}

        {/* ==================== Step 1: 症状・診療科・希望日時3候補・エリア ==================== */}
        {mode === 'wizard' && wizardStep === 1 && (
          <div className="h-full overflow-y-auto" data-testid="wizard-step-1">
            <div className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 py-5">
              <LanguageSelector compact />

              <DemoDataNotice side="user" />

              {/* 1. 主訴・具体的な要件 */}
              <section className="space-y-2.5 rounded-xl border border-line bg-surface p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="wizard-symptoms" className="min-w-0 text-[15px] font-bold text-ink">
                    {isEn ? '1. Symptoms & Specific Request' : '1. 主訴・具体的な要件'}
                  </label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      data-testid="step1-ai-polish-button"
                      disabled={!symptoms.trim() || isPolishingSymptoms}
                      title={
                        !symptoms.trim()
                          ? isEn
                            ? 'Enter your symptoms first to polish with AI'
                            : 'メモを入力するとAIブラッシュアップが使えます'
                          : undefined
                      }
                      onClick={() => void handlePolishStep1Symptoms()}
                      className={buttonClass(
                        'secondary',
                        'md',
                        'min-h-9 shrink-0 px-2.5 py-1.5 text-[12px] whitespace-nowrap',
                      )}
                    >
                      {isPolishingSymptoms ? (
                        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-voice" aria-hidden />
                      ) : (
                        <Sparkles className="size-3.5 shrink-0 text-voice-strong" aria-hidden />
                      )}
                      <span>
                        {isPolishingSymptoms
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
                      data-testid="clinic-fill-example-button"
                      onClick={handleFillStep1Example}
                      className={buttonClass(
                        'accent',
                        'md',
                        cx(
                          'min-h-9 shrink-0 px-3 py-1.5 text-[12px] whitespace-nowrap',
                          !symptoms.trim() && 'ring-2 ring-teal-300/60',
                          actionCueClass(!symptoms.trim()),
                        ),
                      )}
                    >
                      <Wand2 className="size-3.5 shrink-0" aria-hidden />
                      <span>{isEn ? 'Fill Example' : '例を入力'}</span>
                    </button>
                  </div>
                </div>
                <textarea
                  id="wizard-symptoms"
                  rows={3}
                  value={symptoms}
                  maxLength={500}
                  onChange={(event) => setSymptoms(event.target.value)}
                  placeholder={
                    isEn
                      ? 'e.g., 38°C fever and sore throat since last night. Looking for a first-visit appointment.'
                      : '例：昨日の夜から38度の熱と喉の痛みがあります。今日受診できる初診予約を取りたいです。'
                  }
                  className="w-full resize-none rounded-lg border border-line-strong bg-canvas px-3 py-2.5 text-[15px] leading-relaxed text-ink placeholder:text-ink-2/70 focus:border-voice"
                />
              </section>

              {/* 2. 希望する診療科チップ */}
              <section className="space-y-2.5 rounded-xl border border-line bg-surface p-4">
                <p className="text-[15px] font-bold text-ink">
                  {isEn ? '2. Preferred Department' : '2. 希望する診療科'}
                </p>
                <div
                  role="radiogroup"
                  aria-label={isEn ? 'Preferred Department' : '希望する診療科'}
                  className="flex flex-wrap gap-2"
                >
                  {DEPARTMENT_OPTIONS.map((dept) => {
                    const checked = preferredDepartment === dept.id;
                    const label = isEn ? dept.labelEn : dept.labelJa;
                    return (
                      <button
                        key={dept.id}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        data-testid={`dept-chip-${dept.id}`}
                        onClick={() => setPreferredDepartment(dept.id)}
                        className={cx(
                          'min-h-10 rounded-full border px-3.5 py-1.5 text-[13px] font-bold transition-colors',
                          checked
                            ? 'border-voice bg-voice text-on-voice'
                            : 'border-line-strong bg-canvas text-ink hover:border-voice',
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* 3. 受診可能な日時候補（第1〜第3希望） */}
              <section className="space-y-3 rounded-xl border border-line bg-surface p-4">
                <div className="space-y-1">
                  <p className="flex items-center gap-1.5 text-[15px] font-bold text-ink">
                    <CalendarClock className="size-4 shrink-0 text-voice-strong" aria-hidden />
                    <span>
                      {isEn
                        ? '3. Preferred Date/Time Slots (Up to 3)'
                        : '3. 受診可能な日時候補（第1〜第3希望）'}
                    </span>
                  </p>
                  <p className="text-[12px] text-ink-2">
                    {isEn
                      ? 'Tap a quick chip to fill the next empty slot, or type freely in each box.'
                      : '候補チップをタップして順番に入れるか、各欄に自由入力できます。'}
                  </p>
                </div>

                {/* クイック候補チップ */}
                <div className="flex flex-wrap gap-1.5">
                  {slotPresets.map((preset) => {
                    const isUsed = preferredSlots.includes(preset);
                    return (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => {
                          if (isUsed) return;
                          const emptyIdx = preferredSlots.findIndex((s) => !s.trim());
                          const targetIdx = (emptyIdx >= 0 ? emptyIdx : 0) as 0 | 1 | 2;
                          updateSlot(targetIdx, preset);
                        }}
                        className={cx(
                          'rounded-full border px-2.5 py-1 text-[12px] font-bold transition-colors',
                          isUsed
                            ? 'border-voice/50 bg-voice-soft text-voice-strong'
                            : 'border-line-strong bg-canvas text-ink-2 hover:border-voice hover:text-ink',
                        )}
                      >
                        + {preset}
                      </button>
                    );
                  })}
                </div>

                <div className="space-y-2">
                  {([0, 1, 2] as const).map((idx) => {
                    const slotLabel = isEn
                      ? idx === 0
                        ? '1st Choice'
                        : idx === 1
                        ? '2nd Choice'
                        : '3rd Choice'
                      : `第${idx + 1}希望`;
                    return (
                      <label key={idx} className="flex items-center gap-2">
                        <span className="w-20 shrink-0 text-[12px] font-bold text-ink-2">
                          {slotLabel}
                        </span>
                        <input
                          type="text"
                          data-testid={`preferred-slot-${idx}`}
                          value={preferredSlots[idx]}
                          maxLength={80}
                          onChange={(event) => updateSlot(idx, event.target.value)}
                          placeholder={slotPresets[idx] ?? ''}
                          className="min-h-10 min-w-0 flex-1 rounded-lg border border-line-strong bg-canvas px-3 text-[13px] text-ink placeholder:text-ink-2/60 focus:border-voice"
                        />
                      </label>
                    );
                  })}
                </div>
              </section>

              {/* 4. 希望エリア（GPS現在地 または 手入力） */}
              <section className="space-y-2.5 rounded-xl border border-line bg-surface p-4">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="wizard-area" className="text-[15px] font-bold text-ink">
                    {isEn ? '4. Preferred Area' : '4. 希望エリア'}
                  </label>
                  <button
                    type="button"
                    data-testid="use-gps-button"
                    disabled={isLocating}
                    onClick={handleUseCurrentLocation}
                    className={buttonClass(
                      'secondary',
                      'md',
                      'min-h-9 shrink-0 px-3 py-1 text-[12px] whitespace-nowrap',
                    )}
                  >
                    {isLocating ? (
                      <LoaderCircle className="size-3.5 animate-spin text-voice" aria-hidden />
                    ) : (
                      <LocateFixed className="size-3.5 text-voice" aria-hidden />
                    )}
                    <span>{isEn ? 'Use Current Location' : '現在地を使う'}</span>
                  </button>
                </div>
                <input
                  id="wizard-area"
                  type="text"
                  value={area}
                  maxLength={100}
                  onChange={(event) => {
                    setArea(event.target.value);
                    setUsingGpsLocation(false);
                  }}
                  placeholder={
                    isEn
                      ? 'Or type manually: e.g., Shinjuku Station / Shibuya'
                      : 'GPSを使わない場合は手入力（例：新宿駅周辺・東京駅）'
                  }
                  className="min-h-11 w-full rounded-lg border border-line-strong bg-canvas px-3 text-[14px] text-ink placeholder:text-ink-2/70 focus:border-voice"
                />
                {!usingGpsLocation && (
                  <div className="space-y-1 pt-1">
                    <label
                      htmlFor="wizard-origin"
                      className="flex items-center gap-1.5 text-[12px] font-bold text-ink-2"
                    >
                      <Navigation className="size-3.5 shrink-0 text-voice-strong" aria-hidden />
                      <span>
                        {isEn
                          ? 'Starting Point / Origin for Directions (Optional — blank uses Current Location)'
                          : '出発地・スタート地点（任意・空欄時は「現在地」を使用）'}
                      </span>
                    </label>
                    <input
                      id="wizard-origin"
                      data-testid="wizard-origin-input"
                      type="text"
                      value={originLocation}
                      maxLength={100}
                      onChange={(event) => setOriginLocation(event.target.value)}
                      placeholder={
                        isEn
                          ? 'e.g., Shinjuku Station, Home Station (blank = Current Location)'
                          : '例：新宿駅、自宅最寄り駅（空欄なら現在地から経路案内）'
                      }
                      className="min-h-10 w-full rounded-lg border border-line-strong bg-canvas px-3 text-[13px] text-ink placeholder:text-ink-2/70 focus:border-voice"
                    />
                  </div>
                )}
                {gpsStatus && <p className="text-[12px] text-ink-2">{gpsStatus}</p>}
              </section>

              <button
                type="button"
                data-testid="wizard-step1-next"
                disabled={isSearchingClinics}
                onClick={() => void handleStep1Next()}
                className={buttonClass(
                  'primary',
                  'lg',
                  cx('w-full', actionCueClass(Boolean(symptoms.trim()) && !isSearchingClinics)),
                )}
              >
                {isSearchingClinics ? (
                  <>
                    <LoaderCircle className="size-5 animate-spin" aria-hidden />
                    <span>
                      {isEn ? 'Organizing & Finding Clinics...' : '症状・診療科を整理しています...'}
                    </span>
                  </>
                ) : (
                  <>
                    <Sparkles className="size-5 shrink-0" aria-hidden />
                    <span>
                      {isEn
                        ? 'Analyze Symptoms & Find Clinics (Step 2)'
                        : '症状・診療科を整理して検索（Step 2へ）'}
                    </span>
                    <ArrowRight className="size-4 shrink-0" aria-hidden />
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* ==================== Step 2: 医療機関の検索結果＆選択 ==================== */}
        {mode === 'wizard' && wizardStep === 2 && (
          <div className="h-full overflow-y-auto" data-testid="wizard-step-2">
            <div className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-5">
              {/* Step 1 の整理サマリー */}
              {searchResult && (
                <section className="space-y-2 rounded-xl border border-line bg-surface p-4">
                  <p className="text-[12px] font-bold text-voice-strong">
                    {isEn ? 'Organized Triage Summary' : '整理された受診目安・症状サマリー'}
                  </p>
                  <p className="text-[14px] font-bold leading-snug text-ink">
                    {isEn && searchResult.organizedSymptomsEn
                      ? searchResult.organizedSymptomsEn
                      : searchResult.organizedSymptoms}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {searchResult.recommendedDepartments.map((dept) => (
                      <span
                        key={dept}
                        className="rounded-full bg-voice-soft px-2.5 py-0.5 text-[12px] font-bold text-voice-strong"
                      >
                        {isEn ? `Recommended: ${dept}` : `推奨診療科: ${dept}`}
                      </span>
                    ))}
                  </div>
                  <p className="text-[12px] leading-relaxed text-ink-2">
                    {searchResult.urgencyNote}
                  </p>
                </section>
              )}

              <p className="text-[13px] font-bold text-ink-2">
                {isEn
                  ? 'Select a clinic below to proceed to final pre-call confirmation (Step 3):'
                  : '連絡する医療機関を選ぶと、発信前の最終確認（Step 3）へ進みます：'}
              </p>

              {/* 最上部固定：[審査・検証用] EchoBridge Care 模擬クリニック ＋ 参考クリニック候補 */}
              <div className="space-y-3">
                {(searchResult?.clinics ?? [SANDBOX_CLINIC]).map((clinic) => {
                  const displayName = isEn && clinic.nameEn ? clinic.nameEn : clinic.name;
                  const displayDepts =
                    isEn && clinic.departmentsEn ? clinic.departmentsEn : clinic.departments;
                  const displayAddress =
                    isEn && clinic.addressEn ? clinic.addressEn : clinic.address;
                  const displayDistance =
                    isEn && clinic.distanceNoteEn ? clinic.distanceNoteEn : clinic.distanceNote;
                  const displayReason =
                    isEn && clinic.matchReasonEn ? clinic.matchReasonEn : clinic.matchReason;

                  return (
                    <div
                      key={clinic.id}
                      data-testid={clinic.isSandbox ? 'sandbox-clinic-card' : `clinic-card-${clinic.id}`}
                      className={cx(
                        'space-y-2.5 rounded-2xl border-2 p-4 transition-colors',
                        clinic.isSandbox
                          ? 'border-voice bg-voice-soft/70 shadow-sm'
                          : 'border-line-strong bg-surface',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="space-y-1">
                          {clinic.isSandbox && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-voice px-2.5 py-0.5 text-[11px] font-bold text-on-voice">
                              <Bot className="size-3" aria-hidden />
                              {isEn
                                ? 'Pinned Safe Sandbox · No Real Call'
                                : '審査・検証用ピン留め（誤発信防止・AI受付対応）'}
                            </span>
                          )}
                          <h2 className="text-[16px] font-bold leading-snug text-ink">
                            {displayName}
                          </h2>
                        </div>
                      </div>

                      <p className="text-[12px] font-medium text-ink-2">
                        {displayDepts.join(' / ')} ・ {displayDistance}
                      </p>
                      <p className="flex items-center gap-1 text-[12px] text-ink-2">
                        <MapPin className="size-3.5 shrink-0 text-ink-2" aria-hidden />
                        <span>
                          {displayAddress}（{clinic.hours}）
                        </span>
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {clinic.features.map((feat) => (
                          <span
                            key={feat}
                            className="rounded-md border border-line bg-canvas px-2 py-0.5 text-[11px] text-ink-2"
                          >
                            {feat}
                          </span>
                        ))}
                      </div>
                      <p className="text-[12px] leading-relaxed text-ink">{displayReason}</p>

                      <button
                        type="button"
                        data-testid={
                          clinic.isSandbox
                            ? 'select-sandbox-clinic-button'
                            : `select-clinic-${clinic.id}`
                        }
                        onClick={() => applyClinicSelectionToStep3(clinic, searchResult)}
                        className={buttonClass(
                          clinic.isSandbox ? 'primary' : 'secondary',
                          'md',
                          cx(
                            'w-full text-[14px]',
                            clinic.isSandbox && 'ring-3 ring-teal-300/60',
                            actionCueClass(Boolean(clinic.isSandbox)),
                          ),
                        )}
                      >
                        <CheckCircle2 className="size-4 shrink-0" aria-hidden />
                        <span>
                          {clinic.isSandbox
                            ? isEn
                              ? 'Select Mock Clinic & Proceed to Step 3'
                              : 'この模擬クリニックを選んで Step 3 へ進む'
                            : isEn
                            ? 'Select This Clinic (Demo Call) → Step 3'
                            : 'このクリニックを選んで Step 3 へ進む'}
                        </span>
                        {clinic.isSandbox && <ArrowRight className="size-4 shrink-0" aria-hidden />}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ==================== Step 3: 発信前の最終確認＆よく使う文 ==================== */}
        {mode === 'wizard' && wizardStep === 3 && (
          <div className="h-full overflow-y-auto" data-testid="wizard-step-3">
            <div className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 py-5">
              <Notice tone="neutral">
                {isEn
                  ? 'Review the auto-generated opening message below before starting the in-browser AI reception call (no external phone call is placed).'
                  : 'Step 1・2から自動生成された用件文を確認・微調整してから、AI模擬受付通話を開始できます（外部への実際の電話発信は行われません）。'}
              </Notice>

              <div className="space-y-4 rounded-2xl border border-line bg-surface p-4">
                {/* 連絡先クリニック名 */}
                <div className="space-y-1.5">
                  <label htmlFor="wizard-partner-name" className="block text-[14px] font-bold text-ink">
                    {isEn ? 'Clinic / Recipient Name' : '相手の名前（医療機関名）'}
                  </label>
                  <input
                    id="wizard-partner-name"
                    type="text"
                    value={partnerName}
                    maxLength={MAX_PARTNER_NAME_LENGTH}
                    onChange={(event) => setPartnerName(event.target.value)}
                    className="min-h-11 w-full rounded-lg border border-line-strong bg-canvas px-3.5 text-[15px] text-ink focus:border-voice"
                  />
                </div>

                {/* 最初に伝える用件（自動生成＋編集可能） */}
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label htmlFor="wizard-intent" className="text-[14px] font-bold text-ink">
                      {isEn ? 'Opening Message' : '最初に伝える用件'}
                    </label>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        data-testid="step3-ai-polish-button"
                        disabled={!intent.trim() || isPolishingIntent}
                        title={
                          !intent.trim()
                            ? isEn
                              ? 'Enter your message first to polish with AI'
                              : '用件を入力するとAIブラッシュアップが使えます'
                            : undefined
                        }
                        onClick={() => void handlePolishStep3Intent()}
                        className={buttonClass(
                          'secondary',
                          'md',
                          'min-h-8 shrink-0 px-2.5 py-1 text-[12px] whitespace-nowrap',
                        )}
                      >
                        {isPolishingIntent ? (
                          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-voice" aria-hidden />
                        ) : (
                          <Sparkles className="size-3.5 shrink-0 text-voice-strong" aria-hidden />
                        )}
                        <span>
                          {isPolishingIntent
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
                        data-testid="setup-fill-example-button"
                        onClick={handleFillStep3Example}
                        className={buttonClass(
                          'accent',
                          'md',
                          cx(
                            'min-h-8 shrink-0 px-2.5 py-1 text-[12px] whitespace-nowrap',
                            actionCueClass(!intent.trim()),
                          ),
                        )}
                      >
                        <Wand2 className="size-3.5 shrink-0" aria-hidden />
                        <span>{isEn ? 'Fill Example' : '例を入力'}</span>
                      </button>
                    </div>
                  </div>
                  <textarea
                    id="wizard-intent"
                    rows={4}
                    value={intent}
                    maxLength={MAX_PATIENT_TEXT_LENGTH}
                    onChange={(event) => setIntent(event.target.value)}
                    placeholder={
                      isEn
                        ? 'Your symptoms and preferred appointment times...'
                        : '症状と希望日時候補を含む最初の用件...'
                    }
                    className="w-full resize-none rounded-lg border border-line-strong bg-canvas px-3.5 py-2.5 text-[15px] leading-relaxed text-ink focus:border-voice"
                  />
                </div>

                {/* 日本語読み上げプレビュー */}
                {japaneseGreetingPreview && (
                  <div
                    data-testid="greeting-preview"
                    className="space-y-1 rounded-xl border border-line bg-subtle px-3.5 py-2.5"
                  >
                    <p className="text-[12px] font-bold text-ink-2">
                      {isEn
                        ? 'Spoken in Japanese when the call connects'
                        : '相手が出たときに読み上げる日本語'}
                    </p>
                    <p className="text-[14px] leading-relaxed text-ink">
                      {japaneseGreetingPreview}
                    </p>
                  </div>
                )}

                {/* 読み上げの声 */}
                <div className="space-y-1.5">
                  <p className="text-[14px] font-bold text-ink">
                    {isEn ? 'Reading Voice' : '読み上げの声'}
                  </p>
                  <div
                    role="radiogroup"
                    aria-label={isEn ? 'Reading Voice' : '読み上げの声'}
                    className="grid grid-cols-2 gap-2"
                  >
                    {SPEECH_VOICES.map((option) => {
                      const checked = voice === option;
                      return (
                        <button
                          key={option}
                          type="button"
                          role="radio"
                          aria-checked={checked}
                          onClick={() => setVoice(option)}
                          className={cx(
                            'min-h-10 rounded-lg border px-3 py-2 text-[14px] font-bold transition-colors',
                            checked
                              ? 'border-voice bg-voice-soft text-voice-strong'
                              : 'border-line-strong bg-canvas text-ink hover:border-voice',
                          )}
                        >
                          {getVoiceLabel(option, userLanguage)}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Step 4 通話開始ボタン */}
                <button
                  type="button"
                  data-testid="wizard-step3-start-call"
                  disabled={!intent.trim()}
                  onClick={() => {
                    commitPendingCustomPhrase(userLanguage);
                    setWizardStep(4);
                  }}
                  className={buttonClass(
                    'primary',
                    'lg',
                    cx('w-full', actionCueClass(Boolean(intent.trim()))),
                  )}
                >
                  <Bot className="size-5 shrink-0" aria-hidden />
                  <span>
                    {isEn
                      ? 'Start AI Reception Call (Step 4)'
                      : 'AI模擬クリニックへ予約通話を開始（Step 4へ）'}
                  </span>
                </button>
              </div>

              {/* 折りたたみアコーディオン：よく使う文の登録（任意） */}
              <CustomPhrasesSection mode="setup" prominentConfirm />
            </div>
          </div>
        )}

        {/* ==================== Step 4: AI模擬クリニック通話＆予約完了アクション ==================== */}
        {mode === 'wizard' && wizardStep === 4 && (
          <div className="h-full" data-testid="wizard-step-4">
            <SandboxCallView
              intent={
                intent.trim() ||
                buildWizardOpeningMessage({
                  symptoms,
                  department: preferredDepartment,
                  preferredSlots,
                  lang: userLanguage,
                })
              }
              voice={voice}
              clinic={selectedClinic}
              symptomsMemo={symptoms.trim() || intent.trim()}
              preferredSlots={preferredSlots}
              departmentLabel={resolvedDepartmentLabel}
              originLocation={usingGpsLocation ? '' : originLocation}
              onAiMeta={setLastAiMeta}
              onExit={handleExitWizardToHub}
            />
          </div>
        )}
      </main>
    </div>
  );
}
