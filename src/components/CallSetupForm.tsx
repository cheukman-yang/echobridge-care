"use client";

import type { FormEvent } from 'react';
import Link from 'next/link';
import { Bot, LogIn, Phone, Stethoscope, Wand2 } from 'lucide-react';
import { useUserLanguage } from '@/contexts/UserLanguageContext';
import { JOIN_PATH, MAX_PATIENT_TEXT_LENGTH, SPEECH_VOICES, buildGreeting } from '@/lib/callProtocol';
import type { SpeechVoice } from '@/lib/callProtocol';
import { MAX_PARTNER_NAME_LENGTH } from '@/lib/callPurpose';
import type { CallPurpose } from '@/lib/callPurpose';
import { CONSULT_PATH, SANDBOX_CLINIC } from '@/lib/careTypes';
import type { ClinicCandidate } from '@/lib/careTypes';
import { CARE_EXAMPLES, getVoiceLabel } from '@/lib/i18n';
import { ClinicFinderCard } from './ClinicFinderCard';
import { DemoDataNotice } from './DemoDataNotice';
import { LanguageSelector } from './LanguageSelector';
import { buttonClass, cx } from './ui';

interface CallSetupFormProps {
  purpose: CallPurpose;
  partnerName: string;
  intent: string;
  voice: SpeechVoice;
  isConnected: boolean;
  selectedClinic?: ClinicCandidate | null;
  onSelectClinic?: (clinic: ClinicCandidate | null) => void;
  onPurposeChange?(purpose: CallPurpose): void;
  onPartnerNameChange(value: string): void;
  onIntentChange(value: string): void;
  onVoiceChange(voice: SpeechVoice): void;
  onStart(): void;
}

const FIELD_CLASS =
  'w-full rounded-lg border border-line-strong bg-surface px-3.5 py-3 text-base text-ink placeholder:text-ink-2/70 focus:border-voice';

