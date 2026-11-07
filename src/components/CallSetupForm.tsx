import type { FormEvent } from 'react';
import { Phone } from 'lucide-react';
import { MAX_PATIENT_TEXT_LENGTH, buildGreeting } from '@/lib/callProtocol';
import { CALL_PURPOSES, CALL_PURPOSE_PROFILES, MAX_PARTNER_NAME_LENGTH } from '@/lib/callPurpose';
import type { CallPurpose } from '@/lib/callPurpose';
import { buttonClass, cx } from './ui';

interface CallSetupFormProps {
  purpose: CallPurpose;
  partnerName: string;
  intent: string;
  isConnected: boolean;
  onPurposeChange(purpose: CallPurpose): void;
  onPartnerNameChange(value: string): void;
  onIntentChange(value: string): void;
  onStart(): void;
}

const FIELD_CLASS =
  'w-full rounded-lg border border-line-strong bg-surface px-3.5 py-3 text-base text-ink placeholder:text-ink-2/70 focus:border-voice';

/** 発信の前に、目的・相手・最初に伝える用件を決める。読み上げる文はここで確かめられる。 */
export function CallSetupForm({
  purpose,
  partnerName,
  intent,
  isConnected,
  onPurposeChange,
  onPartnerNameChange,
  onIntentChange,
  onStart,
}: CallSetupFormProps) {
  const profile = CALL_PURPOSE_PROFILES[purpose];
  const greeting = intent.trim() ? buildGreeting(intent, purpose) : '';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (intent.trim() && isConnected) onStart();
  };

  return (
    <form onSubmit={submit} className="space-y-7" aria-labelledby="setup-heading">
      <div className="space-y-2">
        <h1 id="setup-heading" className="text-[26px] font-bold leading-snug text-balance lg:text-[30px]">
          通話の準備
        </h1>
        <p className="max-w-prose text-[15px] leading-relaxed text-ink-2 text-pretty">
          相手の話は文字で届き、あなたが選んだ文は合成音声で相手に読み上げられます。送る前に必ずあなたが確認します。
        </p>
      </div>

      <fieldset className="space-y-3">
        <legend className="mb-3 text-[15px] font-bold">通話の目的</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {CALL_PURPOSES.map((value) => {
            const option = CALL_PURPOSE_PROFILES[value];
            const checked = value === purpose;
            return (
              <label
                key={value}
                className={cx(
                  'flex cursor-pointer items-start gap-3 rounded-xl border bg-surface px-4 py-3.5 transition-colors duration-150',
                  checked ? 'border-voice ring-1 ring-voice' : 'border-line hover:border-line-strong',
                )}
              >
                <input
                  type="radio"
                  name="purpose"
                  value={value}
                  checked={checked}
                  onChange={() => onPurposeChange(value)}
                  className="mt-1 size-4 accent-voice"
                />
                <span className="space-y-0.5">
                  <span className="block font-bold">{option.label}</span>
                  <span className="block text-[13px] leading-snug text-ink-2">{option.description}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="space-y-2">
        <label htmlFor="partner-name" className="block text-[15px] font-bold">
          相手の名前 <span className="font-normal text-ink-2">（任意）</span>
        </label>
        <input
          id="partner-name"
          type="text"
          value={partnerName}
          maxLength={MAX_PARTNER_NAME_LENGTH}
          autoComplete="off"
          onChange={(event) => onPartnerNameChange(event.target.value)}
          placeholder={profile.partnerPlaceholder}
          className={FIELD_CLASS}
        />
        <p className="text-[13px] text-ink-2">画面の見出しと、通話後の予定の場所に使います。</p>
      </div>

      <div className="space-y-2">
        <label htmlFor="call-intent" className="block text-[15px] font-bold">
          最初に伝える用件
        </label>
        <textarea
          id="call-intent"
          value={intent}
          rows={3}
          maxLength={MAX_PATIENT_TEXT_LENGTH}
          onChange={(event) => onIntentChange(event.target.value)}
          placeholder={profile.intentPlaceholder}
          className={cx(FIELD_CLASS, 'resize-none leading-relaxed')}
        />
      </div>

      {greeting && (
        <div className="space-y-2">
          <p className="text-[13px] font-bold text-ink-2">相手が応答すると、この文を読み上げます</p>
          <p
            data-testid="greeting-preview"
            className="rounded-xl bg-voice-soft px-4 py-3 text-[17px] leading-(--leading-talk) text-ink text-pretty"
          >
            {greeting}
          </p>
        </div>
      )}

      <button
        type="submit"
        disabled={!intent.trim() || !isConnected}
        className={buttonClass('primary', 'lg', 'w-full sm:w-auto sm:min-w-56')}
      >
        <Phone className="size-5" aria-hidden />
        {isConnected ? '発信する' : 'サーバーに接続しています…'}
      </button>
    </form>
  );
}

/** 発信前の画面の横に置く、通話の流れの説明。手順は実際の順番どおり。 */
export function CallFlowGuide() {
  const steps = [
    '発信すると、招待リンクとコードが表示されます。相手に送ってください。',
    '相手がリンクを開いて応答すると、用件のあいさつを読み上げます。',
    '相手の話は文字で表示されます。返答候補・即答フレーズ・入力から返事を選びます。',
    'あなたが確認した文だけが、相手に読み上げられます。',
  ];
  return (
    <aside aria-labelledby="flow-heading" className="rounded-xl border border-line bg-surface p-5">
      <h2 id="flow-heading" className="text-[15px] font-bold">
        通話の流れ
      </h2>
      <ol className="mt-3 space-y-3">
        {steps.map((step, index) => (
          <li key={step} className="flex gap-3 text-[14px] leading-relaxed text-ink-2">
            <span
              aria-hidden
              className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-subtle text-[13px] font-bold text-ink tabular-nums"
            >
              {index + 1}
            </span>
            <span className="text-pretty">{step}</span>
          </li>
        ))}
      </ol>
      <p className="mt-4 border-t border-line pt-3 text-[13px] leading-relaxed text-ink-2">
        相手もブラウザで参加します。インストールとログインは不要です。通話の内容は記録として保存せず、終了から10分で消去します。
      </p>
    </aside>
  );
}
