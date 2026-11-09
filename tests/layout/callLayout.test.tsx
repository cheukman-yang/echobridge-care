import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '@/app/globals.css';
import PatientApp from '@/app/page';
import type { AiMeta } from '@/lib/aiMeta';
import type { ServerMessage } from '@/lib/callProtocol';
import { clearCustomPhrases } from '@/lib/customPhrases';
import { callJoined } from '../helpers/callMessages';
import { FakeWebSocket } from '../helpers/fakeWebSocket';

/**
 * 通話中の画面を実際のブラウザで描き、位置と大きさ、フォーカスを確かめる。通話本文はすべて架空。
 * - 低い画面（キーボード表示中を想定）でも、相手の発言・返答の操作・即答フレーズに届くこと
 * - 画面の幅が変わっても、編集中の欄とフォーカス・カーソル位置が残ること
 */

const GEMINI: AiMeta = { source: 'gemini', model: 'test-model' };
const INVITE = { code: 'ABCDE12345', expiresAt: Date.UTC(2026, 10, 7, 6, 30) };
const PARTNER_LINE = '明日の午後2時半でしたらご案内できます。保険の確認のため、マイナンバーカードをお持ちください。';
const SUGGESTIONS = [
  { text: '承知しました。マイナンバーカードを持って行きます。', tag: '承諾' },
  { text: '資格確認書でも大丈夫でしょうか。', tag: '代わり' },
  { text: 'ほかに持って行くものはありますか。', tag: '確認' },
];
const ORIGINAL = 'あしたの午後なら行けます';
const DRAFT = '恐れ入りますが、あしたの午後なら行けます。';

function socket() {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

function receive(message: ServerMessage) {
  act(() => socket().receive(message));
}

/** 2回描画を待ち、画面の大きさの変化（メディアクエリ）と配置を反映させる。 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function resize(width: number, height: number) {
  await act(async () => {
    await page.viewport(width, height);
  });
  await settle();
}

async function startCall(width: number, height: number) {
  await resize(width, height);
  render(<PatientApp />);
  act(() => socket().open());
  receive(callJoined('patient', { phase: 'ringing', invite: INVITE, peerConnected: true }));
  receive({ type: 'answer_call', text: 'お電話しております。', seq: 1 });
  receive({ type: 'transcript_final', text: PARTNER_LINE, seq: 2 });
  receive({ type: 'suggestions', suggestions: SUGGESTIONS, ai: GEMINI });
  await settle();
}

const queryTab = (name: RegExp) => screen.queryByRole('tab', { name });
const replyInput = () => document.getElementById('reply-input') as HTMLTextAreaElement;
const draftField = () => document.getElementById('polish-draft') as HTMLTextAreaElement;
const quickBar = () => screen.getByRole('group', { name: '即答フレーズ' });
const logRegion = () => screen.getByRole('region', { name: '会話' });

async function openTab(name: RegExp) {
  const tab = queryTab(name);
  if (tab) fireEvent.click(tab);
  await settle();
}

async function openReview() {
  await openTab(/入力/);
  fireEvent.change(replyInput(), { target: { value: ORIGINAL } });
  fireEvent.click(screen.getByRole('button', { name: 'AIで整える' }));
  const requestId = String(socket().sentOfType('patient_polish_request').at(-1)?.requestId);
  receive({ type: 'patient_polish_result', requestId, original: ORIGINAL, polished: DRAFT, ai: GEMINI });
  await settle();
}

/** 画面の中に全部が見えている。 */
function expectOnScreen(element: Element, label: string) {
  const box = element.getBoundingClientRect();
  expect(box.height, `${label}の高さ`).toBeGreaterThan(0);
  expect(box.top, `${label}の上端`).toBeGreaterThanOrEqual(-0.5);
  expect(box.bottom, `${label}の下端`).toBeLessThanOrEqual(window.innerHeight + 0.5);
}

/** 即答フレーズの帯に隠れず、その上に全部が見えている。 */
function expectAboveQuickBar(element: Element, label: string) {
  expectOnScreen(element, label);
  expect(element.getBoundingClientRect().bottom, `${label}が即答フレーズに重なる`).toBeLessThanOrEqual(
    quickBar().getBoundingClientRect().top + 0.5,
  );
}

/** 画面の中に見え、即答フレーズの帯と重ならない（PCは帯の位置を問わない）。 */
function expectClearOfQuickBar(element: Element, label: string) {
  expectOnScreen(element, label);
  const a = element.getBoundingClientRect();
  const b = quickBar().getBoundingClientRect();
  const overlaps = a.left < b.right && b.left < a.right && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  expect(overlaps, `${label}が即答フレーズに重なる`).toBe(false);
}

function expectLogVisible(minHeight: number) {
  const box = logRegion().getBoundingClientRect();
  expect(box.height, '会話の記録の高さ').toBeGreaterThanOrEqual(minHeight);
  expect(box.top).toBeGreaterThanOrEqual(-0.5);
}

/** 返答欄の中でスクロールして見せる。画面全体は動かさない。 */
async function scrollIntoPanel(element: Element) {
  element.scrollIntoView({ block: 'nearest' });
  await settle();
  expect(window.scrollY, '画面全体がずれた').toBe(0);
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
});

