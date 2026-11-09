import type { FormEvent } from 'react';
import Link from 'next/link';
import { LogIn, Phone, Wand2 } from 'lucide-react';
import { JOIN_PATH, MAX_PATIENT_TEXT_LENGTH, SPEECH_VOICES, buildGreeting } from '@/lib/callProtocol';
import type { SpeechVoice } from '@/lib/callProtocol';
import { CALL_PURPOSES, CALL_PURPOSE_PROFILES, MAX_PARTNER_NAME_LENGTH } from '@/lib/callPurpose';
import type { CallPurpose } from '@/lib/callPurpose';
import { DemoDataNotice } from './DemoDataNotice';
import { buttonClass, cx } from './ui';

interface CallSetupFormProps {
  purpose: CallPurpose;
  partnerName: string;
  intent: string;
  voice: SpeechVoice;
  isConnected: boolean;
  onPurposeChange(purpose: CallPurpose): void;
  onPartnerNameChange(value: string): void;
  onIntentChange(value: string): void;
  onVoiceChange(voice: SpeechVoice): void;
  onStart(): void;
}

const VOICE_LABELS: Record<SpeechVoice, string> = {
  female: '女性の声',
  male: '男性の声',
};

const FIELD_CLASS =
  'w-full rounded-lg border border-line-strong bg-surface px-3.5 py-3 text-base text-ink placeholder:text-ink-2/70 focus:border-voice';

