import { useState } from 'react';
import { Check, Copy, Phone } from 'lucide-react';
import { buildInviteUrl, formatInviteCode } from '@/lib/callProtocol';
import type { CallInvite } from '@/lib/callProtocol';

interface CallInviteCardProps {
  invite: CallInvite | null;
  peerConnected: boolean;
  onCancel: () => void;
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

/** 発信中の画面。病院役に渡す招待を表示する。招待を持つ人だけがこの通話に入れる。 */
export function CallInviteCard({ invite, peerConnected, onCancel }: CallInviteCardProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const link = invite ? buildInviteUrl(window.location.origin, invite.code) : '';

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopyState('copied');
    } catch {
      // httpのページなどでは使えない。リンクは表示されているので手でコピーできる。
      setCopyState('failed');
    }
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 p-5 overflow-y-auto">
      <div className="w-16 h-16 rounded-full bg-indigo-500/20 flex items-center justify-center animate-pulse">
        <Phone className="w-8 h-8 text-indigo-400" />
      </div>
      <p className="text-indigo-300 font-bold text-sm text-center">
        {peerConnected ? '病院役の応答を待っています...' : '病院役の参加を待っています...'}
      </p>

      {invite ? (
        <div className="w-full space-y-3 bg-slate-800 border border-slate-700 rounded-xl p-3">
          <p className="text-xs text-slate-300">
            病院役にリンクかコードを渡してください。受け取った人だけが参加できます。
          </p>

          <div className="space-y-1.5">
            <label className="block text-xs text-slate-400">
              招待リンク
              <input
                readOnly
                value={link}
                onFocus={(event) => event.target.select()}
                className="mt-1 w-full bg-slate-900 text-slate-200 text-xs rounded-lg px-2.5 py-1.5 border border-slate-600 focus:outline-none focus:border-indigo-500"
              />
            </label>
            <button
              type="button"
              onClick={copyLink}
              className="w-full flex items-center justify-center gap-1.5 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-white text-xs font-medium py-2 rounded-lg transition active:scale-[0.98]"
            >
              {copyState === 'copied' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copyState === 'copied' ? 'コピーしました' : 'リンクをコピー'}
            </button>
            {copyState === 'failed' && (
              <p role="alert" className="text-xs text-amber-200">
                コピーできませんでした。上のリンクを選択してコピーしてください。
              </p>
            )}
          </div>

          <div className="text-center space-y-0.5">
            <p className="text-xs text-slate-400">通話コード</p>
            <p
              data-testid="invite-code"
              className="font-mono text-lg font-bold tracking-widest text-white select-all"
            >
              {formatInviteCode(invite.code)}
            </p>
            <p className="text-[11px] text-slate-400">{formatClock(invite.expiresAt)} まで有効</p>
          </div>
        </div>
      ) : (
        <p className="text-xs text-slate-400">通話を準備しています...</p>
      )}

      <button
        type="button"
        onClick={onCancel}
        className="text-xs text-slate-300 underline px-2 py-1"
      >
        発信を取り消す
      </button>
    </div>
  );
}
