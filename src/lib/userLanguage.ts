/**
 * 患者（ユーザー）の使用言語設定。
 *
 * - 'ja': 発話・聴覚障がいや電話恐怖症の日本語話者向け（医療表現への整形、日本語3択回答候補・文字起こし）
 * - 'en': 訪日旅行者・外国人居住者向け（英語での3択回答候補生成、受付・医師との双方向リアルタイム医療翻訳）
 */
export const USER_LANGUAGES = ['ja', 'en'] as const;

export type UserLanguage = (typeof USER_LANGUAGES)[number];

export const DEFAULT_USER_LANGUAGE: UserLanguage = 'ja';

export const USER_LANGUAGE_STORAGE_KEY = 'echobridge.care.userLanguage.v1';

export function isUserLanguage(value: unknown): value is UserLanguage {
  return typeof value === 'string' && (USER_LANGUAGES as readonly string[]).includes(value);
}

const listeners = new Set<() => void>();
let memoryLanguage: UserLanguage | null = null;

export function loadUserLanguage(): UserLanguage {
  if (memoryLanguage !== null) return memoryLanguage;
  if (typeof window === 'undefined') return DEFAULT_USER_LANGUAGE;
  try {
    const raw = window.localStorage?.getItem(USER_LANGUAGE_STORAGE_KEY);
    return isUserLanguage(raw) ? raw : DEFAULT_USER_LANGUAGE;
  } catch {
    return DEFAULT_USER_LANGUAGE;
  }
}

export function getServerUserLanguage(): UserLanguage {
  return DEFAULT_USER_LANGUAGE;
}

export function saveUserLanguage(language: UserLanguage): void {
  memoryLanguage = language;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage?.setItem(USER_LANGUAGE_STORAGE_KEY, language);
      memoryLanguage = null;
    } catch {
      // プライベートブラウジング等で localStorage が使えない場合はメモリに保持する。
    }
  }
  listeners.forEach((listener) => listener());
}

export function clearUserLanguage(): void {
  memoryLanguage = null;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage?.removeItem(USER_LANGUAGE_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  listeners.forEach((listener) => listener());
}

export function subscribeUserLanguage(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window === 'undefined') {
    return () => {
      listeners.delete(listener);
    };
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === USER_LANGUAGE_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}