/** 発信の前に、言語・医療機関候補・宛先・最初に伝える用件を決める。読み上げる文はここで確かめられる。 */
export function CallSetupForm({
  purpose,
  partnerName,
  intent,
  voice,
  isConnected,
  selectedClinic = null,
  onSelectClinic,
  onPartnerNameChange,
  onIntentChange,
  onVoiceChange,
  onStart,
}: CallSetupFormProps) {
  const { userLanguage } = useUserLanguage();
  const isEn = userLanguage === 'en';
  const isSandboxMode = Boolean(selectedClinic?.isSandbox);
  const greeting = intent.trim() ? buildGreeting(intent, purpose) : '';
  const canStart = isSandboxMode ? true : Boolean(intent.trim() && isConnected);

  const startHint = isSandboxMode
    ? isEn
      ? 'No external phone call is placed — starts an interactive call with our in-browser Gemini AI receptionist.'
      : '外部の病院へは発信せず、ブラウザ内のGemini AI模擬受付ボットと安全に通話テストを行います。'
    : !isConnected
    ? isEn
      ? 'Connect to the call server, or select the Mock Clinic above to test immediately in your browser.'
      : 'サーバーに接続すると発信できます。'
    : !intent.trim()
    ? isEn
      ? 'Enter your opening message above to place a call.'
      : '最初に伝える用件を入力すると発信できます。'
    : null;

  /** ワンクリックで模擬クリニック名と現在の言語に応じた初診予約用件を確実に反映する。 */
  const fillSample = () => {
    const sample = CARE_EXAMPLES[userLanguage];
    onPartnerNameChange(SANDBOX_CLINIC.name);
    onIntentChange(sample.setupOpeningMessage);
    if (!selectedClinic) {
      onSelectClinic?.(SANDBOX_CLINIC);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canStart) onStart();
  };

  return (
    <form onSubmit={submit} className="space-y-6" aria-labelledby="setup-heading">
      <div className="space-y-2">
        <h1 id="setup-heading" className="text-[26px] font-bold leading-snug text-balance">
          {isEn ? 'Prepare Medical Call' : '通話の準備'}
        </h1>
        <p className="max-w-prose text-[15px] leading-relaxed text-ink-2 text-pretty">
          {isEn
            ? "The clinic's speech is transcribed (and translated into English), while your chosen replies are spoken in polite Japanese via synthesized voice. Nothing is spoken until you confirm."
            : '相手の話は文字で届き、あなたが選んだ文は合成音声で相手に読み上げられます。送る前に必ずあなたが確認します。相手の声は、通話中に「相手の声」をオンにすると聞けます。'}
        </p>
      </div>

      <LanguageSelector />

      <DemoDataNotice side="user" />

      {onSelectClinic && (
        <ClinicFinderCard
          selectedClinic={selectedClinic}
          onSelectClinic={onSelectClinic}
          onApplySuggestedIntent={(suggestedIntent) => onIntentChange(suggestedIntent)}
          onApplyPartnerName={(name) => onPartnerNameChange(name)}
        />
      )}

      <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-line-strong bg-surface/70 px-3.5 py-2.5">
        <p className="min-w-0 text-[13px] leading-snug text-ink-2">
          {isEn
            ? 'Fill sample clinic & opening message in one click'
            : '架空の例で試せます（模擬クリニックと用件を入力）'}
        </p>
        <button
          type="button"
          data-testid="setup-fill-example-button"
          onClick={fillSample}
          className={buttonClass('secondary', 'md', 'min-h-10 shrink-0 px-3.5 text-[13px] whitespace-nowrap')}
        >
          <Wand2 className="size-4 shrink-0" aria-hidden />
          <span>{isEn ? 'Fill Example' : '例を入力'}</span>
        </button>
      </div>

      <div className="space-y-2">
        <label htmlFor="partner-name" className="block text-[15px] font-bold">
          {isEn ? (
            <>
              Clinic / Recipient Name <span className="font-normal text-ink-2">(Optional)</span>
            </>
          ) : (
            <>
              相手の名前 <span className="font-normal text-ink-2">（任意）</span>
            </>
          )}
        </label>
        <input
          id="partner-name"
          type="text"
          value={partnerName}
          maxLength={MAX_PARTNER_NAME_LENGTH}
          autoComplete="off"
          onChange={(event) => onPartnerNameChange(event.target.value)}
          placeholder={
            isEn
              ? 'e.g., [For Review/Testing] EchoBridge Care Mock Clinic'
              : '例：[審査・検証用] EchoBridge Care 模擬クリニック'
          }
          className={FIELD_CLASS}
        />
        <p className="text-[13px] text-ink-2">
          {isEn
            ? 'Used in the call header and as the clinic location in your post-call calendar preview.'
            : '画面の見出し、相手の画面の宛先、通話後の予定の場所に使います。'}
        </p>
      </div>

      {/*
        用件・読み上げる文・声を1つのまとまりにする。用件を打つと、すぐ下の文が同じ速さで変わり、
        相手に読まれる文を見ながら直せる。声はその文の直後で選ぶ。
      */}
      <div className="space-y-3">
        <div className="space-y-2">
          <label htmlFor="call-intent" className="block text-[15px] font-bold">
            {isEn ? 'Opening Message' : '最初に伝える用件'}
          </label>
          <textarea
            id="call-intent"
            value={intent}
            rows={3}
            maxLength={MAX_PATIENT_TEXT_LENGTH}
            aria-describedby="greeting-preview-label"
            onChange={(event) => onIntentChange(event.target.value)}
            placeholder={
              isEn
                ? 'e.g., I would like to book a first-time internal medicine appointment today'
                : '例：内科の初診予約をしたいです'
            }
            className={cx(FIELD_CLASS, 'resize-none leading-relaxed')}
          />
        </div>

        <div className="rounded-xl border border-voice/30 bg-voice-soft px-4 py-3">
          <p id="greeting-preview-label" className="text-[13px] font-bold text-voice-strong">
            {isEn ? 'Spoken in Japanese when answered' : '相手が応答すると、この文を読み上げます'}
          </p>
          {greeting ? (
            <p
              data-testid="greeting-preview"
              className="mt-1 text-[17px] leading-(--leading-talk) text-ink text-pretty break-words"
            >
              {greeting}
            </p>
          ) : (
            <p className="mt-1 text-[15px] leading-relaxed text-ink-2">
              {isEn
                ? 'Enter your opening message above to preview the greeting spoken to the clinic.'
                : '用件を入力すると、ここに読み上げる文が出ます。'}
            </p>
          )}
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-2 text-[15px] font-bold">
          {isEn ? 'Voice Type' : '読み上げの声'}
        </legend>
        <div className="flex flex-wrap gap-2">
          {SPEECH_VOICES.map((value) => {
            const checked = value === voice;
            return (
              <label
                key={value}
                className={cx(
                  'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border bg-surface px-4 py-2 transition-colors duration-150',
                  checked ? 'border-voice ring-1 ring-voice' : 'border-line hover:border-line-strong',
                )}
              >
                <input
                  type="radio"
                  name="voice"
                  value={value}
                  checked={checked}
                  onChange={() => onVoiceChange(value)}
                  className="size-4 accent-voice"
                />
                <span className="font-bold">{getVoiceLabel(value, userLanguage)}</span>
              </label>
            );
          })}
        </div>
        <p className="text-[13px] leading-relaxed text-ink-2 text-pretty">
          {isEn
            ? 'Synthesized in polite Japanese via Google Cloud Text-to-Speech (or device Japanese TTS fallback).'
            : 'Googleの合成音声（Cloud Text-to-Speech）で読み上げます。使えないときは、相手の端末の日本語の声で読みます。'}
        </p>
      </fieldset>

      <div className="space-y-2 border-t border-line pt-4">
        <button
          type="submit"
          disabled={!canStart}
          aria-describedby={startHint ? 'start-hint' : undefined}
          className={buttonClass('primary', 'lg', 'w-full')}
        >
          {isSandboxMode ? (
            <>
              <Bot className="size-5 shrink-0" aria-hidden />
              <span>{isEn ? 'Start Mock Clinic AI Call' : '模擬クリニックAI受付と通話する'}</span>
            </>
          ) : (
            <>
              <Phone className="size-5 shrink-0" aria-hidden />
              <span>
                {isConnected
                  ? isEn
                    ? 'Place Call'
                    : '発信する'
                  : isEn
                  ? 'Connecting to server…'
                  : 'サーバーに接続しています…'}
              </span>
            </>
          )}
        </button>
        {startHint && (
          <p id="start-hint" className="text-[13px] text-ink-2">
            {startHint}
          </p>
        )}
      </div>
    </form>
  );
}