describe('低い画面（キーボード表示中を想定）', () => {
  it('375×350でAI案を開いても、会話の記録と即答フレーズが画面に残り、案と送るボタンには返答欄の中でスクロールして届く', async () => {
    await startCall(375, 350);
    await openReview();

    expectOnScreen(quickBar(), '即答フレーズ');
    expectOnScreen(screen.getByRole('tablist', { name: '返答の方法' }), '切り替え');
    expectLogVisible(40);
    expect(screen.getByRole('region', { name: '会話' }).textContent).toContain('マイナンバーカード');

    await scrollIntoPanel(draftField());
    expectAboveQuickBar(draftField(), 'AIの案');
    const send = screen.getByRole('button', { name: 'この文を送る' });
    await scrollIntoPanel(send);
    expectAboveQuickBar(send, '「この文を送る」');
  });

  it('375×350で入力中は、入力欄と送るボタンをスクロールなしで見せる', async () => {
    await startCall(375, 350);
    await openTab(/入力/);
    fireEvent.change(replyInput(), { target: { value: ORIGINAL } });
    await settle();

    expectAboveQuickBar(replyInput(), '入力欄');
    expectAboveQuickBar(screen.getByRole('button', { name: 'そのまま送る' }), '「そのまま送る」');
    expectOnScreen(quickBar(), '即答フレーズ');
    expectLogVisible(40);
  });

  it('360×300でも、即答フレーズと入力欄が見え、送るボタンには届き、会話の記録も残る', async () => {
    await startCall(360, 300);
    await openTab(/入力/);
    fireEvent.change(replyInput(), { target: { value: ORIGINAL } });
    await settle();

    expectOnScreen(quickBar(), '即答フレーズ');
    expectAboveQuickBar(replyInput(), '入力欄');
    expectLogVisible(32);
    const send = screen.getByRole('button', { name: 'そのまま送る' });
    await scrollIntoPanel(send);
    expectAboveQuickBar(send, '「そのまま送る」');
  });
});

describe('ふつうの高さと横向き', () => {
  it('375×667では、会話の記録に3割近くを残し、最初の候補と即答フレーズを見せる', async () => {
    await startCall(375, 667);

    expectOnScreen(quickBar(), '即答フレーズ');
    expectLogVisible(150);
    expectAboveQuickBar(screen.getByRole('button', { name: /承知しました。/ }), '最初の候補');
  });

  it('横向き（812×375）では、会話の記録と返答欄を左右に並べる', async () => {
    await startCall(812, 375);

    const log = logRegion().getBoundingClientRect();
    const tabs = screen.getByRole('tablist', { name: '返答の方法' }).getBoundingClientRect();
    expect(log.right).toBeLessThanOrEqual(tabs.left + 1);
    expect(log.height).toBeGreaterThan(250);
    expectOnScreen(quickBar(), '即答フレーズ');
  });

  it('PC（1366×625）では、AI案の確認中も切り替えを出さず、送るボタン・候補・即答フレーズを同時に見せる', async () => {
    await startCall(1366, 625);
    await openReview();

    expect(queryTab(/入力/)).toBeNull();
    expectClearOfQuickBar(screen.getByRole('button', { name: 'この文を送る' }), '「この文を送る」');
    expectOnScreen(screen.getByRole('button', { name: /承知しました。/ }), '最初の候補');
    expectOnScreen(quickBar(), '即答フレーズ');
    expectLogVisible(100);
  });
});

