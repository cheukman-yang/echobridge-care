import { useState, useSyncExternalStore } from 'react';
import type { FormEvent } from 'react';
import { Pencil, Send, Trash2 } from 'lucide-react';
import { MAX_PATIENT_TEXT_LENGTH } from '@/lib/callProtocol';
import {
  MAX_CUSTOM_PHRASES,
  clearCustomPhrases,
  createPhraseId,
  getCustomPhrasesSnapshot,
  getServerCustomPhrasesSnapshot,
  normalizePhraseText,
  saveCustomPhrases,
  subscribeCustomPhrases,
  validatePhrase,
} from '@/lib/customPhrases';
import type { CustomPhrase } from '@/lib/customPhrases';
import { Notice, SectionHeading, buttonClass, cx } from './ui';

/** この端末に登録した文。読み込み直後の描画は空で、保存した文はその後に出る。 */
export function useCustomPhrases(): CustomPhrase[] {
  return useSyncExternalStore(subscribeCustomPhrases, getCustomPhrasesSnapshot, getServerCustomPhrasesSnapshot);
}

const ERROR_LABELS = {
  empty: '文を入力してください。',
  too_long: `${MAX_PATIENT_TEXT_LENGTH}文字以内にしてください。`,
  duplicate: '同じ文がすでに登録されています。',
  full: `登録できるのは${MAX_CUSTOM_PHRASES}件までです。使わない文を削除してください。`,
} as const;

const TEXTAREA_CLASS =
  'block w-full resize-none rounded-lg border border-line-strong bg-surface px-3.5 py-2.5 text-[16px] leading-relaxed text-ink placeholder:text-ink-2/70 focus:border-voice';

