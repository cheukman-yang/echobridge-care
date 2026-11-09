import { useEffect, useRef } from 'react';
import { cx } from './ui';

interface PlaybackProgressProps {
  /** 鳴り始めを確かめた時刻（Date.now）。 */
  startedAt: number;
  /** 鳴らしている音声の長さ。 */
  durationMs: number;
  className?: string;
}

/**
 * 読み上げている文の、時間の進み具合を示す細い線。
 *
 * 文字の位置には合わせない。Google音声は単語ごとの時刻を返さないので、文字を順に光らせると
 * 実際の声とずれ、聞こえている所を誤って伝えてしまうため。文は最初から全部読めるまま、線だけが進む。
 * 長さは実際に鳴らしている音声のもの（本人の画面では相手の端末からの報告）で、作り物の演出ではない。
 * 動きを減らす設定では出さない。読み上げ中であることは文字の表示で伝わる。
 */
export function PlaybackProgress({ startedAt, durationMs, className }: PlaybackProgressProps) {
  const fillRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const fill = fillRef.current;
    if (!fill || typeof fill.animate !== 'function') return;
    const animation = fill.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], {
      duration: durationMs,
      easing: 'linear',
      fill: 'forwards',
    });
    // 描き直しや、表示より後に報告が届いた分も、鳴り始めからの経過に合わせる。
    animation.currentTime = Math.min(Math.max(Date.now() - startedAt, 0), durationMs);
    return () => animation.cancel();
  }, [startedAt, durationMs]);

  return (
    <span
      aria-hidden
      data-testid="playback-progress"
      className={cx('block h-1 overflow-hidden rounded-full bg-voice/15 motion-reduce:hidden', className)}
    >
      {/* Tailwind の scale は別のプロパティ（scale）なので使わず、動かす transform と同じ形で始める。 */}
      <span ref={fillRef} className="block h-full origin-left rounded-full bg-voice" style={{ transform: 'scaleX(0)' }} />
    </span>
  );
}