describe('狭い画面で返答の方法を切り替えたとき', () => {
  /** 切り替えで動いてはいけない部品の位置と高さ。 */
  function frame() {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { top: Math.round(rect.top), height: Math.round(rect.height) };
    };
    return {
      log: box(logRegion()),
      tabs: box(screen.getByRole('tablist', { name: '返答の方法' })),
      quick: box(quickBar()),
    };
  }

  it('390×664で3つの方法を切り替えても、記録・切り替え・即答フレーズの位置と高さが変わらない', async () => {
    await startCall(390, 664);
    const before = frame();
    for (const name of [/入力/, /登録文/, /返答候補/, /登録文/, /入力/]) {
      await openTab(name);
      expect(frame(), `${name}を開いたとき`).toEqual(before);
    }
    expectLogVisible(180);
  });

  it('登録文が多くても欄の中でスクロールし、別の方法から戻るとスクロールの位置が残る', async () => {
    window.localStorage.setItem(
      'echobridge.customPhrases.v1',
      JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, text: `登録した文の例その${i + 1}です。` }))),
    );
    await startCall(390, 664);
    const before = frame();
    await openTab(/登録文/);
    expect(frame()).toEqual(before);

    const scroller = screen.getByRole('tabpanel', { name: /登録文/ }).parentElement as HTMLElement;
    scroller.scrollTop = 240;
    await settle();
    await openTab(/入力/);
    await openTab(/登録文/);
    expect(scroller.scrollTop).toBe(240);
    expect(window.scrollY).toBe(0);
  });

  it('入力中の文とフォーカスは、ほかの方法を開いて戻っても残る', async () => {
    await startCall(390, 664);
    await openTab(/入力/);
    fireEvent.change(replyInput(), { target: { value: ORIGINAL } });
    replyInput().focus();
    await openTab(/返答候補/);
    await openTab(/入力/);
    expect(replyInput().value).toBe(ORIGINAL);
  });
});

describe('画面の幅が変わったとき', () => {
  it('PCで編集中のAI案は、狭い画面に戻しても同じ欄のまま見え、フォーカスと選択範囲が残る', async () => {
    await startCall(900, 768);
    await openReview();
    await openTab(/返答候補/);

    await resize(1366, 768);
    const field = draftField();
    field.focus();
    field.setSelectionRange(3, 5);

    await resize(900, 768);

    expect(queryTab(/入力/)?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(field);
    expect(field.isConnected).toBe(true);
    expect([field.selectionStart, field.selectionEnd]).toEqual([3, 5]);
    expect(field.value).toBe(DRAFT);
    expectOnScreen(field, 'AIの案');
  });

  it('狭い画面で編集中のAI案は、PCに広げても同じ欄のままフォーカスとカーソル位置が残る', async () => {
    await startCall(900, 768);
    await openReview();
    const field = draftField();
    field.focus();
    field.setSelectionRange(4, 4);

    await resize(1366, 768);

    expect(document.activeElement).toBe(field);
    expect(field.isConnected).toBe(true);
    expect([field.selectionStart, field.selectionEnd]).toEqual([4, 4]);
    expectOnScreen(field, 'AIの案');
  });

  it('入力欄で書いている途中に幅が変わっても、入力の画面を開き、フォーカスとカーソル位置を残す', async () => {
    await startCall(1366, 768);
    const input = replyInput();
    fireEvent.change(input, { target: { value: ORIGINAL } });
    input.focus();
    input.setSelectionRange(2, 2);

    await resize(390, 844);

    expect(queryTab(/入力/)?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 2]);
    expectOnScreen(input, '入力欄');
  });

  it('登録文を書いている途中に狭くしても、登録文の画面を開き、フォーカスとカーソル位置を残す', async () => {
    await startCall(1366, 768);
    fireEvent.click(screen.getByRole('button', { name: '登録する' }));
    const editor = screen.getByRole('textbox', { name: '新しい文を登録' }) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '書きかけの文です' } });
    editor.focus();
    editor.setSelectionRange(3, 3);

    await resize(390, 844);

    expect(queryTab(/登録文/)?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(editor);
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([3, 3]);
    expect(socket().sentOfType('patient_confirmed_speech')).toEqual([]);
  });
});