/** 診察室でスマホを机上に平置きして使う「対面診察モード」への案内カード。 */
export function FaceToFaceConsultEntry() {
  const { userLanguage } = useUserLanguage();
  const isEn = userLanguage === 'en';
  return (
    <aside
      aria-labelledby="consult-entry-heading"
      className="rounded-xl border border-voice/40 bg-voice-soft p-5"
    >
      <div className="flex items-center gap-2">
        <Stethoscope className="size-4 shrink-0 text-voice-strong" aria-hidden />
        <h2 id="consult-entry-heading" className="text-[15px] font-bold text-ink">
          {isEn
            ? 'Face-to-Face Consultation Mode'
            : '対面診察モード（Face-to-Face Consultation）'}
        </h2>
      </div>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2 text-pretty">
        {isEn
          ? 'At the clinic desk, place your phone flat: the top 1/3 rotates 180° to show medical Japanese to the doctor, while the bottom 2/3 stays upright in English with 3-choice instant replies.'
          : '来院後の診察室でスマホを机上に平置きし、上部1/3を医師向けに180度反転表示・下部2/3を患者向けに正立表示して双方向の医療伝達を支援します。'}
      </p>
      <Link href={CONSULT_PATH} className={buttonClass('primary', 'md', 'mt-3 w-full')}>
        <Stethoscope className="size-4 shrink-0" aria-hidden />
        <span>{isEn ? 'Open Face-to-Face Mode' : '対面診察モードを開く'}</span>
      </Link>
    </aside>
  );
}

/**
 * 招待を受け取った人の入口（既存互換用にエクスポートを残す。トップ画面からは非表示）。
 */
export function JoinCallEntry() {
  return (
    <aside aria-labelledby="join-entry-heading" className="rounded-xl border border-line bg-surface p-5">
      <h2 id="join-entry-heading" className="text-[15px] font-bold">
        招待を受け取った方
      </h2>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2 text-pretty">
        届いた招待リンクを開くと、そのまま参加できます。リンクを開けないときは、相手の画面に出ている招待コードを入力してください。
      </p>
      <Link href={JOIN_PATH} className={buttonClass('secondary', 'md', 'mt-3 w-full')}>
        <LogIn className="size-4" aria-hidden />
        招待コードで通話に参加する
      </Link>
    </aside>
  );
}

/** 発信前の画面に置く、通話の流れの説明。手順は実際の順番どおり。 */
export function CallFlowGuide() {
  const { userLanguage } = useUserLanguage();
  const isEn = userLanguage === 'en';
  const steps = isEn
    ? [
        'Select the pinned Mock Clinic to test immediately with our in-browser Gemini AI receptionist (no real phone call is placed).',
        'When the clinic answers, your opening message is spoken clearly in polite Japanese.',
        "The receptionist's Japanese speech is transcribed and translated into English, with 3 context-aware reply buttons generated instantly.",
        'After the call, review transit directions on Google Maps and add your appointment to Google Calendar.',
      ]
    : [
        '模擬クリニックを選んで発信すると、ブラウザ内のGemini AI受付ボットと即座に予約通話をテストできます（外部発信は行いません）。',
        '受付が応答すると、入力した用件のあいさつを合成音声で丁寧に読み上げます。',
        '相手の話は文字で表示され、文脈に応じた3択の返答候補・即答フレーズ・自由入力から返事を選べます。',
        '通話完了後、Google Maps での経路案内と Google Calendar への予約登録プレビューを確認できます。',
      ];
  return (
    <aside aria-labelledby="flow-heading" className="rounded-xl border border-line bg-surface p-5">
      <h2 id="flow-heading" className="text-[15px] font-bold">
        {isEn ? 'How It Works' : '通話の流れ'}
      </h2>
      <ol className="mt-3 space-y-3">
        {steps.map((step, index) => (
          <li key={step} className="flex gap-3 text-[14px] leading-relaxed text-ink-2">
            <span
              aria-hidden
              className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-subtle text-[13px] font-bold text-ink tabular-nums"
            >
              {index + 1}
            </span>
            <span className="text-pretty">{step}</span>
          </li>
        ))}
      </ol>
      <p className="mt-4 border-t border-line pt-3 text-[13px] leading-relaxed text-ink-2">
        {isEn
          ? 'No app installation or login required. Sensitive medical logs are never stored permanently in the cloud.'
          : 'インストールとログインは不要です。通話の内容はクラウドに永続保存されません。'}
      </p>
    </aside>
  );
}
