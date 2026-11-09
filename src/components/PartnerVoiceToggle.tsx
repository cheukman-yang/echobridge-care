import { Volume2, VolumeX } from 'lucide-react';
import { PARTNER_VOICE_TOGGLE_ATTRIBUTE } from '@/lib/partnerVoice';
import type { PartnerVoiceState } from '@/lib/partnerVoice';
import { buttonClass, cx } from './ui';

interface PartnerVoiceToggleProps {
  state: PartnerVoiceState;
  onToggle(): void;
}

/**
 * 相手の声を自分の端末で聞くかの切り替え。通話中の見出しに置き、いつでも止められるようにする。
 * 状態は言葉と形（アイコンと塗り）でも示し、色だけに頼らない。押せる名前は変えず、aria-pressed で状態を伝える。
 * 狭い画面ではアイコンだけにし、状態の言葉は読み上げ用に残す。
 */
export function PartnerVoiceToggle({ state, onToggle }: PartnerVoiceToggleProps) {
  const on = state !== 'off';
  const stateLabel =
    state === 'off' ? 'オフ' : state === 'needs_gesture' ? '停止中' : state === 'unavailable' ? '使えません' : 'オン';
  return (
    <button
      type="button"
      {...{ [PARTNER_VOICE_TOGGLE_ATTRIBUTE]: '' }}
      onClick={onToggle}
      aria-pressed={on}
      aria-label="相手の声を聞く"
      title={on ? '相手の声を聞いています。押すと止めます' : '押すと、相手の声もこの端末で聞けます'}
      className={cx(
        buttonClass('secondary', 'md', 'max-sm:px-3'),
        state === 'on' && 'border-voice bg-voice-soft text-voice-strong hover:bg-voice-soft',
        (state === 'needs_gesture' || state === 'unavailable') &&
          'border-caution-line bg-caution-soft text-caution hover:bg-caution-soft',
      )}
    >
      {on ? <Volume2 className="size-4" aria-hidden /> : <VolumeX className="size-4" aria-hidden />}
      <span aria-hidden className="max-sm:hidden">
        相手の声 <span className="font-normal">{stateLabel}</span>
      </span>
    </button>
  );
}
