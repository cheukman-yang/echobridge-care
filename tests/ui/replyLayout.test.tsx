// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PatientApp from '@/app/page';
import { WIDE_LAYOUT_QUERY } from '@/components/CallWorkspace';
import type { AiMeta } from '@/lib/aiMeta';
import type { ServerMessage } from '@/lib/callProtocol';
import { clearCustomPhrases } from '@/lib/customPhrases';
import { callJoined } from '../helpers/callMessages';
import { FakeWebSocket } from '../helpers/fakeWebSocket';

/**
 * 通話中の返答欄の並べ方。広い画面は全部を同時に、狭い画面は「返答候補・入力・登録文」を切り替える。
 * どちらでも、入力中の文を消さず、本人が押していない文を送らないことを確かめる。通話本文はすべて架空。
 */

const GEMINI: AiMeta = { source: 'gemini', model: 'test-model' };
const INVITE = { code: 'ABCDE12345', expiresAt: Date.UTC(2026, 10, 7, 6, 30) };
const SUGGESTIONS = [
  { text: 'はい、お願いいたします。', tag: '承諾' },
  { text: '別の日時でお願いできますか。', tag: '別日程' },
  { text: '持ち物はありますか。', tag: '確認' },
];

function socket() {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

function receive(message: ServerMessage) {
  act(() => socket().receive(message));
}

function renderConnectedCall() {
  render(<PatientApp />);
  act(() => socket().open());
  receive(callJoined('patient', { phase: 'ringing', invite: INVITE, peerConnected: true }));
  receive({ type: 'answer_call', text: 'お電話しております。', seq: 1 });
}

const confirmedSpeech = () => socket().sentOfType('patient_confirmed_speech');
const tab = (name: RegExp) => screen.getByRole('tab', { name });
const replyInput = () => screen.getByRole('textbox', { name: '相手に伝える文' }) as HTMLTextAreaElement;
const queryReplyInput = () => screen.queryByRole('textbox', { name: '相手に伝える文' });

/** 画面の幅を決める。setWide で幅が変わったこと（回転、ウィンドウの大きさ）を知らせる。 */
function stubViewport(initialWide: boolean) {
  let wide = initialWide;
  const listeners = new Set<() => void>();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches() {
        return query === WIDE_LAYOUT_QUERY ? wide : false;
      },
      media: query,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    }),
  });
  return {
    setWide(next: boolean) {
      wide = next;
      act(() => listeners.forEach((listener) => listener()));
    },
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  window.sessionStorage.clear();
  window.localStorage.clear();
  clearCustomPhrases();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('狭い画面: 返答の方法を切り替える', () => {
  beforeEach(() => {
    stubViewport(false);
  });

  it('最初は返答候補を開き、開いていない方法は押せない', () => {
    renderConnectedCall();
    receive({ type: 'suggestions', suggestions: SUGGESTIONS, ai: GEMINI });

    expect(screen.getByRole('tablist', { name: '返答の方法' })).toBeTruthy();
    expect(tab(/返答候補/).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: /持ち物はありますか。/ })).toBeTruthy();
    expect(queryReplyInput()).toBeNull();
    expect(screen.queryByRole('button', { name: 'そのまま送る' })).toBeNull();

    fireEvent.click(tab(/入力/));

    expect(replyInput()).toBeTruthy();
    expect(screen.queryByRole('button', { name: /持ち物はありますか。/ })).toBeNull();
    expect(confirmedSpeech()).toEqual([]);
  });

  it('切り替えても入力中の文を消さず、ほかの方法を開いている間は「下書き」と示す', () => {
    renderConnectedCall();
    fireEvent.click(tab(/入力/));
    fireEvent.change(replyInput(), { target: { value: 'あした行けます' } });

    fireEvent.click(tab(/返答候補/));
    expect(tab(/入力/).textContent).toContain('下書き');

    fireEvent.click(tab(/入力/));
    expect(replyInput().value).toBe('あした行けます');
    expect(tab(/入力/).textContent).not.toContain('下書き');
    expect(confirmedSpeech()).toEqual([]);
  });

  it('候補が届いても勝手に切り替えず、「新着」の印で知らせる。開くと印は消える', () => {
    renderConnectedCall();
    fireEvent.click(tab(/入力/));
    fireEvent.change(replyInput(), { target: { value: 'あした' } });

    receive({ type: 'generating_suggestions' });
    expect(tab(/返答候補/).textContent).toContain('準備中');

    receive({ type: 'suggestions', suggestions: SUGGESTIONS, ai: GEMINI });

    expect(tab(/入力/).getAttribute('aria-selected')).toBe('true');
    expect(replyInput().value).toBe('あした');
    expect(tab(/返答候補/).textContent).toContain('新着');

    fireEvent.click(tab(/返答候補/));
    fireEvent.click(tab(/入力/));
    expect(tab(/返答候補/).textContent).not.toContain('新着');
  });

  it('開いている間に届いた候補には「新着」を付けない', () => {
    renderConnectedCall();
    receive({ type: 'suggestions', suggestions: SUGGESTIONS, ai: GEMINI });

    fireEvent.click(tab(/入力/));

    expect(tab(/返答候補/).textContent).not.toContain('新着');
  });

  it('登録文の編集中の文は、切り替えても残り、相手には何も送らない', () => {
    renderConnectedCall();
    fireEvent.click(tab(/登録文/));
    fireEvent.click(screen.getByRole('button', { name: '登録する' }));
    fireEvent.change(screen.getByRole('textbox', { name: '新しい文を登録' }), { target: { value: '書きかけの文' } });

    fireEvent.click(tab(/返答候補/));
    fireEvent.click(tab(/登録文/));

    expect(screen.getByRole('textbox', { name: '新しい文を登録' })).toHaveProperty('value', '書きかけの文');
    expect(confirmedSpeech()).toEqual([]);
  });

  it('AI案の確認は「入力」の中に出し、ほかの方法を開いている間は「確認待ち」と示す。届いても送らない', () => {
    renderConnectedCall();
    fireEvent.click(tab(/入力/));
    fireEvent.change(replyInput(), { target: { value: 'あした行けます' } });
    fireEvent.click(screen.getByRole('button', { name: 'AIで整える' }));
    const requestId = String(socket().sentOfType('patient_polish_request').at(-1)?.requestId);

    fireEvent.click(tab(/返答候補/));
    expect(tab(/入力/).textContent).toContain('AI作成中');
    receive({ type: 'patient_polish_result', requestId, original: 'あした行けます', polished: '明日伺います。', ai: GEMINI });

    expect(tab(/返答候補/).getAttribute('aria-selected')).toBe('true');
    expect(tab(/入力/).textContent).toContain('確認待ち');
    expect(screen.queryByRole('region', { name: '送信前の確認' })).toBeNull();
    expect(confirmedSpeech()).toEqual([]);

    fireEvent.click(tab(/入力/));
    expect(screen.getByLabelText(/AIの案/)).toHaveProperty('value', '明日伺います。');
  });

  it('即答フレーズは、どの方法を開いていても押せる', () => {
    renderConnectedCall();
    fireEvent.click(tab(/登録文/));

    fireEvent.click(within(screen.getByRole('group', { name: '即答フレーズ' })).getByRole('button', { name: 'はい。' }));

    expect(confirmedSpeech()).toEqual([{ type: 'patient_confirmed_speech', text: 'はい。', origin: 'quick_phrase' }]);
  });

  it('送れなかったことは、開いている方法に関係なく見える場所に出す', () => {
    renderConnectedCall();
    fireEvent.click(tab(/入力/));
    fireEvent.change(replyInput(), { target: { value: '届かない文' } });
    fireEvent.click(tab(/返答候補/));

    act(() => {
      socket().readyState = FakeWebSocket.CLOSED;
    });
    fireEvent.click(screen.getByRole('button', { name: 'いいえ。' }));

    expect(screen.getByRole('alert').textContent).toContain('送信できませんでした');
    fireEvent.click(tab(/入力/));
    expect(replyInput().value).toBe('届かない文');
  });

  it('左右キーとHome・Endで切り替えられる', () => {
    renderConnectedCall();
    const first = tab(/返答候補/);
    first.focus();

    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(tab(/入力/).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab(/入力/));

    fireEvent.keyDown(tab(/入力/), { key: 'End' });
    expect(tab(/登録文/).getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(tab(/登録文/), { key: 'ArrowRight' });
    expect(tab(/返答候補/).getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(tab(/返答候補/), { key: 'ArrowLeft' });
    expect(tab(/登録文/).getAttribute('aria-selected')).toBe('true');
    expect(confirmedSpeech()).toEqual([]);
  });

  it('タブと中身を読み上げソフト向けに結び付ける', () => {
    renderConnectedCall();

    const selected = tab(/返答候補/);
    const panel = document.getElementById(String(selected.getAttribute('aria-controls')));
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    expect(panel?.getAttribute('aria-labelledby')).toBe(selected.id);
    expect(tab(/入力/).tabIndex).toBe(-1);
  });
});

describe('広い画面: 全部を同時に表示する', () => {
  it('切り替えを出さず、候補・入力・登録文・即答を同時に操作できる', () => {
    stubViewport(true);
    renderConnectedCall();
    receive({ type: 'suggestions', suggestions: SUGGESTIONS, ai: GEMINI });

    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('button', { name: /持ち物はありますか。/ })).toBeTruthy();
    expect(replyInput()).toBeTruthy();
    expect(screen.getByRole('heading', { name: '登録した文' })).toBeTruthy();
    expect(screen.getByRole('group', { name: '即答フレーズ' })).toBeTruthy();
  });

  it('AI案の確認中も候補を送れ、送っても本人が直していた案は残る', () => {
    stubViewport(true);
    renderConnectedCall();
    receive({ type: 'suggestions', suggestions: SUGGESTIONS, ai: GEMINI });
    fireEvent.change(replyInput(), { target: { value: 'あした行けます' } });
    fireEvent.click(screen.getByRole('button', { name: 'AIで整える' }));
    const requestId = String(socket().sentOfType('patient_polish_request').at(-1)?.requestId);
    receive({ type: 'patient_polish_result', requestId, original: 'あした行けます', polished: '明日伺います。', ai: GEMINI });
    fireEvent.change(screen.getByLabelText(/AIの案/), { target: { value: '明日の朝に伺います。' } });

    fireEvent.click(screen.getByRole('button', { name: /別の日時でお願いできますか。/ }));

    expect(confirmedSpeech()).toEqual([
      { type: 'patient_confirmed_speech', text: '別の日時でお願いできますか。', origin: 'suggestion' },
    ]);
    expect(screen.getByRole('region', { name: '送信前の確認' })).toBeTruthy();
    expect(screen.getByLabelText(/AIの案/)).toHaveProperty('value', '明日の朝に伺います。');
  });

  it('matchMedia のない環境では同時表示にする', () => {
    renderConnectedCall();

    expect(screen.queryByRole('tablist')).toBeNull();
    expect(replyInput()).toBeTruthy();
  });
});

