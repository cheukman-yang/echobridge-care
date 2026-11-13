"use client";

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

const MobileFrameContext = createContext(false);

export function MobileFrameProvider({ children }: { children: ReactNode }) {
  return <MobileFrameContext.Provider value={true}>{children}</MobileFrameContext.Provider>;
}

/** RootLayout のモバイル筐体フレーム（max-w-md）内にあるかを返す。単体テスト描画時は false。 */
export function useIsMobileFrame(): boolean {
  return useContext(MobileFrameContext);
}
