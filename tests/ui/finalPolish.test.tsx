// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PatientApp from '@/components/LegacyPatientCallApp';
import type { ServerMessage } from '@/lib/callProtocol';
import { PARTNER_VOICE_KEY } from '@/lib/partnerVoice';
import { callJoined } from '../helpers/callMessages';
import { FakeAudioContext, installFakeAudioContext, pcmChunk } from '../helpers/fakeAudioContext';
import { FakeWebSocket } from '../helpers/fakeWebSocket';

/**
 * 提出前の改善（2026-11-09）: 相手の声を聞く切り替え、読み上げ中の表示、トップページからの参加の入口、
 * 発信前の読み上げる文の位置、AI整形の「やめる」。
 */

const INVITE = { code: 'ABCDE12345', expiresAt: Date.UTC(2026, 10, 7, 6, 30) };

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

const listenMessages = () => socket().sentOfType('partner_audio_listen');
const voiceToggle = () => screen.getByRole('button', { name: '相手の声を聞く' });
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

let contexts: FakeAudioContext[];

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  window.sessionStorage.clear();
  window.localStorage.clear();
  contexts = installFakeAudioContext();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
});

describe('相手の声を聞く', () => {
  it('はじめはオフで、席に入ったときにサーバーへ「聞かない」と伝える', () => {
    renderConnectedCall();
    expect(voiceToggle().getAttribute('aria-pressed')).toBe('false');
    expect(listenMessages()).toEqual([{ type: 'partner_audio_listen', enabled: false }]);
  });

  it('押すとオンにし、サーバーへ伝え、この端末に選択を残す。もう一度押すとオフ', async () => {
    renderConnectedCall();
    fireEvent.click(voiceToggle());
    await flush();
    expect(voiceToggle().getAttribute('aria-pressed')).toBe('true');
    expect(listenMessages().at(-1)).toEqual({ type: 'partner_audio_listen', enabled: true });
    expect(window.localStorage.getItem(PARTNER_VOICE_KEY)).toBe('on');
    expect(contexts[0].state).toBe('running');

    fireEvent.click(voiceToggle());
    expect(voiceToggle().getAttribute('aria-pressed')).toBe('false');
    expect(listenMessages().at(-1)).toEqual({ type: 'partner_audio_listen', enabled: false });
    expect(window.localStorage.getItem(PARTNER_VOICE_KEY)).toBe('off');
  });

  it('前の通話でオンにしていたら、席に入ったときに「聞く」と伝える', () => {
    window.localStorage.setItem(PARTNER_VOICE_KEY, 'on');
    renderConnectedCall();
    expect(listenMessages()).toEqual([{ type: 'partner_audio_listen', enabled: true }]);
  });

  it('中継された声を鳴らし、相手が話している間「音声を再生中」と出す。オフなら鳴らさない', async () => {
    renderConnectedCall();
    act(() => socket().receiveAudio(pcmChunk(100)));
    expect(contexts).toHaveLength(0);

    fireEvent.click(voiceToggle());
    await flush();
    receive({ type: 'hospital_speaking_start' });
    act(() => socket().receiveAudio(pcmChunk(100)));
    expect(contexts[0].scheduled).toHaveLength(1);
    const log = within(screen.getByRole('log', { name: '会話の記録' }).parentElement as HTMLElement);
    expect(log.getByText('音声を再生中')).toBeTruthy();

    act(() => contexts[0].scheduled[0].onended?.());
    expect(log.queryByText('音声を再生中')).toBeNull();
  });

  it('再読み込みの後などブラウザが止めていたら、知らせて、画面を押すと再開する', async () => {
    window.localStorage.setItem(PARTNER_VOICE_KEY, 'on');
    // 操作のない再読み込みの後と同じく、resume しても動き出さない部品にする。
    class Blocked extends FakeAudioContext {
      allowResume = false;
    }
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = Blocked;
    renderConnectedCall();
    await flush();
    expect(screen.getByText(/相手の声の再生をブラウザが止めています/)).toBeTruthy();
    expect(voiceToggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('通話を終えたら再生の部品を閉じる', async () => {
    renderConnectedCall();
    fireEvent.click(voiceToggle());
    await flush();
    receive({ type: 'call_ending' });
    expect(contexts[0].closed).toBe(true);
  });
});

describe('読み上げ中の表示', () => {
  it('相手の端末で鳴っている文を囲み、音声の長さが分かれば進み具合の線を出す。文はそのまま読める', () => {
    renderConnectedCall();
    receive({ type: 'speech_playback', seq: 1, status: 'started', engine: 'cloud', durationMs: 3000 });
    const bubble = screen.getByText('お電話しております。').parentElement as HTMLElement;
    expect(bubble.dataset.reading).toBe('true');
    expect(within(bubble).getByTestId('playback-progress')).toBeTruthy();
    expect(screen.getByText('相手の端末で読み上げ中（Google音声）')).toBeTruthy();

    receive({ type: 'speech_playback', seq: 1, status: 'ended', engine: 'cloud' });
    expect(bubble.dataset.reading).toBeUndefined();
    expect(within(bubble).queryByTestId('playback-progress')).toBeNull();
  });

  it('端末の声のように長さが分からなければ、線は出さず、囲みと文字だけで示す', () => {
    renderConnectedCall();
    receive({ type: 'speech_playback', seq: 1, status: 'started', engine: 'device' });
    const bubble = screen.getByText('お電話しております。').parentElement as HTMLElement;
    expect(bubble.dataset.reading).toBe('true');
    expect(within(bubble).queryByTestId('playback-progress')).toBeNull();
  });

  it('読み直しでも、もう一度鳴り始めたら同じように示す', () => {
    renderConnectedCall();
    receive({ type: 'speech_playback', seq: 1, status: 'started', engine: 'cloud', durationMs: 2000 });
    receive({ type: 'speech_playback', seq: 1, status: 'ended', engine: 'cloud' });
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み上げる' }));
    receive({ type: 'speech_playback', seq: 1, status: 'started', engine: 'cloud', durationMs: 2000 });
    const bubble = screen.getByText('お電話しております。').parentElement as HTMLElement;
    expect(bubble.dataset.reading).toBe('true');
    expect(within(bubble).getByTestId('playback-progress')).toBeTruthy();
  });
});

describe('トップページ', () => {
  it('招待参加UIをトップ画面から非表示にし、対面診察モードへの導線に集中している', () => {
    render(<PatientApp />);
    act(() => socket().open());
    const joinLinks = screen.queryAllByRole('link').filter((link) => link.getAttribute('href') === '/join');
    expect(joinLinks).toHaveLength(0);
    expect(screen.queryByText('招待を受け取った方')).toBeNull();
    const consultLinks = screen.getAllByRole('link').filter((link) => link.getAttribute('href') === '/consult');
    expect(consultLinks.length).toBeGreaterThanOrEqual(2);
  });

  it('読み上げる文を用件の入力欄のすぐ後に出し、声の選択はその後に置く', () => {
    render(<PatientApp />);
    act(() => socket().open());
    const intent = screen.getByRole('textbox', { name: '最初に伝える用件' });
    expect(screen.getByText('用件を入力すると、ここに読み上げる文が出ます。')).toBeTruthy();
    fireEvent.change(intent, { target: { value: '内科の初診予約をしたいです' } });
    const preview = screen.getByTestId('greeting-preview');
    const voice = screen.getByRole('group', { name: '読み上げの声' });
    expect(intent.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(preview.compareDocumentPosition(voice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('AI整形の「やめる」', () => {
  it('作成中は、枠のあるボタンとして「やめる」を出し、押すと入力に戻る', () => {
    renderConnectedCall();
    fireEvent.change(screen.getByRole('textbox', { name: '相手に伝える文' }), { target: { value: 'あした行けます' } });
    fireEvent.click(screen.getByRole('button', { name: 'AIで整える' }));
    const cancel = screen.getByRole('button', { name: 'やめる' });
    expect(cancel.className).toContain('border');
    expect(cancel.className).toContain('bg-surface');
    fireEvent.click(cancel);
    expect(screen.getByRole('button', { name: 'AIで整える' })).toBeTruthy();
  });
});
