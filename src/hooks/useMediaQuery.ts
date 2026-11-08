import { useCallback, useSyncExternalStore } from 'react';

/**
 * メディアクエリに合うかを返し、画面の大きさや向きが変わったら描き直す。
 * matchMedia のない環境（サーバーでの描画、テストのjsdom）では fallback を返す。
 */
export function useMediaQuery(query: string, fallback: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );

  const getSnapshot = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : fallback;

  return useSyncExternalStore(subscribe, getSnapshot, () => fallback);
}
