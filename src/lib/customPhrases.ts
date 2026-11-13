import { MAX_PATIENT_TEXT_LENGTH } from './callProtocol';

/**
 * 本人が登録した、よく使う文（自己紹介、体の状態の説明など）。
 *
 * この端末のブラウザ（localStorage）にだけ保存し、サーバーにもAIにも送らない。
 * 相手に届くのは、通話中に本人が「送る」を押したときだけで、文は書き換えない。
 * 個人的な内容を含みうるので、画面で保存先と削除の方法を必ず示す。
 */
export interface CustomPhrase {
  id: string;
  text: string;
}

export const CUSTOM_PHRASES_KEY = 'echobridge.customPhrases.v1';
export const MAX_CUSTOM_PHRASES = 20;

/** 読み上げに改行の意味はないので空白にし、前後の空白を除く。 */
export function normalizePhraseText(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

/** 登録できる文か。空、長すぎ、上限を超える場合は理由を返す。 */
export function validatePhrase(
  text: string,
  phrases: readonly CustomPhrase[],
  editingId: string | null = null,
): 'empty' | 'too_long' | 'duplicate' | 'full' | null {
  const normalized = normalizePhraseText(text);
  if (!normalized) return 'empty';
  if (normalized.length > MAX_PATIENT_TEXT_LENGTH) return 'too_long';
  if (phrases.some((phrase) => phrase.text === normalized && phrase.id !== editingId)) return 'duplicate';
  if (editingId === null && phrases.length >= MAX_CUSTOM_PHRASES) return 'full';
  return null;
}

export function parseCustomPhrases(raw: string | null): CustomPhrase[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is CustomPhrase =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as CustomPhrase).id === 'string' &&
          typeof (item as CustomPhrase).text === 'string',
      )
      .map(({ id, text }) => ({ id, text: normalizePhraseText(text).slice(0, MAX_PATIENT_TEXT_LENGTH) }))
      .filter((phrase) => phrase.text !== '')
      .slice(0, MAX_CUSTOM_PHRASES);
  } catch {
    return [];
  }
}

/** LANのhttpの画面では crypto.randomUUID が使えないので、代わりの値を作る。 */
export function createPhraseId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// --- 端末への保存（useSyncExternalStore 用） -------------------------------

export const DEFAULT_CARE_CUSTOM_PHRASE_ID = 'care-default-preset-1';
export const DEFAULT_CARE_CUSTOM_PHRASE_TEXT: Record<'ja' | 'en', string> = {
  ja: '発話や聞き取りにサポートが必要なため、AI音声と画面表示でお話ししています。ゆっくりお話しいただけると助かります。',
  en: 'I use AI voice and text support to communicate. Please speak slowly and clearly.',
};

const DEFAULT_CARE_PRESET_JA: CustomPhrase[] = [
  { id: DEFAULT_CARE_CUSTOM_PHRASE_ID, text: DEFAULT_CARE_CUSTOM_PHRASE_TEXT.ja },
];
const DEFAULT_CARE_PRESET_EN: CustomPhrase[] = [
  { id: DEFAULT_CARE_CUSTOM_PHRASE_ID, text: DEFAULT_CARE_CUSTOM_PHRASE_TEXT.en },
];

const EMPTY: CustomPhrase[] = [];
const listeners = new Set<() => void>();
/** 保存に失敗したとき（プライベートモードなど）の、この画面の中だけの値。 */
let memoryRaw: string | null = null;
let lastRaw: string | null | undefined;
let lastValue: CustomPhrase[] = EMPTY;

function readRaw(): string | null {
  if (memoryRaw !== null) return memoryRaw;
  try {
    return window.localStorage.getItem(CUSTOM_PHRASES_KEY);
  } catch {
    return null;
  }
}

/**
 * localStorage にまだ登録文データが一度も保存されていない（null）初回アクセス状態か判定する。
 * ユーザーが削除・全削除（空配列 '[]' 保存）や編集を行った後は false になる。
 */
export function isCustomPhrasesUninitialized(): boolean {
  return readRaw() === null;
}

