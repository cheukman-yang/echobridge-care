import { stopCareSpeech } from './careSpeech';

/**
 * Next.js 16（cacheComponents / React Activity）で `/` や `/consult` のクライアント状態が保持されていても、
 * 「トップへ戻る」押下時やトップハブから「診察室で使う」を新規起動した際に、
 * 確実に初期状態（ハブ画面 ／ 対面診察 準備 Step 1）へリセットするストア。
 */
export const HOME_HUB_RESET_HREF = '/?reset=1';

export interface PendingConsultHandoff {
  clinicName: string;
  clinicAddress?: string;
  chiefComplaint: string;
  reservationId?: string;
}

let resetGeneration = 0;
let currentHomeMode: 'hub' | 'wizard' = 'hub';
const listeners = new Set<() => void>();

let consultResetGeneration = 0;
let pendingConsultHandoff: PendingConsultHandoff | null = null;
const consultListeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

function emitConsult(): void {
  consultListeners.forEach((listener) => listener());
}

export function setTrackedHomeMode(mode: 'hub' | 'wizard'): void {
  currentHomeMode = mode;
}

export function requestHomeHubReset(): void {
  stopCareSpeech();
  currentHomeMode = 'hub';
  resetGeneration += 1;
  emit();
}

export function ensureHomeHubReset(): void {
  if (currentHomeMode !== 'hub') {
    requestHomeHubReset();
  }
}

export function subscribeHomeReset(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getHomeResetSnapshot(): number {
  return resetGeneration;
}

export function getServerHomeResetSnapshot(): number {
  return 0;
}

/**
 * 対面診察画面（`/consult`）の進行ステートを初期状態（準備 Step 1）へ完全にリセットする。
 * 履歴画面からの引き継ぎデータがある場合は optional で渡せる。
 */
export function requestConsultReset(handoff?: PendingConsultHandoff | null): void {
  stopCareSpeech();
  pendingConsultHandoff = handoff ?? null;
  consultResetGeneration += 1;
  emitConsult();
}

export function consumePendingConsultHandoff(): PendingConsultHandoff | null {
  const current = pendingConsultHandoff;
  pendingConsultHandoff = null;
  return current;
}

export function subscribeConsultReset(listener: () => void): () => void {
  consultListeners.add(listener);
  return () => {
    consultListeners.delete(listener);
  };
}

export function getConsultResetSnapshot(): number {
  return consultResetGeneration;
}

export function getServerConsultResetSnapshot(): number {
  return 0;
}

export function resetHomeHubStoreForTests(): void {
  resetGeneration = 0;
  currentHomeMode = 'hub';
  consultResetGeneration = 0;
  pendingConsultHandoff = null;
}
