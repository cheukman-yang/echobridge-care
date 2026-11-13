"use client";

import { useState } from 'react';
import Link from 'next/link';
import {
  CalendarPlus,
  ClipboardList,
  Home,
  MapPin,
  Pill,
  Plus,
  RotateCcw,
  Stethoscope,
} from 'lucide-react';
import { useUserLanguage } from '@/contexts/UserLanguageContext';
import {
  buildCalendarAllDayUrl,
  buildCalendarDayUrl,
  buildCalendarUrl,
  formatDateJa,
  isValidDate,
  isValidTime,
  tokyoToday,
} from '@/lib/appointment';
import { SANDBOX_CLINIC } from '@/lib/careTypes';
import type { ConsultationSummary, ConsultationTurn, DoctorLanguage } from '@/lib/careTypes';
import { HOME_HUB_RESET_HREF, requestConsultReset, requestHomeHubReset } from '@/lib/homeReset';
import type { UserLanguage } from '@/lib/userLanguage';
import { CareAiModeBadge } from './CareAiModeBadge';
import { LocalStorageBadge } from './LocalStorageBadge';
import { SectionHeading, buttonClass } from './ui';

interface ConsultationSummaryCardProps {
  clinicName: string;
  clinicAddress?: string;
  userLanguage?: UserLanguage;
  doctorLanguage?: DoctorLanguage;
  summary: ConsultationSummary;
  turns: ConsultationTurn[];
  savedLocally: boolean;
  onStartNew: () => void;
}

/**
 * 対面診察終了後のGemini構造化要約（主訴・診断ポイント・処方/指示）と次回受診日の自動抽出・Google Calendar登録画面。
 */
