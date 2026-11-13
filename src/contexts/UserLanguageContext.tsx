"use client";

import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import {
  getServerUserLanguage,
  loadUserLanguage,
  saveUserLanguage,
  subscribeUserLanguage,
} from '@/lib/userLanguage';
import type { UserLanguage } from '@/lib/userLanguage';

interface UserLanguageContextValue {
  userLanguage: UserLanguage;
  setUserLanguage: (language: UserLanguage) => void;
}

const UserLanguageContext = createContext<UserLanguageContextValue | null>(null);

export function UserLanguageProvider({ children }: { children: ReactNode }) {
  const userLanguage = useSyncExternalStore(
    subscribeUserLanguage,
    loadUserLanguage,
    getServerUserLanguage,
  );

  const value = useMemo<UserLanguageContextValue>(
    () => ({
      userLanguage,
      setUserLanguage: saveUserLanguage,
    }),
    [userLanguage],
  );

  return <UserLanguageContext.Provider value={value}>{children}</UserLanguageContext.Provider>;
}

/**
 * 患者の使用言語（'ja' | 'en'）を取得・更新するフック。
 * Provider の外（コンポーネント単体テストなど）でも同じストアを購読して動作する。
 */
export function useUserLanguage(): UserLanguageContextValue {
  const ctx = useContext(UserLanguageContext);
  const storeLanguage = useSyncExternalStore(
    subscribeUserLanguage,
    loadUserLanguage,
    getServerUserLanguage,
  );
  if (ctx) return ctx;
  return {
    userLanguage: storeLanguage,
    setUserLanguage: saveUserLanguage,
  };
}
