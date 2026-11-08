import { useEffect, useRef } from 'react';
import { RotateCcw } from 'lucide-react';
import type { SpeechOrigin } from '@/lib/callProtocol';
import { canRequestReplay, describeDelivery } from '@/lib/speechDelivery';
import type { DeliveryTone, SpeechDelivery } from '@/lib/speechDelivery';
import { cx } from './ui';

export type MessageOrigin = SpeechOrigin | 'greeting' | 'notice';

export interface LogMessage {
  id: string;
  sender: 'patient' | 'hospital';
  text: string;
  origin?: MessageOrigin;
}

/** 本人の文がどの経路で確定したか。AIの文と定型文を見分けられるようにする。 */
export const ORIGIN_LABELS: Record<MessageOrigin, string> = {
  greeting: '冒頭のあいさつ',
  notice: '自動案内',
  typed: '入力した文',
  ai_reviewed: 'AI案を確認',
  ai_edited: 'AI案を編集',
  suggestion: 'AI候補から選択',
  fallback_suggestion: '定型文から選択',
  quick_phrase: '即答フレーズ',
  custom_phrase: '登録した文',
};

const TONE_CLASSES: Record<DeliveryTone, string> = {
  muted: 'text-ink-2',
  live: 'font-bold text-voice-strong',
  done: 'text-ink-2',
  warning: 'font-bold text-caution',
  danger: 'font-bold text-danger',
};

interface ConversationLogProps {
  messages: LogMessage[];
  /** 本人の発言ごとの、音声の作成と相手の端末での再生の状態。 */
  delivery: Record<string, SpeechDelivery>;
  /** サーバーで音声を作れるか。作れなければ「音声を作成中」と出さない。 */
  ttsAvailable: boolean;
  partnerLabel: string;
  isPartnerSpeaking: boolean;
  liveText: string;
  /** 相手の端末でもう一度読み上げてもらう。渡さなければボタンを出さない。 */
  onReplay?: (seq: number) => void;
}

/** これ以上下から離れていたら、本人が読み返しているとみなして自動で動かさない。 */
const STICK_TO_BOTTOM_PX = 120;

function DeliveryBadge({ delivery, ttsAvailable }: { delivery: SpeechDelivery | undefined; ttsAvailable: boolean }) {
  const view = describeDelivery(delivery, ttsAvailable);
  return (
    <span className={cx('inline-flex items-center gap-1.5', TONE_CLASSES[view.tone])}>
      {view.tone === 'live' && <span aria-hidden className="eb-live-dot size-2 rounded-full bg-voice" />}
      {view.label}
    </span>
  );
}

/** 通話の記録。相手の発言は左、本人の発言は右に置き、出所と読み上げの状態を添える。 */
export function ConversationLog({
  messages,
  delivery,
  ttsAvailable,
  partnerLabel,
  isPartnerSpeaking,
  liveText,
  onReplay,
}: ConversationLogProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    if (stickRef.current) endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length, liveText, isPartnerSpeaking]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX;
  };

  const hasPartnerTurn = messages.some((message) => message.sender === 'hospital');
  // 読み直しのボタンは、再生できなかった文と、最後に送った文にだけ出す。
  const latestOwnId = messages.findLast(
    (message) => message.sender === 'patient' && message.origin !== 'notice',
  )?.id;

  return (
    <div ref={scrollerRef} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain">
      <div className="mx-auto max-w-3xl px-4 py-5 lg:px-8 lg:py-6">
        <h2 className="sr-only">会話の記録</h2>
        <ol role="log" aria-label="会話の記録" className="space-y-5">
          {messages.map((message) => {
            if (message.origin === 'notice') {
              return (
                <li key={message.id} className="flex justify-center">
                  <p className="max-w-md rounded-full bg-subtle px-3.5 py-1.5 text-center text-[13px] text-ink-2">
                    自動案内：{message.text}
                  </p>
                </li>
              );
            }
            const isMine = message.sender === 'patient';
            return (
              <li key={message.id} className={cx('flex flex-col gap-1.5', isMine ? 'items-end' : 'items-start')}>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 text-[13px]">
                  <span className="font-bold text-ink">{isMine ? 'あなた' : partnerLabel}</span>
                  {isMine && message.origin && (
                    <span className="text-ink-2">{ORIGIN_LABELS[message.origin]}</span>
                  )}
                </p>
                <p
                  className={cx(
                    'max-w-[min(40rem,88%)] rounded-xl px-4 py-3 text-[17px] leading-(--leading-talk) text-pretty break-words',
                    isMine ? 'bg-voice-soft text-ink' : 'border border-line bg-surface text-ink',
                  )}
                >
                  {message.text}
                </p>
                {isMine && (
                  <div className="flex flex-wrap items-center justify-end gap-x-2 px-1 text-[13px]">
                    <DeliveryBadge delivery={delivery[message.id]} ttsAvailable={ttsAvailable} />
                    {onReplay &&
                      /^\d+$/.test(message.id) &&
                      canRequestReplay(delivery[message.id]) &&
                      (delivery[message.id]?.playback === 'failed' || message.id === latestOwnId) && (
                        <button
                          type="button"
                          onClick={() => onReplay(Number(message.id))}
                          className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-[13px] font-bold text-voice-strong hover:bg-voice-soft"
                        >
                          <RotateCcw className="size-3.5" aria-hidden />
                          もう一度読み上げる
                        </button>
                      )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>

        {!hasPartnerTurn && !isPartnerSpeaking && (
          <p className="mt-6 rounded-xl border border-dashed border-line-strong px-4 py-4 text-[14px] leading-relaxed text-ink-2">
            相手の話は、ここに文字で表示されます。相手が話している間は「相手が話しています」と表示されます。
          </p>
        )}

        {isPartnerSpeaking && (
          <div className="mt-5 flex flex-col items-start gap-1.5" aria-hidden={!liveText}>
            <p className="flex items-center gap-2 px-1 text-[13px] font-bold text-ink">
              <span aria-hidden className="eb-live-dot size-2 rounded-full bg-danger" />
              {partnerLabel}が話しています
            </p>
            <p className="max-w-[min(40rem,88%)] rounded-xl border border-dashed border-line-strong bg-surface px-4 py-3 text-[17px] leading-(--leading-talk) text-ink-2 text-pretty break-words">
              {liveText || '…'}
            </p>
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