describe('画面の幅が変わったときのフォーカス', () => {
  function openReviewInNarrow() {
    fireEvent.click(tab(/入力/));
    fireEvent.change(replyInput(), { target: { value: 'あした行けます' } });
    fireEvent.click(screen.getByRole('button', { name: 'AIで整える' }));
    const requestId = String(socket().sentOfType('patient_polish_request').at(-1)?.requestId);
    receive({ type: 'patient_polish_result', requestId, original: 'あした行けます', polished: '明日伺います。', ai: GEMINI });
  }

  it('PCで編集中のAI案は、狭くしても同じ欄にフォーカスと選択範囲が残り、入力の画面が開く', () => {
    const viewport = stubViewport(false);
    renderConnectedCall();
    openReviewInNarrow();
    fireEvent.click(tab(/返答候補/));
    viewport.setWide(true);
    const field = screen.getByLabelText(/AIの案/) as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(3, 5);

    viewport.setWide(false);

    expect(tab(/入力/).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([3, 5]);
    expect(screen.getByLabelText(/AIの案/)).toBe(field);
    expect(confirmedSpeech()).toEqual([]);
  });

  it('狭い画面で編集中のAI案は、PCに広げても同じ欄にフォーカスとカーソル位置が残る', () => {
    const viewport = stubViewport(false);
    renderConnectedCall();
    openReviewInNarrow();
    const field = screen.getByLabelText(/AIの案/) as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(2, 2);

    viewport.setWide(true);

    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([2, 2]);
  });

  it('登録文を書いている途中に狭くすると、登録文の画面を開き、フォーカスを残す', () => {
    const viewport = stubViewport(true);
    renderConnectedCall();
    fireEvent.click(screen.getByRole('button', { name: '登録する' }));
    const editor = screen.getByRole('textbox', { name: '新しい文を登録' }) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '書きかけの文' } });
    editor.focus();

    viewport.setWide(false);

    expect(tab(/登録文/).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(editor);
  });

  it('候補を見ている途中に狭くしても、開く画面は変えない', () => {
    const viewport = stubViewport(true);
    renderConnectedCall();
    receive({ type: 'suggestions', suggestions: SUGGESTIONS, ai: GEMINI });
    fireEvent.change(replyInput(), { target: { value: '下書き' } });
    screen.getByRole('button', { name: /持ち物はありますか。/ }).focus();

    viewport.setWide(false);

    expect(tab(/返答候補/).getAttribute('aria-selected')).toBe('true');
    expect(confirmedSpeech()).toEqual([]);
  });
});

