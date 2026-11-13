"use client";

import { useState } from 'react';
import { Bot, Building2, CheckCircle2, LoaderCircle, MapPin, Pin, Search, Sparkles, Wand2 } from 'lucide-react';
import { useUserLanguage } from '@/contexts/UserLanguageContext';
import { SANDBOX_CLINIC } from '@/lib/careTypes';
import type { ClinicCandidate, ClinicSearchResult } from '@/lib/careTypes';
import { CARE_EXAMPLES } from '@/lib/i18n';
import { buttonClass, cx } from './ui';

interface ClinicFinderCardProps {
  selectedClinic: ClinicCandidate | null;
  onSelectClinic: (clinic: ClinicCandidate | null) => void;
  onApplySuggestedIntent: (suggestedIntent: string) => void;
  onApplyPartnerName: (name: string) => void;
}

/**
 * 医療機関への連絡時：主訴・希望条件からGeminiが症状と診療科を整理し、近隣クリニック候補を表示するUI。
 * 最上部には審査員が実在の病院へ誤発信せず安全にテストできるよう「[審査・検証用] EchoBridge Care 模擬クリニック」を常時ピン留めする。
 */
export function ClinicFinderCard({
  selectedClinic,
  onSelectClinic,
  onApplySuggestedIntent,
  onApplyPartnerName,
}: ClinicFinderCardProps) {
  const { userLanguage } = useUserLanguage();
  const isEn = userLanguage === 'en';
  const [symptoms, setSymptoms] = useState('');
  const [area, setArea] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<ClinicSearchResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const clinics: ClinicCandidate[] = searchResult?.clinics ?? [SANDBOX_CLINIC];

  const handleFillExample = () => {
    const sample = CARE_EXAMPLES[userLanguage];
    setSymptoms(sample.clinicSymptoms);
    setArea(sample.clinicArea);
    setSearchError(null);
  };

  const handleSearch = async () => {
    setIsSearching(true);
    setSearchError(null);
    try {
      const response = await fetch('/api/care/clinic-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symptoms: symptoms.trim() || CARE_EXAMPLES[userLanguage].clinicSymptoms,
          area: area.trim(),
          userLanguage,
        }),
      });
      if (!response.ok) throw new Error('search_failed');
      const data = (await response.json()) as ClinicSearchResult;
      setSearchResult(data);
    } catch {
      setSearchError(
        isEn
          ? 'Could not reach clinic search API. You can still test safely with the pinned Mock Clinic below.'
          : '候補の検索に失敗しました。下のピン留め模擬クリニックはそのままご利用いただけます。',
      );
    } finally {
      setIsSearching(false);
    }
  };

  const handleToggleClinic = (clinic: ClinicCandidate) => {
    if (selectedClinic?.id === clinic.id) {
      onSelectClinic(null);
      return;
    }
    onSelectClinic(clinic);
    onApplyPartnerName(clinic.name);
  };

  return (
    <section
      aria-labelledby="clinic-finder-heading"
      data-testid="clinic-finder-card"
      className="space-y-4 rounded-xl border border-line bg-surface p-4"
    >
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Building2 className="size-4 shrink-0 text-voice-strong" aria-hidden />
          <h2 id="clinic-finder-heading" className="text-[15px] font-bold text-ink">
            {isEn
              ? 'Clinic Finder & Review Sandbox'
              : '医療機関検索・推薦 ＋ 審査用「模擬クリニック」'}
          </h2>
        </div>
        <p className="text-[13px] leading-relaxed text-ink-2">
          {isEn
            ? 'Enter your symptoms to get recommended departments from Gemini, or select the pinned Mock Clinic below to test an AI receptionist call safely in your browser.'
            : '主訴や希望条件からGeminiが症状と受診科を整理します。最上部の「模擬クリニック」を選ぶと、外部電話を発信せずブラウザ内でAI受付ボットと予約通話をテストできます。'}
        </p>
      </div>

      {/* 主訴・希望条件からのGemini症状整理＆クリニック検索 */}
      <div className="space-y-2.5 rounded-lg border border-line bg-canvas p-3">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="clinic-symptoms-input" className="min-w-0 text-[13px] font-bold text-ink">
            {isEn ? 'Symptoms & Preferences' : '主訴・希望条件'}
          </label>
          <button
            type="button"
            data-testid="clinic-fill-example-button"
            onClick={handleFillExample}
            className={buttonClass('secondary', 'md', 'min-h-9 shrink-0 px-3 py-1 text-[13px] whitespace-nowrap')}
          >
            <Wand2 className="size-3.5 shrink-0" aria-hidden />
            <span>{isEn ? 'Fill Example' : '例を入力'}</span>
          </button>
        </div>

        <textarea
          id="clinic-symptoms-input"
          rows={3}
          value={symptoms}
          onChange={(event) => setSymptoms(event.target.value)}
          placeholder={
            isEn
              ? 'e.g., 38°C fever and sore throat since last night, looking for internal medicine today'
              : '例：昨日の夜から38度の熱と喉の痛みがあります。今日受診できる内科を予約したいです。'
          }
          className="w-full resize-none rounded-lg border border-line-strong bg-surface px-3 py-2 text-[14px] leading-relaxed text-ink placeholder:text-ink-2/70 focus:border-voice"
        />

        {/* モバイル筐体幅（max-w-md）で文字が縦折れしないよう、エリア欄と検索ボタンは縦積み全幅にする */}
        <div className="flex flex-col gap-2">
          <input
            type="text"
            value={area}
            onChange={(event) => setArea(event.target.value)}
            aria-label={isEn ? 'Preferred Area' : '希望エリア'}
            placeholder={
              isEn
                ? 'Preferred area (optional, e.g. Shinjuku Station)'
                : '希望エリア（任意・例：新宿駅周辺）'
            }
            className="min-h-10 w-full rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-[14px] text-ink placeholder:text-ink-2/70 focus:border-voice"
          />
          <button
            type="button"
            onClick={() => void handleSearch()}
            disabled={isSearching}
            className={buttonClass('secondary', 'md', 'w-full text-[14px] whitespace-nowrap')}
          >
            {isSearching ? (
              <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden />
            ) : (
              <Search className="size-4 shrink-0" aria-hidden />
            )}
            <span>{isEn ? 'Analyze Symptoms & Find Clinics' : '症状・診療科を整理して検索'}</span>
          </button>
        </div>

        {searchError && (
          <p role="alert" className="text-[13px] font-bold text-danger-strong">
            {searchError}
          </p>
        )}

        {searchResult && (
          <div
            data-testid="clinic-triage-result"
            className="space-y-2.5 rounded-lg border border-voice/30 bg-voice-soft p-3 text-[13px]"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-bold text-voice-strong">
                {isEn ? 'Recommended Dept:' : '推奨される診療科:'}
              </span>
              {searchResult.recommendedDepartments.map((dept) => (
                <span
                  key={dept}
                  className="rounded-full border border-voice/40 bg-surface px-2.5 py-0.5 text-[12px] font-bold text-ink"
                >
                  {dept}
                </span>
              ))}
            </div>
            <p className="leading-relaxed text-ink">
              <span className="font-bold">{isEn ? 'Organized Symptoms: ' : '症状の整理：'}</span>
              {isEn && searchResult.organizedSymptomsEn
                ? searchResult.organizedSymptomsEn
                : searchResult.organizedSymptoms}
            </p>
            {isEn && searchResult.organizedSymptomsEn && (
              <p className="text-[12px] leading-relaxed text-ink-2">🇯🇵 {searchResult.organizedSymptoms}</p>
            )}
            <p className="text-[12px] leading-relaxed text-ink-2">{searchResult.urgencyNote}</p>
            <button
              type="button"
              onClick={() => onApplySuggestedIntent(searchResult.suggestedIntent)}
              className={buttonClass('secondary', 'md', 'w-full text-[13px]')}
            >
              <Sparkles className="size-4 shrink-0 text-voice" aria-hidden />
              <span>
                {isEn
                  ? 'Copy to Opening Message'
                  : '整理した文を「最初に伝える用件」に入力する'}
              </span>
            </button>
          </div>
        )}
      </div>

      {/* 候補リスト（最上部に常時ピン留めの模擬クリニック） */}
      <div className="space-y-2.5">
        <p className="text-[13px] font-bold text-ink-2">
          {isEn
            ? 'Clinic Candidates (Pinned Sandbox at Top)'
            : 'クリニック候補リスト（最上部：審査用サンドボックス）'}
        </p>
        <ul
          className="space-y-2.5"
          aria-label={isEn ? 'Clinic candidates list' : 'クリニック候補リスト'}
        >
          {clinics.map((clinic) => {
            const isSelected = selectedClinic?.id === clinic.id;
            const displayDepartments =
              isEn && clinic.departmentsEn?.length ? clinic.departmentsEn : clinic.departments;
            const displayAddress = isEn && clinic.addressEn ? clinic.addressEn : clinic.address;
            const displayDistance =
              isEn && clinic.distanceNoteEn ? clinic.distanceNoteEn : clinic.distanceNote;
            const displayReason =
              isEn && clinic.matchReasonEn ? clinic.matchReasonEn : clinic.matchReason;

            return (
              <li
                key={clinic.id}
                data-testid={clinic.isSandbox ? 'sandbox-clinic-card' : undefined}
                className={cx(
                  'rounded-xl border p-3.5 transition-colors duration-150',
                  clinic.isSandbox
                    ? isSelected
                      ? 'border-2 border-voice bg-voice-soft'
                      : 'border-voice/50 bg-surface'
                    : isSelected
                    ? 'border-voice bg-voice-soft/50'
                    : 'border-line bg-canvas',
                )}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  {clinic.isSandbox && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-voice px-2.5 py-0.5 text-[11px] font-bold text-on-voice">
                      <Pin className="size-3" aria-hidden />
                      {isEn ? 'Always Pinned · No Real Call' : '常時ピン留め・誤発信防止'}
                    </span>
                  )}
                  {displayDepartments.map((dept) => (
                    <span
                      key={dept}
                      className="rounded-full border border-line-strong bg-surface px-2 py-0.5 text-[11px] text-ink-2"
                    >
                      {dept}
                    </span>
                  ))}
                </div>

                <p className="mt-2 text-[15px] font-bold leading-snug text-ink">
                  {isEn && clinic.nameEn ? clinic.nameEn : clinic.name}
                </p>
                {isEn && clinic.nameEn && (
                  <p className="text-[12px] font-bold text-ink-2">{clinic.name}</p>
                )}

                <p className="mt-1 flex items-start gap-1 text-[12px] text-ink-2">
                  <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>
                    {displayAddress} ({displayDistance})
                  </span>
                </p>

                {displayReason && (
                  <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">{displayReason}</p>
                )}

                <div className="mt-3">
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => handleToggleClinic(clinic)}
                    className={buttonClass(
                      isSelected ? 'primary' : clinic.isSandbox ? 'secondary' : 'quiet',
                      'md',
                      'w-full text-[13px]',
                    )}
                  >
                    {clinic.isSandbox ? (
                      <>
                        {isSelected ? (
                          <CheckCircle2 className="size-4 shrink-0" aria-hidden />
                        ) : (
                          <Bot className="size-4 shrink-0" aria-hidden />
                        )}
                        <span>
                          {isSelected
                            ? isEn
                              ? 'Selected: In-Browser AI Receptionist'
                              : '選択中：ブラウザ内 AI模擬受付ボットで通話'
                            : isEn
                            ? 'Select Mock Clinic (Safe AI Receptionist Test)'
                            : 'この模擬クリニックを選択（AI受付ボットと通話テスト）'}
                        </span>
                      </>
                    ) : (
                      <span>
                        {isSelected
                          ? isEn
                            ? 'Selected as Recipient (Tap to Clear)'
                            : '宛先に設定中（解除する）'
                          : isEn
                          ? 'Set as Recipient Name'
                          : '宛先名にセット（Web招待通話用）'}
                      </span>
                    )}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