/** 登録・修正・削除。ここで操作しても、相手には何も届かない。 */
function PhraseEditor({ phrases, onDone }: { phrases: CustomPhrase[]; onDone?: () => void }) {
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  const persist = (next: CustomPhrase[]) => setSaveFailed(!saveCustomPhrases(next));

  const resetForm = () => {
    setDraft('');
    setEditingId(null);
    setError(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problem = validatePhrase(draft, phrases, editingId);
    if (problem) {
      setError(ERROR_LABELS[problem]);
      return;
    }
    const text = normalizePhraseText(draft);
    persist(
      editingId
        ? phrases.map((phrase) => (phrase.id === editingId ? { ...phrase, text } : phrase))
        : [...phrases, { id: createPhraseId(), text }],
    );
    resetForm();
  };

  const remove = (id: string) => {
    persist(phrases.filter((phrase) => phrase.id !== id));
    if (editingId === id) resetForm();
  };

  const removeAll = () => {
    if (!window.confirm('登録した文をすべて削除しますか？\nこの端末から消え、元に戻せません。')) return;
    clearCustomPhrases();
    setSaveFailed(false);
    resetForm();
  };

  return (
    <div className="space-y-4">
      <Notice tone="neutral" testId="custom-phrases-privacy">
        登録した文はこの端末のブラウザにだけ保存され、サーバーにもAIにも送られません。相手に届くのは、通話中にあなたが「この文を送る」を押したときだけで、文は変更されません。共有の端末では、使い終わったら「すべて削除」を押してください。デモ版では、実在の氏名・連絡先・病名などは登録しないでください。
      </Notice>
      {saveFailed && (
        <Notice tone="caution" role="alert">
          この端末に保存できませんでした（プライベートモードなど）。この画面を閉じると消えます。
        </Notice>
      )}

      {phrases.length > 0 && (
        <ul className="space-y-2" aria-label="登録した文の一覧">
          {phrases.map((phrase) => (
            <li
              key={phrase.id}
              className={cx(
                'space-y-2 rounded-lg border bg-surface px-3.5 py-3',
                phrase.id === editingId ? 'border-voice ring-1 ring-voice' : 'border-line',
              )}
            >
              <p className="text-[15px] leading-relaxed text-pretty break-words">{phrase.text}</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(phrase.id);
                    setDraft(phrase.text);
                    setError(null);
                  }}
                  aria-label={`直す: ${phrase.text}`}
                  className={buttonClass('quiet', 'md')}
                >
                  <Pencil className="size-4" aria-hidden />
                  直す
                </button>
                <button
                  type="button"
                  onClick={() => remove(phrase.id)}
                  aria-label={`削除: ${phrase.text}`}
                  className={buttonClass('quiet', 'md')}
                >
                  <Trash2 className="size-4" aria-hidden />
                  削除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={submit} className="space-y-2">
        <label htmlFor="custom-phrase-input" className="block text-[15px] font-bold">
          {editingId ? '登録した文を直す' : '新しい文を登録'}
        </label>
        <textarea
          id="custom-phrase-input"
          value={draft}
          rows={3}
          maxLength={MAX_PATIENT_TEXT_LENGTH}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          placeholder="例：発話に障害があるため、AIの音声でお話ししています。"
          className={TEXTAREA_CLASS}
        />
        {error && (
          <p role="alert" className="text-[14px] font-bold text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={buttonClass('primary', 'md')}>
            {editingId ? '直した文を保存' : '登録する'}
          </button>
          {editingId && (
            <button type="button" onClick={resetForm} className={buttonClass('secondary', 'md')}>
              直すのをやめる
            </button>
          )}
        </div>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <p className="text-[13px] text-ink-2 tabular-nums">
          {phrases.length} / {MAX_CUSTOM_PHRASES}件
        </p>
        <div className="flex flex-wrap gap-2">
          {phrases.length > 0 && (
            <button type="button" onClick={removeAll} className={buttonClass('quiet', 'md', 'text-danger')}>
              <Trash2 className="size-4" aria-hidden />
              すべて削除
            </button>
          )}
          {onDone && (
            <button type="button" onClick={onDone} className={buttonClass('secondary', 'md')}>
              完了
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface CustomPhrasesSectionProps {
  /** call は通話中（送る・編集）、setup は発信前（編集だけ）。 */
  mode: 'call' | 'setup';
  canSend?: boolean;
  partnerLabel?: string;
  onSend?(text: string): void;
}

/**
 * 本人が登録した、よく使う文。表示した全文を確かめてから「この文を送る」で送る。
 * 即答フレーズより長く個人的な内容になりやすいので、1回の押し間違いで送らないよう、文の下にボタンを置く。
 */
export function CustomPhrasesSection({ mode, canSend = false, partnerLabel = '相手', onSend }: CustomPhrasesSectionProps) {
  const phrases = useCustomPhrases();
  const [editing, setEditing] = useState(false);

  if (mode === 'setup') {
    return (
      <details className="group rounded-xl border border-line bg-surface">
        <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 px-5 py-3 text-[15px] font-bold">
          <span>よく使う文の登録（任意）</span>
          <span className="font-normal text-ink-2 tabular-nums">{phrases.length}件</span>
        </summary>
        <div className="border-t border-line px-5 py-4">
          <p className="mb-3 text-[14px] leading-relaxed text-ink-2">
            自己紹介や体の状態の説明など、通話でよく使う文を登録しておくと、通話中にそのまま送れます。
          </p>
          <PhraseEditor phrases={phrases} />
        </div>
      </details>
    );
  }

  return (
    <section aria-labelledby="custom-phrases-heading" className="space-y-2.5">
      <SectionHeading
        id="custom-phrases-heading"
        hint={phrases.length > 0 && !editing && !canSend ? `${partnerLabel}が話し終えると送れます` : undefined}
      >
        登録した文
      </SectionHeading>
      {editing ? (
        <PhraseEditor phrases={phrases} onDone={() => setEditing(false)} />
      ) : phrases.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[14px] leading-relaxed text-ink-2">
            自己紹介など、よく使う文を登録しておくと、ここから送れます。
          </p>
          <button type="button" onClick={() => setEditing(true)} className={buttonClass('secondary', 'md')}>
            <Pencil className="size-4" aria-hidden />
            登録する
          </button>
        </div>
      ) : (
        <>
          <ul className="grid gap-2" aria-label="送れる登録した文">
            {phrases.map((phrase) => (
              <li key={phrase.id} className="space-y-2 rounded-lg border border-line-strong bg-surface px-4 py-3">
                <p className="text-[16px] leading-snug text-pretty break-words">{phrase.text}</p>
                <button
                  type="button"
                  onClick={() => onSend?.(phrase.text)}
                  disabled={!canSend}
                  aria-label={`この文を送る: ${phrase.text}`}
                  className={buttonClass('secondary', 'md')}
                >
                  <Send className="size-4" aria-hidden />
                  この文を送る
                </button>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => setEditing(true)} className={buttonClass('quiet', 'md')}>
            <Pencil className="size-4" aria-hidden />
            登録した文を編集
          </button>
        </>
      )}
    </section>
  );
}
