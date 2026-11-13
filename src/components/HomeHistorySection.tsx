"use client";

import { useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import {
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Phone,
  Stethoscope,
  Trash2,
} from 'lucide-react';
import { useUserLanguage } from '@/contexts/UserLanguageContext';
import {
  deleteConsultationRecord,
  deleteReservationRecord,
  getSavedConsultationsSnapshot,
  getSavedReservationsSnapshot,
  getServerSavedConsultationsSnapshot,
  getServerSavedReservationsSnapshot,
  subscribeSavedConsultations,
  subscribeSavedReservations,
} from '@/lib/careStorage';
import { CONSULT_PATH } from '@/lib/careTypes';
import type { SavedConsultationRecord, SavedReservationRecord } from '@/lib/careTypes';
import { requestConsultReset } from '@/lib/homeReset';
import { buttonClass, cx } from './ui';

export interface RebookingHandoffPayload {
  clinicName: string;
  clinicAddress?: string;
  symptomsMemo: string;
  originLocation?: string;
}

interface HomeHistorySectionProps {
  onStartRebooking: (payload: RebookingHandoffPayload) => void;
}

type UnifiedPreviewItem =
  | { kind: 'consultation'; createdAt: string; record: SavedConsultationRecord }
  | { kind: 'reservation'; createdAt: string; record: SavedReservationRecord };

export function HomeHistorySection({ onStartRebooking }: HomeHistorySectionProps) {
  const { userLanguage } = useUserLanguage();
  const isEn = userLanguage === 'en';
  const [isExpanded, setIsExpanded] = useState(false);

  const savedConsultations = useSyncExternalStore(
    subscribeSavedConsultations,
    getSavedConsultationsSnapshot,
    getServerSavedConsultationsSnapshot,
  );
  const savedReservations = useSyncExternalStore(
    subscribeSavedReservations,
    getSavedReservationsSnapshot,
    getServerSavedReservationsSnapshot,
  );

  const totalCount = savedConsultations.length + savedReservations.length;

  const latestItem: UnifiedPreviewItem | null = (() => {
    const candidates: UnifiedPreviewItem[] = [];
    if (savedConsultations[0]) {
      candidates.push({
        kind: 'consultation',
        createdAt: savedConsultations[0].createdAt,
        record: savedConsultations[0],
      });
    }
    if (savedReservations[0]) {
      candidates.push({
        kind: 'reservation',
        createdAt: savedReservations[0].createdAt,
        record: savedReservations[0],
      });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return candidates[0] ?? null;
  })();

  const formatRecordDate = (iso: string) => {
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return iso.slice(0, 10);
    return parsed.toLocaleDateString(isEn ? 'en-US' : 'ja-JP', {
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <section
      data-testid="hub-history-section"
      aria-labelledby="hub-history-heading"
      className="rounded-2xl border border-line bg-surface/85 px-4 py-3.5 shadow-2xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="hub-history-heading"
          className="flex items-center gap-1.5 text-[13px] font-bold text-ink"
        >
          <ClipboardList className="size-4 shrink-0 text-voice-strong" aria-hidden />
          <span>
            {isEn
              ? '📋 Past Bookings & Consultation Records (Saved Locally)'
              : '📋 過去の予約・受診記録（端末ローカル保存）'}
          </span>
        </h2>

        <span
          data-testid="hub-history-counts"
          className="rounded-full border border-line bg-canvas px-2.5 py-0.5 text-[11px] font-bold text-ink-2"
        >
          {isEn
            ? `Bookings ${savedReservations.length} · Consults ${savedConsultations.length}`
            : `予約 ${savedReservations.length}件・受診 ${savedConsultations.length}件`}
        </span>
      </div>

      {totalCount === 0 ? (
        <p
          data-testid="hub-history-empty"
          className="mt-1.5 text-[12px] leading-relaxed text-ink-2"
        >
          {isEn
            ? 'No local history yet. Completed bookings and consultation summaries are saved strictly in this browser for 1-tap follow-up.'
            : 'まだ履歴はありません。予約通話や対面診察を完了すると、このブラウザ内（localStorage）だけに安全保存され、ここから確認・引き継ぎができます。'}
        </p>
      ) : (
        <div className="mt-2.5 space-y-2.5">
          {/* 直近1件の控えめなプレビュー（クリックで履歴一覧を開閉） */}
          {latestItem && (
            <button
              type="button"
              data-testid="hub-history-latest-preview"
              aria-expanded={isExpanded}
              onClick={() => setIsExpanded((prev) => !prev)}
              className="flex w-full items-center justify-between gap-2.5 rounded-xl border border-line-strong bg-canvas px-3 py-2 text-left transition-colors hover:border-voice hover:bg-voice-soft/40"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-2">
                  <span className="rounded bg-voice-soft px-1.5 py-0.5 font-bold text-voice-strong">
                    {latestItem.kind === 'consultation'
                      ? isEn
                        ? 'Latest Consult'
                        : '直近の受診記録'
                      : isEn
                      ? 'Latest Booking'
                      : '直近の予約記録'}
                  </span>
                  <span>{formatRecordDate(latestItem.createdAt)}</span>
                  <span className="truncate font-medium text-ink">
                    {latestItem.kind === 'reservation' && isEn && latestItem.record.clinicNameEn
                      ? latestItem.record.clinicNameEn
                      : latestItem.record.clinicName}
                  </span>
                </div>
                <p className="truncate text-[13px] font-bold text-ink">
                  {latestItem.kind === 'consultation'
                    ? isEn && latestItem.record.summary.chiefComplaintEn
                      ? latestItem.record.summary.chiefComplaintEn
                      : latestItem.record.summary.chiefComplaint
                    : latestItem.record.symptomsMemo}
                </p>
              </div>
              <span
                data-testid="hub-history-toggle-button"
                className={cx(
                  'inline-flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-bold',
                  isExpanded
                    ? 'border-voice bg-voice text-on-voice'
                    : 'border-voice/50 bg-voice-soft text-voice-strong',
                )}
              >
                <span>
                  {isExpanded
                    ? isEn
                      ? 'Close'
                      : '閉じる'
                    : isEn
                    ? 'Details & Handoff'
                    : '確認・引き継ぎ'}
                </span>
                {isExpanded ? (
                  <ChevronUp className="size-3.5" aria-hidden />
                ) : (
                  <ChevronDown className="size-3.5" aria-hidden />
                )}
              </span>
            </button>
          )}

          {isExpanded && (
            <div
              data-testid="hub-history-list-panel"
              className="space-y-3 border-t border-line pt-2.5"
            >
              {/* 保存済み診察要約・処方内容一覧 */}
              {savedConsultations.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[11px] font-bold text-ink-2">
                    {isEn
                      ? `🩺 Consultation Summaries & Prescriptions (${savedConsultations.length})`
                      : `🩺 診察要約・処方内容（${savedConsultations.length}件）`}
                  </p>
                  {savedConsultations.map((rec) => {
                    const complaint =
                      isEn && rec.summary.chiefComplaintEn
                        ? rec.summary.chiefComplaintEn
                        : rec.summary.chiefComplaint;
                    const diagnosticPoints =
                      isEn && rec.summary.diagnosticPointsEn?.length
                        ? rec.summary.diagnosticPointsEn
                        : rec.summary.diagnosticPoints;
                    const prescriptions =
                      isEn && rec.summary.prescriptionsAndInstructionsEn?.length
                        ? rec.summary.prescriptionsAndInstructionsEn
                        : rec.summary.prescriptionsAndInstructions;

                    return (
                      <div
                        key={rec.id}
                        data-testid={`hub-history-consult-item-${rec.id}`}
                        className="space-y-2 rounded-xl border border-line-strong bg-canvas p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <p className="text-[11px] font-medium text-ink-2">
                              {formatRecordDate(rec.createdAt)} ・ {rec.clinicName}
                            </p>
                            <p className="text-[13px] font-bold text-ink">{complaint}</p>
                          </div>
                          <button
                            type="button"
                            aria-label={
                              isEn ? 'Delete consultation record' : 'この受診記録を削除'
                            }
                            onClick={() => deleteConsultationRecord(rec.id)}
                            className="rounded-md p-1.5 text-ink-2 hover:bg-danger-soft hover:text-danger-strong"
                          >
                            <Trash2 className="size-3.5" aria-hidden />
                          </button>
                        </div>

                        <div className="space-y-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-[12px]">
                          <div>
                            <p className="font-bold text-voice-strong">
                              {isEn ? 'Diagnostic Points' : '診断・診察のポイント'}
                            </p>
                            <ul className="list-disc space-y-0.5 pl-4 text-ink">
                              {diagnosticPoints.map((pt, idx) => (
                                <li key={`${rec.id}-dp-${idx}`}>{pt}</li>
                              ))}
                            </ul>
                          </div>
                          <div>
                            <p className="font-bold text-voice-strong">
                              {isEn ? 'Prescriptions & Instructions' : '処方・今後の指示'}
                            </p>
                            <ul className="list-disc space-y-0.5 pl-4 text-ink">
                              {prescriptions.map((pr, idx) => (
                                <li key={`${rec.id}-pr-${idx}`}>{pr}</li>
                              ))}
                            </ul>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            data-testid={`history-rebook-consult-${rec.id}`}
                            onClick={() =>
                              onStartRebooking({
                                clinicName: rec.clinicName,
                                clinicAddress: rec.clinicAddress,
                                symptomsMemo: isEn
                                  ? `Follow-up visit regarding: ${complaint}`
                                  : `前回受診（${complaint}）の経過・再診予約をお願いしたいです`,
                              })
                            }
                            className={buttonClass(
                              'secondary',
                              'md',
                              'min-h-9 px-2.5 text-[12px] whitespace-nowrap',
                            )}
                          >
                            <Phone className="size-3.5 shrink-0" aria-hidden />
                            <span>{isEn ? 'Re-book Call' : '再診予約へ'}</span>
                          </button>
                          <Link
                            href={CONSULT_PATH}
                            data-testid={`history-handoff-consult-${rec.id}`}
                            onClick={() =>
                              requestConsultReset({
                                clinicName: rec.clinicName,
                                clinicAddress: rec.clinicAddress,
                                chiefComplaint: complaint,
                              })
                            }
                            className={buttonClass(
                              'primary',
                              'md',
                              'min-h-9 px-2.5 text-[12px] whitespace-nowrap',
                            )}
                          >
                            <Stethoscope className="size-3.5 shrink-0" aria-hidden />
                            <span>{isEn ? 'To Consult' : '対面診察へ'}</span>
                          </Link>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 保存済み電話予約記録一覧 */}
              {savedReservations.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[11px] font-bold text-ink-2">
                    {isEn
                      ? `🏥 Saved Phone Bookings (${savedReservations.length})`
                      : `🏥 電話予約の記録（${savedReservations.length}件）`}
                  </p>
                  {savedReservations.map((rec) => {
                    const displayClinic =
                      isEn && rec.clinicNameEn ? rec.clinicNameEn : rec.clinicName;
                    return (
                      <div
                        key={rec.id}
                        data-testid={`hub-history-reservation-item-${rec.id}`}
                        className="space-y-2 rounded-xl border border-line-strong bg-canvas p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <p className="text-[12px] font-bold text-ink">{displayClinic}</p>
                            {(rec.date || rec.startTime) && (
                              <p className="text-[11px] font-medium text-voice-strong">
                                {isEn ? 'Booked:' : '予約日時:'} {rec.date ?? ''}{' '}
                                {rec.startTime ?? ''}
                              </p>
                            )}
                            <p className="text-[12px] leading-snug text-ink-2">
                              {rec.symptomsMemo}
                            </p>
                          </div>
                          <button
                            type="button"
                            aria-label={isEn ? 'Delete booking record' : 'この予約記録を削除'}
                            onClick={() => deleteReservationRecord(rec.id)}
                            className="rounded-md p-1.5 text-ink-2 hover:bg-danger-soft hover:text-danger-strong"
                          >
                            <Trash2 className="size-3.5" aria-hidden />
                          </button>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            data-testid={`history-rebook-reservation-${rec.id}`}
                            onClick={() =>
                              onStartRebooking({
                                clinicName: displayClinic,
                                clinicAddress: rec.address,
                                symptomsMemo: rec.symptomsMemo,
                                originLocation: rec.originLocation,
                              })
                            }
                            className={buttonClass(
                              'secondary',
                              'md',
                              'min-h-9 px-2.5 text-[12px] whitespace-nowrap',
                            )}
                          >
                            <Phone className="size-3.5 shrink-0" aria-hidden />
                            <span>{isEn ? 'Re-book Call' : '再予約へ'}</span>
                          </button>
                          <Link
                            href={CONSULT_PATH}
                            data-testid={`history-handoff-reservation-${rec.id}`}
                            onClick={() =>
                              requestConsultReset({
                                clinicName: displayClinic,
                                clinicAddress: rec.address,
                                chiefComplaint: rec.symptomsMemo,
                                reservationId: rec.id,
                              })
                            }
                            className={buttonClass(
                              'primary',
                              'md',
                              'min-h-9 px-2.5 text-[12px] whitespace-nowrap',
                            )}
                          >
                            <Stethoscope className="size-3.5 shrink-0" aria-hidden />
                            <span>{isEn ? 'To Consult' : '対面診察へ'}</span>
                          </Link>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
