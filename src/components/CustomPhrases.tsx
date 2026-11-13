"use client";

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { FormEvent } from 'react';
import { CheckCircle2, Pencil, Send, Trash2, Wand2 } from 'lucide-react';
import { useUserLanguage } from '@/contexts/UserLanguageContext';
import { MAX_PATIENT_TEXT_LENGTH } from '@/lib/callProtocol';
import {
  MAX_CUSTOM_PHRASES,
  clearCustomPhrases,
  createPhraseId,
  getCareCustomPhrasesSnapshot,
  getCustomPhrasesSnapshot,
  getServerCustomPhrasesSnapshot,
  normalizePhraseText,
  saveCustomPhrases,
  setPendingCustomPhraseDraft,
  subscribeCustomPhraseDraftReset,
  subscribeCustomPhrases,
  validatePhrase,
} from '@/lib/customPhrases';
import type { CustomPhrase } from '@/lib/customPhrases';
import { CARE_EXAMPLES, getCustomPhraseErrorLabel } from '@/lib/i18n';
import { Notice, SectionHeading, actionCueClass, buttonClass, cx } from './ui';

/** この端末に登録した文。読み込み直後の描画は空で、保存した文はその後に出る。 */
export function useCustomPhrases(): CustomPhrase[] {
  return useSyncExternalStore(subscribeCustomPhrases, getCustomPhrasesSnapshot, getServerCustomPhrasesSnapshot);
}

/**
 * EchoBridge Care 用：localStorage が未初期化（null）の初回アクセス時は言語別のデフォルト登録文1件を返す。
 * ユーザーが削除・編集・全削除した後は保存値（空配列を含む）をそのまま返す。
 */
export function useCareCustomPhrases(): CustomPhrase[] {
  const { userLanguage } = useUserLanguage();
  return useSyncExternalStore(
    subscribeCustomPhrases,
    () => getCareCustomPhrasesSnapshot(userLanguage),
    getServerCustomPhrasesSnapshot,
  );
}

const TEXTAREA_CLASS =
  'block w-full resize-none rounded-lg border border-line-strong bg-surface px-3.5 py-2.5 text-[16px] leading-relaxed text-ink placeholder:text-ink-2/70 focus:border-voice';

