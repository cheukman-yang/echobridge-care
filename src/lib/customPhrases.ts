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

export function getCustomPhrasesSnapshot(): CustomPhrase[] {
  const raw = readRaw();
  if (raw !== lastRaw) {
    lastRaw = raw;
    lastValue = parseCustomPhrases(raw);
  }
  return lastValue;
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
  try {
    window.localStorage.removeItem(CUSTOM_PHRASES_KEY);
  } catch {
    // 保存できない環境では、この画面の中の値を消せば十分。
  }
  listeners.forEach((listener) => listener());
}