describe('画面の幅が変わったとき（回転、ウィンドウの大きさ）', () => {
  it('入力中の文、登録文の編集中の文、AI案の確認を消さず、何も送らない', () => {
    const viewport = stubViewport(false);
    renderConnectedCall();
    fireEvent.click(tab(/入力/));
    fireEvent.change(replyInput(), { target: { value: 'あした行けます' } });
    fireEvent.click(screen.getByRole('button', { name: 'AIで整える' }));
    const requestId = String(socket().sentOfType('patient_polish_request').at(-1)?.requestId);
    receive({ type: 'patient_polish_result', requestId, original: 'あした行けます', polished: '明日伺います。', ai: GEMINI });
    fireEvent.change(screen.getByLabelText(/AIの案/), { target: { value: '明日の朝に伺います。' } });
    fireEvent.click(tab(/登録文/));
    fireEvent.click(screen.getByRole('button', { name: '登録する' }));
    fireEvent.change(screen.getByRole('textbox', { name: '新しい文を登録' }), { target: { value: '書きかけの文' } });

    viewport.setWide(true);

    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByLabelText(/AIの案/)).toHaveProperty('value', '明日の朝に伺います。');
    expect(screen.getByRole('textbox', { name: '新しい文を登録' })).toHaveProperty('value', '書きかけの文');

    viewport.setWide(false);

    expect(tab(/登録文/).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('textbox', { name: '新しい文を登録' })).toHaveProperty('value', '書きかけの文');
    fireEvent.click(tab(/入力/));
    expect(screen.getByLabelText(/AIの案/)).toHaveProperty('value', '明日の朝に伺います。');
    fireEvent.click(screen.getByRole('button', { name: /送らずに入力へ戻る/ }));
    expect(replyInput().value).toBe('あした行けます');
    expect(confirmedSpeech()).toEqual([]);
  });
});
