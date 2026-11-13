"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode, WheelEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cx } from './ui';

interface QuickPhraseRailProps {
  children: ReactNode;
  itemCount: number;
  isEn: boolean;
  testIdPrefix: string;
}

/**
 * 通話中・対面診察中の即答フレーズ横スクロールバー。
 * タッチでの左右スワイプ（touch-pan-x）・トラックパッド・マウスホイール・右端「›」送りボタンに対応し、
 * 右側に続きがあることをグラデーションフェードとインジケーターで明示する。
 */
export function QuickPhraseRail({
  children,
  itemCount,
  isEn,
  testIdPrefix,
}: QuickPhraseRailProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(itemCount > 2);
  const [scrollProgress, setScrollProgress] = useState(0);

  const updateScrollState = useCallback(() => {
    const el = railRef.current;
    if (!el) return;
    const { scrollLeft, clientWidth, scrollWidth } = el;
    // jsdom 等のレイアウト未計測環境（0px）では項目数が3件以上なら右スクロール誘導を表示する
    if (scrollWidth === 0 && clientWidth === 0) {
      setCanScrollLeft(scrollLeft > 0);
      setCanScrollRight(itemCount > 2);
      return;
    }
    const maxScroll = Math.max(0, scrollWidth - clientWidth);
    if (maxScroll <= 4) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      setScrollProgress(1);
      return;
    }
    setCanScrollLeft(scrollLeft > 4);
    setCanScrollRight(scrollLeft < maxScroll - 4);
    setScrollProgress(Math.min(1, Math.max(0, scrollLeft / maxScroll)));
  }, [itemCount]);

  useEffect(() => {
    updateScrollState();
    const el = railRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => updateScrollState());
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateScrollState]);

  const scrollByOffset = (delta: number) => {
    const el = railRef.current;
    if (!el) return;
    if (typeof el.scrollBy === 'function') {
      el.scrollBy({ left: delta, behavior: 'smooth' });
    } else {
      el.scrollLeft += delta;
    }
    updateScrollState();
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    const el = railRef.current;
    if (!el) return;
    if (el.scrollWidth > el.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      el.scrollLeft += event.deltaY;
      updateScrollState();
    }
  };

  return (
    <div className="space-y-1">
      <div className="relative flex items-center">
        {canScrollLeft && (
          <button
            type="button"
            data-testid={`${testIdPrefix}-scroll-left`}
            aria-label={isEn ? 'Scroll quick phrases left' : '即答フレーズを左へスクロール'}
            onClick={() => scrollByOffset(-160)}
            className="absolute left-0 z-10 flex size-6 items-center justify-center rounded-full border border-line-strong bg-surface/95 text-ink shadow-xs transition-colors hover:border-voice hover:text-voice-strong"
          >
            <ChevronLeft className="size-3.5" aria-hidden />
          </button>
        )}

        <div
          ref={railRef}
          data-testid={`${testIdPrefix}-scroll-container`}
          onScroll={updateScrollState}
          onWheel={handleWheel}
          className={cx(
            'eb-scroll-row flex w-full gap-1.5 overflow-x-auto touch-pan-x scroll-smooth pb-0.5',
            canScrollLeft && 'pl-7',
            canScrollRight && 'pr-9',
          )}
        >
          {children}
        </div>

        {canScrollRight && (
          <>
            <div
              aria-hidden
              data-testid={`${testIdPrefix}-right-fade`}
              className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-surface via-surface/85 to-transparent"
            />
            <button
              type="button"
              data-testid={`${testIdPrefix}-scroll-right`}
              aria-label={isEn ? 'More quick phrases to the right' : '右側の即答フレーズを見る'}
              title={isEn ? 'Swipe or click to see more phrases' : 'スワイプまたはクリックで右のフレーズを表示'}
              onClick={() => scrollByOffset(160)}
              className="absolute right-0 z-10 flex size-6 items-center justify-center rounded-full border border-voice/60 bg-voice-soft text-voice-strong shadow-xs transition-colors hover:bg-voice hover:text-on-voice"
            >
              <ChevronRight className="size-3.5" aria-hidden />
            </button>
          </>
        )}
      </div>

      {/* 横スクロール位置インジケーター（複数チップが右に続く場合の視覚ヒント） */}
      {(canScrollLeft || canScrollRight) && (
        <div
          aria-hidden
          className="h-0.5 w-full overflow-hidden rounded-full bg-line/70"
        >
          <div
            className="h-full rounded-full bg-voice/60 transition-all duration-150"
            style={{
              width: '35%',
              transform: `translateX(${Math.round(scrollProgress * 185)}%)`,
            }}
          />
        </div>
      )}
    </div>
  );
}