/** 発信の前に、目的・相手・最初に伝える用件を決める。読み上げる文はここで確かめられる。 */
export function CallSetupForm({
  purpose,
  partnerName,
  intent,
  voice,
  isConnected,
  onPurposeChange,
  onPartnerNameChange,
  onIntentChange,
  onVoiceChange,
  onStart,
}: CallSetupFormProps) {
  const profile = CALL_PURPOSE_PROFILES[purpose];
  const greeting = intent.trim() ? buildGreeting(intent, purpose) : '';
  const canFillSample = !partnerName.trim() || !intent.trim();
  const startHint = !isConnected
    ? 'サーバーに接続すると発信できます。'
    : !intent.trim()
    ? '最初に伝える用件を入力すると発信できます。'
    : null;

  /** 空の欄にだけ架空の例を入れる。本人が入力した内容は上書きしない。 */
  const fillSample = () => {
    if (!partnerName.trim()) onPartnerNameChange(profile.samplePartnerName);
    if (!intent.trim()) onIntentChange(profile.sampleIntent);
  };

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
          相手の話は文字で届き、あなたが選んだ文は合成音声で相手に読み上げられます。送る前に必ずあなたが確認します。相手の声は、通話中に「相手の声」をオンにすると聞けます。
        </p>
      </div>

      <DemoDataNotice side="user" />

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

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-dashed border-line-strong py-2 pr-2 pl-4">
        <p className="text-[14px] leading-snug text-ink-2">
          架空の例で試せます<span className="max-sm:hidden">（入力済みの欄は変えません）</span>
        </p>
        <button
          type="button"
          onClick={fillSample}
          disabled={!canFillSample}
          className={buttonClass('secondary', 'md', 'shrink-0')}
        >
          <Wand2 className="size-4" aria-hidden />
          例を入力
        </button>
      </div>

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
        <p className="text-[13px] text-ink-2">
          {profile.partnerIsPlace
            ? '画面の見出し、相手の画面の宛先、通話後の予定の場所に使います。'
            : '画面の見出しと、相手の画面の宛先に使います。'}
        </p>
      </div>

      {/*
        用件・読み上げる文・声を1つのまとまりにする。用件を打つと、すぐ下の文が同じ速さで変わり、
        相手に読まれる文を見ながら直せる。声はその文の直後で選ぶ。
      */}
      <div className="space-y-3">
        <div className="space-y-2">
          <label htmlFor="call-intent" className="block text-[15px] font-bold">
            最初に伝える用件
          </label>
          <textarea
            id="call-intent"
            value={intent}
            rows={3}
            maxLength={MAX_PATIENT_TEXT_LENGTH}
            aria-describedby="greeting-preview-label"
            onChange={(event) => onIntentChange(event.target.value)}
            placeholder={profile.intentPlaceholder}
            className={cx(FIELD_CLASS, 'resize-none leading-relaxed')}
          />
        </div>

        <div className="rounded-xl border border-voice/30 bg-voice-soft px-4 py-3">
          <p id="greeting-preview-label" className="text-[13px] font-bold text-voice-strong">
            相手が応答すると、この文を読み上げます
          </p>
          {greeting ? (
            <p
              data-testid="greeting-preview"
              className="mt-1 text-[17px] leading-(--leading-talk) text-ink text-pretty break-words"
            >
              {greeting}
            </p>
          ) : (
            <p className="mt-1 text-[15px] leading-relaxed text-ink-2">
              用件を入力すると、ここに読み上げる文が出ます。
            </p>
          )}
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-2 text-[15px] font-bold">読み上げの声</legend>
        <div className="flex flex-wrap gap-2">
          {SPEECH_VOICES.map((value) => {
            const checked = value === voice;
            return (
              <label
                key={value}
                className={cx(
                  'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border bg-surface px-4 py-2 transition-colors duration-150',
                  checked ? 'border-voice ring-1 ring-voice' : 'border-line hover:border-line-strong',
                )}
              >
                <input
                  type="radio"
                  name="voice"
                  value={value}
                  checked={checked}
                  onChange={() => onVoiceChange(value)}
                  className="size-4 accent-voice"
                />
                <span className="font-bold">{VOICE_LABELS[value]}</span>
              </label>
            );
          })}
        </div>
        <p className="text-[13px] leading-relaxed text-ink-2 text-pretty">
          Googleの合成音声（Cloud Text-to-Speech）で読み上げます。使えないときは、相手の端末の日本語の声で読みます。
        </p>
      </fieldset>

      {/* スマホでは用件の入力中も発信ボタンが見えるよう、フォームの下端に留める。フォームを過ぎると元の位置に戻る。 */}
      <div className="space-y-2 max-lg:sticky max-lg:bottom-0 max-lg:-mx-4 max-lg:border-t max-lg:border-line max-lg:bg-canvas/95 max-lg:px-4 max-lg:pt-3 max-lg:pb-[max(0.75rem,env(safe-area-inset-bottom))] max-lg:backdrop-blur-sm">
        <button
          type="submit"
          disabled={!intent.trim() || !isConnected}
          aria-describedby={startHint ? 'start-hint' : undefined}
          className={buttonClass('primary', 'lg', 'w-full sm:w-auto sm:min-w-64')}
        >
          <Phone className="size-5" aria-hidden />
          {isConnected ? '発信する' : 'サーバーに接続しています…'}
        </button>
        {startHint && (
          <p id="start-hint" className="text-[14px] text-ink-2">
            {startHint}
          </p>
        )}
      </div>
    </form>
  );
}

/**
 * 招待を受け取った人の入口。トップページから参加の画面（招待コードの入力）へ進めるようにする。
 * 招待リンクを開けば、これまでどおりコードを入れずに参加できる。
 */
export function JoinCallEntry() {
  return (
    <aside aria-labelledby="join-entry-heading" className="rounded-xl border border-line bg-surface p-5">
      <h2 id="join-entry-heading" className="text-[15px] font-bold">
        招待を受け取った方
      </h2>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2 text-pretty">
        届いた招待リンクを開くと、そのまま参加できます。リンクを開けないときは、相手の画面に出ている招待コードを入力してください。
      </p>
      <Link href={JOIN_PATH} className={buttonClass('secondary', 'md', 'mt-3 w-full')}>
        <LogIn className="size-4" aria-hidden />
        招待コードで通話に参加する
      </Link>
    </aside>
  );
}

/** 発信前の画面の横に置く、通話の流れの説明。手順は実際の順番どおり。 */
export function CallFlowGuide() {
  const steps = [
    '発信すると、招待リンクとコードが表示されます。相手に送ってください。',
    '相手がリンクを開いて応答すると、用件のあいさつを読み上げます。',
    '相手の話は文字で表示されます（「相手の声」をオンにすると声も聞けます）。返答候補・即答フレーズ・入力から返事を選びます。',
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