/** 登録・修正・削除。ここで操作しても、相手には何も届かない。 */
function PhraseEditor({
  phrases,
  prominentConfirm = false,
  onDone,
}: {
  phrases: CustomPhrase[];
  prominentConfirm?: boolean;
  onDone?: () => void;
}) {
  const { userLanguage } = useUserLanguage();
  const isEn = userLanguage === 'en';
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const examples = CARE_EXAMPLES[userLanguage].quickPhraseExamples;

  // 通話開始／診察開始時に未確定テキストが残っていた場合の自動確定用ドラフト同期
  useEffect(() => {
    if (!prominentConfirm) return;
    setPendingCustomPhraseDraft(draft, editingId);
  }, [draft, editingId, prominentConfirm]);

  useEffect(() => {
    if (!prominentConfirm) return;
    const unsubscribe = subscribeCustomPhraseDraftReset(() => {
      setDraft('');
      setEditingId(null);
      setError(null);
    });
    return () => {
      unsubscribe();
      setPendingCustomPhraseDraft('', null);
    };
  }, [prominentConfirm]);

  const persist = (next: CustomPhrase[]) => setSaveFailed(!saveCustomPhrases(next));

  const resetForm = () => {
    setDraft('');
    setEditingId(null);
    setError(null);
    if (prominentConfirm) {
      setPendingCustomPhraseDraft('', null);
    }
  };

  const handleInsertExample = () => {
    // まだ現在の言語の例文が入っていない場合は先頭の代表例文をセットし、連続クリック時は次の実用候補へローテーションする
    const currentIndex = examples.indexOf(draft);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % examples.length : 0;
    setDraft(examples[nextIndex]);
    setError(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problem = validatePhrase(draft, phrases, editingId);
    if (problem) {
      setError(getCustomPhraseErrorLabel(problem, userLanguage));
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
    const confirmMsg = isEn
      ? 'Delete all saved quick phrases from this browser?\nThis cannot be undone.'
      : '登録した文をすべて削除しますか？\nこの端末から消え、元に戻せません。';
    if (!window.confirm(confirmMsg)) return;
    if (prominentConfirm) {
      // デフォルトプリセットが復活しないよう空配列 '[]' を保存してユーザーの全削除操作を尊重する
      persist([]);
    } else {
      clearCustomPhrases();
      setSaveFailed(false);
    }
    resetForm();
  };

  const hasUncommittedDraft = Boolean(draft.trim());

  return (
    <div className="space-y-4">
      <Notice tone="neutral" testId="custom-phrases-privacy">
        {isEn
          ? 'Saved phrases are stored strictly in this browser (localStorage) and are never sent to external servers or AI unless you tap "Send Phrase" during a call. Please do not register real personal data in this demo.'
          : '登録した文はこの端末のブラウザにだけ保存され、サーバーにもAIにも送られません。相手に届くのは、通話中にあなたが「この文を送る」を押したときだけで、文は変更されません。共有の端末では、使い終わったら「すべて削除」を押してください。デモ版では、実在の氏名・連絡先・病名などは登録しないでください。'}
      </Notice>
      {saveFailed && (
        <Notice tone="caution" role="alert">
          {isEn
            ? 'Could not persist to browser storage (e.g., private browsing). Phrases will clear when you close this tab.'
            : 'この端末に保存できませんでした（プライベートモードなど）。この画面を閉じると消えます。'}
        </Notice>
      )}

      {phrases.length > 0 && (
        <ul
          className="space-y-2"
          aria-label={isEn ? 'Saved phrases list' : '登録した文の一覧'}
        >
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
                  aria-label={isEn ? `Edit: ${phrase.text}` : `直す: ${phrase.text}`}
                  className={buttonClass('quiet', 'md')}
                >
                  <Pencil className="size-4" aria-hidden />
                  {isEn ? 'Edit' : '直す'}
                </button>
                <button
                  type="button"
                  onClick={() => remove(phrase.id)}
                  aria-label={isEn ? `Delete: ${phrase.text}` : `削除: ${phrase.text}`}
                  className={buttonClass('quiet', 'md')}
                >
                  <Trash2 className="size-4" aria-hidden />
                  {isEn ? 'Delete' : '削除'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={submit} className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="custom-phrase-input" className="block text-[15px] font-bold">
            {editingId
              ? isEn
                ? 'Edit Quick Phrase'
                : '登録した文を直す'
              : isEn
              ? 'Add a Quick Phrase'
              : '新しい文を登録'}
          </label>
          {prominentConfirm && !editingId && (
            <button
              type="button"
              data-testid="insert-example-phrase-button"
              onClick={handleInsertExample}
              className={buttonClass('accent', 'md', 'min-h-8 px-2.5 py-1 text-[12px] whitespace-nowrap')}
            >
              <Wand2 className="size-3.5 shrink-0" aria-hidden />
              <span>{isEn ? 'Insert Example' : '例文を入れる'}</span>
            </button>
          )}
        </div>
        <textarea
          id="custom-phrase-input"
          value={draft}
          rows={3}
          maxLength={MAX_PATIENT_TEXT_LENGTH}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          placeholder={
            isEn
              ? `e.g., ${examples[0]}`
              : `例：${examples[0]}`
          }
          className={TEXTAREA_CLASS}
        />
        {error && (
          <p role="alert" className="text-[14px] font-bold text-danger">
            {error}
          </p>
        )}

        {prominentConfirm ? (
          <div className="space-y-2">
            <button
              type="submit"
              data-testid="confirm-add-custom-phrase-button"
              className={buttonClass(
                'primary',
                'md',
                cx(
                  'w-full text-[14px]',
                  actionCueClass(hasUncommittedDraft),
                ),
              )}
            >
              <CheckCircle2 className="size-4 shrink-0" aria-hidden />
              <span>
                {editingId
                  ? isEn
                    ? '[✅ Confirm & Save Edited Phrase]'
                    : '[✅ 直した文を確定して保存]'
                  : isEn
                  ? '[✅ Confirm & Save Phrase to List]'
                  : '[✅ 登録文を確定してリストに追加]'}
              </span>
            </button>
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                className={buttonClass('secondary', 'md', 'w-full whitespace-nowrap')}
              >
                {isEn ? 'Cancel' : '直すのをやめる'}
              </button>
            )}
            {hasUncommittedDraft && (
              <p className="text-[12px] text-ink-2" data-testid="custom-phrase-autocommit-hint">
                {isEn
                  ? 'Note: If you start the call/consultation right away, this phrase will also be added automatically.'
                  : '※ このまま「通話開始 / 診察開始」を押した場合も、自動的にリストへ確定・追加されます。'}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={buttonClass('primary', 'md', 'whitespace-nowrap')}>
              {editingId
                ? isEn
                  ? 'Save Changes'
                  : '直した文を保存'
                : isEn
                ? 'Save Phrase'
                : '登録する'}
            </button>
            {editingId ? (
              <button type="button" onClick={resetForm} className={buttonClass('secondary', 'md', 'whitespace-nowrap')}>
                {isEn ? 'Cancel' : '直すのをやめる'}
              </button>
            ) : (
              <button
                type="button"
                data-testid="insert-example-phrase-button"
                onClick={handleInsertExample}
                className={buttonClass('accent', 'md', 'whitespace-nowrap')}
              >
                <Wand2 className="size-4 shrink-0" aria-hidden />
                <span>{isEn ? 'Insert Example' : '例文を入れる'}</span>
              </button>
            )}
          </div>
        )}
      </form>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <p className="text-[13px] text-ink-2 tabular-nums">
          {isEn
            ? `${phrases.length} / ${MAX_CUSTOM_PHRASES} saved`
            : `${phrases.length} / ${MAX_CUSTOM_PHRASES}件`}
        </p>
        <div className="flex flex-wrap gap-2">
          {phrases.length > 0 && (
            <button type="button" onClick={removeAll} className={buttonClass('quiet', 'md', 'text-danger')}>
              <Trash2 className="size-4" aria-hidden />
              {isEn ? 'Delete All' : 'すべて削除'}
            </button>
          )}
          {onDone && (
            <button type="button" onClick={onDone} className={buttonClass('secondary', 'md')}>
              {isEn ? 'Done' : '完了'}
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
  /** Step 3 や診察準備 Step 2 で明確な「[✅ 登録文を確定してリストに追加]」ボタンと自動確定を有効化する。 */
  prominentConfirm?: boolean;
  canSend?: boolean;
  partnerLabel?: string;
  onSend?(text: string): void;
}

/**
 * 本人が登録した、よく使う文。表示した全文を確かめてから「この文を送る」で送る。
 * 即答フレーズより長く個人的な内容になりやすいので、1回の押し間違いで送らないよう、文の下にボタンを置く。
 */
export function CustomPhrasesSection({
  mode,
  prominentConfirm = false,
  canSend = false,
  partnerLabel = '相手',
  onSend,
}: CustomPhrasesSectionProps) {
  const { userLanguage } = useUserLanguage();
  const isEn = userLanguage === 'en';
  const rawPhrases = useCustomPhrases();
  const carePhrases = useCareCustomPhrases();
  const phrases = prominentConfirm ? carePhrases : rawPhrases;
  const [editing, setEditing] = useState(false);

  if (mode === 'setup') {
    return (
      <details className="group rounded-xl border border-line bg-surface">
        <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 px-5 py-3 text-[15px] font-bold">
          <span>{isEn ? 'Saved Quick Phrases (Optional)' : 'よく使う文の登録（任意）'}</span>
          <span className="shrink-0 font-normal text-ink-2 tabular-nums">
            {isEn ? `${phrases.length} saved` : `${phrases.length}件`}
          </span>
        </summary>
        <div className="border-t border-line px-5 py-4">
          <p className="mb-3 text-[14px] leading-relaxed text-ink-2">
            {isEn
              ? 'Register self-introductions or medical communication notes beforehand so you can send them in one tap during a call.'
              : '自己紹介や体の状態の説明など、通話でよく使う文を登録しておくと、通話中にそのまま送れます。'}
          </p>
          <PhraseEditor phrases={phrases} prominentConfirm={prominentConfirm} />
        </div>
      </details>
    );
  }

  return (
    <section aria-labelledby="custom-phrases-heading" className="space-y-2.5">
      <SectionHeading
        id="custom-phrases-heading"
        hint={
          phrases.length > 0 && !editing && !canSend
            ? isEn
              ? `Available once ${partnerLabel} finishes speaking`
              : `${partnerLabel}が話し終えると送れます`
            : undefined
        }
      >
        {isEn ? 'Saved Quick Phrases' : '登録した文'}
      </SectionHeading>
      {editing ? (
        <PhraseEditor phrases={phrases} onDone={() => setEditing(false)} />
      ) : phrases.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[14px] leading-relaxed text-ink-2">
            {isEn
              ? 'Save self-introductions or helpful phrases to send during calls.'
              : '自己紹介など、よく使う文を登録しておくと、ここから送れます。'}
          </p>
          <button type="button" onClick={() => setEditing(true)} className={buttonClass('secondary', 'md')}>
            <Pencil className="size-4" aria-hidden />
            {isEn ? 'Add Phrase' : '登録する'}
          </button>
        </div>
      ) : (
        <>
          <ul
            className="grid gap-2"
            aria-label={isEn ? 'Sendable saved phrases' : '送れる登録した文'}
          >
            {phrases.map((phrase) => (
              <li key={phrase.id} className="space-y-2 rounded-lg border border-line-strong bg-surface px-4 py-3">
                <p className="text-[16px] leading-snug text-pretty break-words">{phrase.text}</p>
                <button
                  type="button"
                  onClick={() => onSend?.(phrase.text)}
                  disabled={!canSend}
                  aria-label={isEn ? `Send Phrase: ${phrase.text}` : `この文を送る: ${phrase.text}`}
                  className={buttonClass('secondary', 'md')}
                >
                  <Send className="size-4" aria-hidden />
                  {isEn ? 'Send Phrase' : 'この文を送る'}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => setEditing(true)} className={buttonClass('quiet', 'md')}>
            <Pencil className="size-4" aria-hidden />
            {isEn ? 'Edit Saved Phrases' : '登録した文を編集'}
          </button>
        </>
      )}
    </section>
  );
}
