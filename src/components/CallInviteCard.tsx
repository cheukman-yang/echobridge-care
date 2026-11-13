import { useState } from 'react';
import { Check, Copy, Share2 } from 'lucide-react';
import { buildInviteUrl, formatInviteCode } from '@/lib/callProtocol';
import type { CallInvite } from '@/lib/callProtocol';
import { buttonClass } from './ui';

interface CallInviteCardProps {
  invite: CallInvite | null;
  peerConnected: boolean;
  partnerLabel: string;
  onCancel: () => void;
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

/** 発信中の画面。相手に渡す招待を表示する。招待を持つ人だけがこの通話に入れる。 */
export function CallInviteCard({ invite, peerConnected, partnerLabel, onCancel }: CallInviteCardProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const link = invite ? buildInviteUrl(window.location.origin, invite.code) : '';
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopyState('copied');
    } catch {
      // httpのページなどでは使えない。リンクは表示されているので手でコピーできる。
      setCopyState('failed');
    }
  };

  const shareLink = async () => {
    try {
      await navigator.share({ title: 'EchoBridge Careの通話', text: '通話への招待です', url: link });
    } catch {
      // 共有をやめただけの場合もあるので、何も表示しない。
    }
  };

  return (
    <section aria-labelledby="invite-heading" className="space-y-6">
      <div className="space-y-2">
        <h1 id="invite-heading" className="text-[26px] font-bold leading-snug text-balance">
          {peerConnected ? `${partnerLabel}が応答するのを待っています` : `${partnerLabel}の参加を待っています`}
        </h1>
        <p className="text-[15px] leading-relaxed text-ink-2 text-pretty">
          {peerConnected
            ? '相手が画面を開きました。応答すると、用件のあいさつを読み上げます。'
            : '招待リンクかコードを相手に送ってください。受け取った人だけが参加できます。'}
        </p>
      </div>

      {invite ? (
        <div className="divide-y divide-line rounded-xl border border-line bg-surface">
          <div className="space-y-3 p-5">
            <label className="block space-y-2">
              <span className="block text-[13px] font-bold text-ink-2">招待リンク</span>
              <input
                readOnly
                value={link}
                onFocus={(event) => event.target.select()}
                className="w-full rounded-lg border border-line bg-canvas px-3 py-2.5 text-sm text-ink focus:border-voice"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={copyLink} className={buttonClass('primary', 'md')}>
                {copyState === 'copied' ? (
                  <Check className="size-4" aria-hidden />
                ) : (
                  <Copy className="size-4" aria-hidden />
                )}
                {copyState === 'copied' ? 'コピーしました' : 'リンクをコピー'}
              </button>
              {canShare && (
                <button type="button" onClick={shareLink} className={buttonClass('secondary', 'md')}>
                  <Share2 className="size-4" aria-hidden />
                  共有
                </button>
              )}
            </div>
            {copyState === 'failed' && (
              <p role="alert" className="text-sm text-caution">
                コピーできませんでした。上のリンクを選択してコピーしてください。
              </p>
            )}
          </div>

          <div className="space-y-1 p-5">
            <p className="text-[13px] font-bold text-ink-2">通話コード（リンクを開けないとき）</p>
            <p
              data-testid="invite-code"
              className="select-all text-[28px] font-bold leading-tight text-ink tabular-nums"
            >
              {formatInviteCode(invite.code)}
            </p>
            <p className="text-[13px] text-ink-2">
              {formatClock(invite.expiresAt)} まで有効。相手は参加画面でこのコードを入力します。
            </p>
          </div>
        </div>
      ) : (
        <p className="rounded-xl border border-line bg-surface p-5 text-[15px] text-ink-2">
          通話を準備しています...
        </p>
      )}

      <button type="button" onClick={onCancel} className={buttonClass('secondary', 'md')}>
        発信を取り消す
      </button>
    </section>
  );
}