export function ConsultationSummaryCard({
  clinicName,
  clinicAddress,
  userLanguage: propLanguage,
  doctorLanguage = 'ja',
  summary,
  turns,
  savedLocally,
  onStartNew,
}: ConsultationSummaryCardProps) {
  const { userLanguage: contextLanguage } = useUserLanguage();
  const activeLanguage = contextLanguage ?? propLanguage ?? 'ja';
  const isEn = activeLanguage === 'en';
  const isOverseasEnDoctor = doctorLanguage === 'en';

  const hasExplicitFollowUp = Boolean(
    summary.followUp.spokenText || summary.followUp.recommendedDate,
  );
  const [isFollowUpOpen, setIsFollowUpOpen] = useState<boolean>(hasExplicitFollowUp);

  const [followUpDate, setFollowUpDate] = useState<string>(
    summary.followUp.recommendedDate ?? tokyoToday(new Date()),
  );
  const [followUpTime, setFollowUpTime] = useState<string>(
    summary.followUp.recommendedStartTime ?? '',
  );
  const [followUpTitle, setFollowUpTitle] = useState<string>(
    summary.followUp.title ||
      (isEn ? `Follow-up Visit (${clinicName})` : `再診予定（${clinicName}）`),
  );

  const resolvedDefaultAddress =
    clinicAddress !== undefined && clinicAddress.trim() !== ''
      ? clinicAddress.trim()
      : clinicName.includes('EchoBridge Care')
        ? isEn && SANDBOX_CLINIC.addressEn
          ? SANDBOX_CLINIC.addressEn
          : SANDBOX_CLINIC.address
        : '';

  const [followUpAddress, setFollowUpAddress] = useState<string>(resolvedDefaultAddress);

  const trimmedTime = followUpTime.trim();
  const trimmedAddress = followUpAddress.trim();
  const isAllDayFollowUp = trimmedTime === '';
  const canOpenCalendar =
    isValidDate(followUpDate) &&
    Boolean(followUpTitle.trim()) &&
    (isAllDayFollowUp || isValidTime(trimmedTime));
  const calendarHref = canOpenCalendar
    ? isAllDayFollowUp
      ? buildCalendarAllDayUrl({
          title: followUpTitle.trim(),
          date: followUpDate,
          location: clinicName,
          address: trimmedAddress,
          details: summary.followUp.details,
        })
      : buildCalendarUrl({
          title: followUpTitle.trim(),
          date: followUpDate,
          startTime: trimmedTime,
          endTime: null,
          location: clinicName,
          address: trimmedAddress,
          details: summary.followUp.details,
        })
    : null;

  const handleBackToTop = () => {
    onStartNew();
    requestConsultReset();
    requestHomeHubReset();
  };

  return (
    <div className="mx-auto w-full max-w-md space-y-5 px-4 py-6" data-testid="consultation-summary-card">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <CareAiModeBadge ai={summary.ai} compact />
          {isOverseasEnDoctor && (
            <span className="inline-flex items-center rounded-full bg-voice-soft px-2.5 py-0.5 text-[11px] font-bold text-voice-strong">
              ✈️ 患者: 日本語 ⇄ 医師: English
            </span>
          )}
        </div>
        <h1 className="text-[22px] font-bold leading-snug text-ink">
          {isEn ? 'Consultation Summary & Follow-up' : '診察内容の要約・次回受診メモ'}
        </h1>
        <p className="text-[13px] text-ink-2">
          {savedLocally
            ? isEn
              ? 'Your consultation transcript and structured summary were safely saved in this browser (localStorage).'
              : '診察ログと構造化要約をこの端末のブラウザ（localStorage）に安全に保存しました。'
            : isEn
            ? 'Browser storage is restricted in this mode, but you can review your summary below.'
            : 'ブラウザの設定により端末保存が制限されていますが、この画面で内容を確認できます。'}
        </p>
      </div>

      <LocalStorageBadge />

      {/* 1. 主訴 */}
      <section className="space-y-2 rounded-xl border border-line bg-surface p-4">
        <div className="flex items-center gap-2">
          <ClipboardList className="size-4 shrink-0 text-voice-strong" aria-hidden />
          <h2 className="text-[15px] font-bold text-ink">
            {isEn ? 'Chief Complaint' : '主訴'}
          </h2>
        </div>
        {isEn && summary.chiefComplaintEn ? (
          <>
            <p className="text-[15px] font-bold leading-relaxed text-ink">🇺🇸 {summary.chiefComplaintEn}</p>
            <p className="text-[13px] leading-relaxed text-ink-2">🇯🇵 {summary.chiefComplaint}</p>
          </>
        ) : (
          <>
            <p className="text-[15px] leading-relaxed text-ink">{summary.chiefComplaint}</p>
            {isOverseasEnDoctor && summary.chiefComplaintEn && (
              <p className="text-[12px] leading-relaxed text-ink-2">🇺🇸 {summary.chiefComplaintEn}</p>
            )}
          </>
        )}
      </section>

      {/* 2. 診断ポイント */}
      <section
        data-testid="summary-diagnostic-points-section"
        className="space-y-2.5 rounded-xl border border-line bg-surface p-4"
      >
        <div className="flex items-center gap-2">
          <Stethoscope className="size-4 shrink-0 text-voice-strong" aria-hidden />
          <h2 className="text-[15px] font-bold text-ink">
            {isEn ? 'Key Diagnostic Points' : '診断・診察のポイント'}
          </h2>
        </div>
        <ul className="list-disc space-y-1.5 pl-5 text-[14px] leading-relaxed text-ink">
          {summary.diagnosticPoints.map((point, idx) => {
            const cleanedPoint = point.replace(/^[・•\-]\s*/, '');
            const enPoint = summary.diagnosticPointsEn?.[idx]?.replace(/^[・•\-]\s*/, '');
            return (
              <li key={`${idx}-${cleanedPoint}`}>
                {isEn && enPoint ? (
                  <>
                    <span className="font-bold">🇺🇸 {enPoint}</span>
                    <span className="mt-0.5 block text-[12px] text-ink-2">🇯🇵 {cleanedPoint}</span>
                  </>
                ) : (
                  <>
                    <span>{cleanedPoint}</span>
                    {isOverseasEnDoctor && enPoint && (
                      <span className="mt-0.5 block text-[12px] text-ink-2">🇺🇸 {enPoint}</span>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* 3. 処方・指示 */}
      <section
        data-testid="summary-prescriptions-section"
        className="space-y-2.5 rounded-xl border border-line bg-surface p-4"
      >
        <div className="flex items-center gap-2">
          <Pill className="size-4 shrink-0 text-voice-strong" aria-hidden />
          <h2 className="text-[15px] font-bold text-ink">
            {isEn ? 'Prescriptions & Instructions' : '処方・療養の指示'}
          </h2>
        </div>
        <ul className="list-disc space-y-1.5 pl-5 text-[14px] leading-relaxed text-ink">
          {summary.prescriptionsAndInstructions.map((item, idx) => {
            const cleanedItem = item.replace(/^[・•\-]\s*/, '');
            const enItem = summary.prescriptionsAndInstructionsEn?.[idx]?.replace(/^[・•\-]\s*/, '');
            return (
              <li key={`${idx}-${cleanedItem}`}>
                {isEn && enItem ? (
                  <>
                    <span className="font-bold">🇺🇸 {enItem}</span>
                    <span className="mt-0.5 block text-[12px] text-ink-2">🇯🇵 {cleanedItem}</span>
                  </>
                ) : (
                  <>
                    <span>{cleanedItem}</span>
                    {isOverseasEnDoctor && enItem && (
                      <span className="mt-0.5 block text-[12px] text-ink-2">🇺🇸 {enItem}</span>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* 4. 再診日の自動抽出 ＋ Google Calendar 登録（明確な再診時期がない場合は初期折りたたみ） */}
      <section
        aria-labelledby="followup-calendar-heading"
        className="space-y-3 rounded-xl border border-voice/40 bg-voice-soft p-4"
      >
        <SectionHeading id="followup-calendar-heading">
          {isEn ? 'Next Visit / Follow-up Calendar' : '次回受診（再診）のカレンダー登録'}
        </SectionHeading>

        {summary.followUp.spokenText ? (
          <p className="rounded-lg bg-surface px-3 py-2 text-[13px] font-bold text-voice-strong">
            {isEn
              ? `Extracted from conversation: "${summary.followUp.spokenText}"`
              : `会話からの抽出：「${summary.followUp.spokenText}」`}
          </p>
        ) : (
          <p className="text-[13px] text-ink-2">
            {isEn
              ? 'No explicit follow-up timeframe was mentioned during this consultation.'
              : '対話内で明確な次回受診時期の指示はありませんでした。'}
          </p>
        )}

        {!isFollowUpOpen ? (
          <button
            type="button"
            data-testid="expand-manual-followup-button"
            onClick={() => setIsFollowUpOpen(true)}
            className={buttonClass('accent', 'md', 'w-full text-[13px]')}
          >
            <Plus className="size-4 shrink-0 text-voice-strong" aria-hidden />
            <span>
              {isEn
                ? '＋ Manually Add a Next Visit to Calendar (Optional)'
                : '＋ 必要に応じて次回の受診予定を手動で登録する'}
            </span>
          </button>
        ) : (
          <>
            <div className="space-y-2.5">
              <label className="block space-y-1">
                <span className="block text-[12px] font-bold text-ink-2">
                  {isEn ? 'Event Title' : '予定タイトル'}
                </span>
                <input
                  type="text"
                  value={followUpTitle}
                  onChange={(event) => setFollowUpTitle(event.target.value)}
                  className="min-h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-[14px] text-ink"
                />
              </label>

              <label className="block space-y-1">
                <span className="flex items-center gap-1 text-[12px] font-bold text-ink-2">
                  <MapPin className="size-3.5 shrink-0 text-voice-strong" aria-hidden />
                  <span>{isEn ? 'Clinic Address / Location' : '医療機関の住所（場所）'}</span>
                </span>
                <input
                  type="text"
                  data-testid="followup-clinic-address-input"
                  aria-label={isEn ? 'Clinic Address / Location' : '医療機関の住所（場所）'}
                  value={followUpAddress}
                  onChange={(event) => setFollowUpAddress(event.target.value)}
                  placeholder={
                    isEn
                      ? 'e.g., 1-9-1 Marunouchi, Chiyoda-ku, Tokyo'
                      : '例：東京都千代田区丸の内1-9-1'
                  }
                  className="min-h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-[14px] text-ink"
                />
              </label>

              <div className="grid grid-cols-2 gap-2.5">
                <label className="block space-y-1">
                  <span className="block text-[12px] font-bold text-ink-2">
                    {isEn ? 'Follow-up Date' : '再診予定日'}
                  </span>
                  <input
                    type="date"
                    aria-label={isEn ? 'Follow-up Date' : '再診予定日'}
                    value={followUpDate}
                    onChange={(event) => setFollowUpDate(event.target.value)}
                    className="min-h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-[14px] text-ink"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="block text-[12px] font-bold text-ink-2">
                    {isEn ? 'Start Time' : '開始時刻'}
                  </span>
                  <input
                    type="time"
                    aria-label={isEn ? 'Start Time' : '開始時刻'}
                    value={followUpTime}
                    onChange={(event) => setFollowUpTime(event.target.value)}
                    className="min-h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-[14px] text-ink"
                  />
                </label>
              </div>

              {isValidDate(followUpDate) && (
                <p className="text-[13px] font-bold text-ink">
                  {isEn
                    ? new Date(`${followUpDate}T00:00:00+09:00`).toLocaleDateString('en-US', {
                        weekday: 'short',
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                        timeZone: 'Asia/Tokyo',
                      })
                    : formatDateJa(followUpDate)}
                </p>
              )}

              {isAllDayFollowUp && (
                <p className="text-[12px] text-ink-2" data-testid="followup-allday-hint">
                  {isEn
                    ? 'No specific time was stated — registers as an All-Day event (or select a time above).'
                    : '会話内で時刻の指定がないため「終日予定」として登録します（時刻を入力すると時間指定になります）。'}
                </p>
              )}
            </div>

            {calendarHref && (
              <a
                href={calendarHref}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="followup-calendar-link"
                className={buttonClass('primary', 'lg', 'w-full')}
              >
                <CalendarPlus className="size-5 shrink-0" aria-hidden />
                <span>
                  {isEn ? 'Add Follow-up to Google Calendar' : 'Google Calendar に再診予定を登録'}
                </span>
              </a>
            )}

            <a
              href={buildCalendarDayUrl(followUpDate)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-[13px] font-bold text-voice-strong underline underline-offset-2"
            >
              {isEn ? 'View this day in Google Calendar' : 'この日のGoogleカレンダー予定を確認する'}
            </a>
          </>
        )}
      </section>

      {/* 対話ログ控え */}
      <details className="rounded-xl border border-line bg-surface">
        <summary className="flex min-h-11 cursor-pointer items-center justify-between px-4 py-3 text-[14px] font-bold text-ink">
          <span>
            {isEn
              ? 'View Consultation Transcript (Saved Locally)'
              : '対面診察の対話ログを見る（端末ローカル保存）'}
          </span>
          <span className="shrink-0 font-normal text-ink-2">
            {isEn ? `${turns.length} turns` : `${turns.length}件`}
          </span>
        </summary>
        <ol className="space-y-2.5 border-t border-line px-4 py-3 text-[14px]">
          {turns.map((turn) => (
            <li key={turn.id} className="space-y-0.5">
              <p className="text-[12px] font-bold text-ink-2">
                {turn.speaker === 'doctor'
                  ? isEn
                    ? 'Doctor'
                    : isOverseasEnDoctor
                    ? '医師（English）'
                    : '医師'
                  : isEn
                  ? 'You (Patient)'
                  : '患者（あなた）'}
              </p>
              <p className="text-ink">{turn.japaneseText}</p>
              {turn.englishText && <p className="text-[12px] text-ink-2">🇺🇸 {turn.englishText}</p>}
            </li>
          ))}
        </ol>
      </details>

      <div className="space-y-2.5 pt-1">
        <Link
          href={HOME_HUB_RESET_HREF}
          onClick={handleBackToTop}
          data-testid="consult-back-to-top-link"
          className={buttonClass('primary', 'lg', 'w-full')}
        >
          <Home className="size-4 shrink-0" aria-hidden />
          <span>{isEn ? 'Back to Home' : 'トップへ戻る'}</span>
        </Link>

        <button type="button" onClick={onStartNew} className={buttonClass('secondary', 'md', 'w-full')}>
          <RotateCcw className="size-4 shrink-0" aria-hidden />
          <span>{isEn ? 'Start Another Consultation' : '新しい対面診察を始める'}</span>
        </button>
      </div>
    </div>
  );
}