export function getCustomPhrasesSnapshot(): CustomPhrase[] {
  const raw = readRaw();
  if (raw !== lastRaw) {
    lastRaw = raw;
    lastValue = parseCustomPhrases(raw);
  }
  return lastValue;
}

/**
 * EchoBridge Care 用の登録文リストを取得する。
 * localStorage が null（初回アクセス時）の場合はアプリ言語に応じたデフォルト1件を自動プリセットし、
 * ユーザーが削除・編集・全削除した場合はその保存内容（0件を含む）をそのまま尊重する。
 */
export function getCareCustomPhrasesSnapshot(userLanguage: 'ja' | 'en'): CustomPhrase[] {
  if (!isCustomPhrasesUninitialized()) {
    return getCustomPhrasesSnapshot();
  }
  return userLanguage === 'en' ? DEFAULT_CARE_PRESET_EN : DEFAULT_CARE_PRESET_JA;
}

/** サーバーでの描画と、読み込み直後の描画は空にする。保存した文は描画の後に出る。 */
export function getServerCustomPhrasesSnapshot(): CustomPhrase[] {
  return EMPTY;
}

export function subscribeCustomPhrases(listener: () => void): () => void {
  listeners.add(listener);
  // 別のタブで変えた分も反映する。
  const onStorage = (event: StorageEvent) => {
    if (event.key === CUSTOM_PHRASES_KEY || event.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** 保存する。端末に保存できなかったら false を返し、この画面の中だけで保つ。 */
export function saveCustomPhrases(phrases: readonly CustomPhrase[]): boolean {
  const raw = JSON.stringify(phrases);
  let persisted = true;
  try {
    window.localStorage.setItem(CUSTOM_PHRASES_KEY, raw);
    memoryRaw = null;
  } catch {
    memoryRaw = raw;
    persisted = false;
  }
  listeners.forEach((listener) => listener());
  return persisted;
}

/** 端末からも、この画面の中からも消す。 */
export function clearCustomPhrases(): void {
  memoryRaw = null;
  lastRaw = undefined;
  lastValue = EMPTY;
  pendingDraftText = '';
  pendingEditingId = null;
  try {
    window.localStorage.removeItem(CUSTOM_PHRASES_KEY);
  } catch {
    // 保存できない環境では、この画面の中の値を消せば十分。
  }
  listeners.forEach((listener) => listener());
}

// --- 未確定の登録文ドラフト自動確定（「通話開始 / 診察開始」押下時の取りこぼし防止） ---

let pendingDraftText = '';
let pendingEditingId: string | null = null;
const draftResetListeners = new Set<() => void>();

export function setPendingCustomPhraseDraft(
  text: string,
  editingId: string | null = null,
): void {
  pendingDraftText = text;
  pendingEditingId = editingId;
}

export function subscribeCustomPhraseDraftReset(listener: () => void): () => void {
  draftResetListeners.add(listener);
  return () => {
    draftResetListeners.delete(listener);
  };
}

/**
 * 登録文入力欄に未追加のテキストが残っている場合、自動的に確定してリスト（localStorage）へ反映する。
 * 追加・更新が行われた場合は true を返す。
 */
export function commitPendingCustomPhrase(userLanguage?: 'ja' | 'en'): boolean {
  const normalized = normalizePhraseText(pendingDraftText);
  if (!normalized) {
    pendingDraftText = '';
    pendingEditingId = null;
    return false;
  }

  const current = userLanguage
    ? getCareCustomPhrasesSnapshot(userLanguage)
    : getCustomPhrasesSnapshot();
  const problem = validatePhrase(normalized, current, pendingEditingId);
  const editingId = pendingEditingId;
  pendingDraftText = '';
  pendingEditingId = null;
  draftResetListeners.forEach((listener) => listener());

  if (problem !== null) {
    // すでに同文が登録済み（duplicate）の場合はエラーにせず既存の登録文をそのまま活かす
    return false;
  }

  const next = editingId
    ? current.map((phrase) => (phrase.id === editingId ? { ...phrase, text: normalized } : phrase))
    : [...current, { id: createPhraseId(), text: normalized }];
  saveCustomPhrases(next);
  return true;
}

