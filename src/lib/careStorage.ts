import type { SavedConsultationRecord, SavedReservationRecord } from './careTypes';

/**
 * センシティブな医療対話ログ・診察要約・予約引き継ぎ記録の端末ローカル保存（localStorage専用）。
 *
 * クラウド（DBやサーバーファイル）には一切永続保存せず、利用者本人のブラウザ内だけに保持する。
 */
export const CONSULTATION_STORAGE_KEY = 'echobridge.care.consultations.v1';
export const RESERVATION_STORAGE_KEY = 'echobridge.care.reservations.v1';
export const MAX_SAVED_CONSULTATIONS = 20;
export const MAX_SAVED_RESERVATIONS = 10;

const EMPTY_RECORDS: SavedConsultationRecord[] = [];
const EMPTY_RESERVATIONS: SavedReservationRecord[] = [];

const listeners = new Set<() => void>();
let memoryRaw: string | null = null;
let lastRaw: string | null | undefined;
let lastParsed: SavedConsultationRecord[] = EMPTY_RECORDS;

const reservationListeners = new Set<() => void>();
let reservationMemoryRaw: string | null = null;
let lastReservationRaw: string | null | undefined;
let lastParsedReservations: SavedReservationRecord[] = EMPTY_RESERVATIONS;

function isRecordShape(item: unknown): item is SavedConsultationRecord {
  if (typeof item !== 'object' || item === null) return false;
  const candidate = item as Partial<SavedConsultationRecord>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.clinicName === 'string' &&
    (candidate.userLanguage === 'ja' || candidate.userLanguage === 'en') &&
    Array.isArray(candidate.turns) &&
    typeof candidate.summary === 'object' &&
    candidate.summary !== null
  );
}

function isReservationShape(item: unknown): item is SavedReservationRecord {
  if (typeof item !== 'object' || item === null) return false;
  const candidate = item as Partial<SavedReservationRecord>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.clinicName === 'string' &&
    typeof candidate.symptomsMemo === 'string' &&
    (candidate.userLanguage === 'ja' || candidate.userLanguage === 'en')
  );
}

export function parseSavedConsultations(raw: string | null): SavedConsultationRecord[] {
  if (!raw) return EMPTY_RECORDS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY_RECORDS;
    return parsed.filter(isRecordShape).slice(0, MAX_SAVED_CONSULTATIONS);
  } catch {
    return EMPTY_RECORDS;
  }
}

export function parseSavedReservations(raw: string | null): SavedReservationRecord[] {
  if (!raw) return EMPTY_RESERVATIONS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY_RESERVATIONS;
    return parsed.filter(isReservationShape).slice(0, MAX_SAVED_RESERVATIONS);
  } catch {
    return EMPTY_RESERVATIONS;
  }
}

function readRaw(): string | null {
  if (memoryRaw !== null) return memoryRaw;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage?.getItem(CONSULTATION_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function readReservationRaw(): string | null {
  if (reservationMemoryRaw !== null) return reservationMemoryRaw;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage?.getItem(RESERVATION_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function getSavedConsultationsSnapshot(): SavedConsultationRecord[] {
  const raw = readRaw();
  if (raw !== lastRaw) {
    lastRaw = raw;
    lastParsed = parseSavedConsultations(raw);
  }
  return lastParsed;
}

export function getServerSavedConsultationsSnapshot(): SavedConsultationRecord[] {
  return EMPTY_RECORDS;
}

export function subscribeSavedConsultations(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window === 'undefined') {
    return () => {
      listeners.delete(listener);
    };
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === CONSULTATION_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

function writeRecords(records: readonly SavedConsultationRecord[]): boolean {
  const trimmed = records.slice(0, MAX_SAVED_CONSULTATIONS);
  const raw = JSON.stringify(trimmed);
  let persisted = true;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage?.setItem(CONSULTATION_STORAGE_KEY, raw);
      memoryRaw = null;
    } catch {
      memoryRaw = raw;
      persisted = false;
    }
  } else {
    memoryRaw = raw;
    persisted = false;
  }
  listeners.forEach((listener) => listener());
  return persisted;
}

export function saveConsultationRecord(record: SavedConsultationRecord): boolean {
  const existing = getSavedConsultationsSnapshot().filter((item) => item.id !== record.id);
  return writeRecords([record, ...existing]);
}

export function deleteConsultationRecord(id: string): void {
  const next = getSavedConsultationsSnapshot().filter((item) => item.id !== id);
  writeRecords(next);
}

export function clearSavedConsultations(): void {
  memoryRaw = null;
  lastRaw = undefined;
  lastParsed = EMPTY_RECORDS;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage?.removeItem(CONSULTATION_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  listeners.forEach((listener) => listener());
}

export function createConsultationId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  return `consult-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Saved Reservations (Step 4 -> /consult Step 1 Handoff)
// ---------------------------------------------------------------------------

export function getSavedReservationsSnapshot(): SavedReservationRecord[] {
  const raw = readReservationRaw();
  if (raw !== lastReservationRaw) {
    lastReservationRaw = raw;
    lastParsedReservations = parseSavedReservations(raw);
  }
  return lastParsedReservations;
}

export function getServerSavedReservationsSnapshot(): SavedReservationRecord[] {
  return EMPTY_RESERVATIONS;
}

export function subscribeSavedReservations(listener: () => void): () => void {
  reservationListeners.add(listener);
  if (typeof window === 'undefined') {
    return () => {
      reservationListeners.delete(listener);
    };
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === RESERVATION_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    reservationListeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

function writeReservations(records: readonly SavedReservationRecord[]): boolean {
  const trimmed = records.slice(0, MAX_SAVED_RESERVATIONS);
  const raw = JSON.stringify(trimmed);
  let persisted = true;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage?.setItem(RESERVATION_STORAGE_KEY, raw);
      reservationMemoryRaw = null;
    } catch {
      reservationMemoryRaw = raw;
      persisted = false;
    }
  } else {
    reservationMemoryRaw = raw;
    persisted = false;
  }
  reservationListeners.forEach((listener) => listener());
  return persisted;
}

export function saveReservationRecord(record: SavedReservationRecord): boolean {
  const existing = getSavedReservationsSnapshot().filter((item) => item.id !== record.id);
  return writeReservations([record, ...existing]);
}

export function deleteReservationRecord(id: string): void {
  const next = getSavedReservationsSnapshot().filter((item) => item.id !== id);
  writeReservations(next);
}

export function clearSavedReservations(): void {
  reservationMemoryRaw = null;
  lastReservationRaw = undefined;
  lastParsedReservations = EMPTY_RESERVATIONS;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage?.removeItem(RESERVATION_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  reservationListeners.forEach((listener) => listener());
}

export function createReservationId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  return `resv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
