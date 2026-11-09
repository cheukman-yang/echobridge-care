// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_LAG_S,
  PARTNER_VOICE_TOGGLE_ATTRIBUTE,
  PartnerVoicePlayer,
  START_LEAD_S,
  loadPartnerVoicePreference,
  pcm16ToFloat32,
  savePartnerVoicePreference,
} from '@/lib/partnerVoice';
import type { PartnerVoiceState } from '@/lib/partnerVoice';
import { FakeAudioContext as FakeContext } from '../helpers/fakeAudioContext';

/** 16kHz・16bit で ms ミリ秒分の音声。 */
function chunk(ms: number, value = 1000): ArrayBuffer {
  const samples = (16000 * ms) / 1000;
  const buffer = new ArrayBuffer(samples * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples; i += 1) view.setInt16(i * 2, value, true);
  return buffer;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('相手の声の再生', () => {
  let context: FakeContext;
  let states: PartnerVoiceState[];
  let audible: boolean[];
  let player: PartnerVoicePlayer;

  beforeEach(() => {
    context = new FakeContext();
    states = [];
    audible = [];
    player = new PartnerVoicePlayer({
      createContext: () => context as unknown as AudioContext,
      onState: (state) => states.push(state),
      onAudible: (value) => audible.push(value),
    });
  });

  afterEach(() => player.dispose());

  it('PCMの16bitを -1〜1 に直す', () => {
    const buffer = new ArrayBuffer(6);
    const view = new DataView(buffer);
    view.setInt16(0, 0x4000, true);
    view.setInt16(2, -0x8000, true);
    view.setInt16(4, 0, true);
    expect([...pcm16ToFloat32(buffer)]).toEqual([0.5, -1, 0]);
  });

  it('聞くと選ぶまでは何も鳴らさない', () => {
    player.play(chunk(100));
    expect(context.scheduled).toHaveLength(0);
    expect(player.state).toBe('off');
  });

  it('操作の中でオンにすると、少し待ってから区切りを隙間なく並べる', async () => {
    player.setEnabled(true, true);
    await flush();
    expect(player.state).toBe('on');

    context.currentTime = 1;
    player.play(chunk(100));
    player.play(chunk(100));
    const [first, second] = context.scheduled;
    expect(first.startedAt).toBeCloseTo(1 + START_LEAD_S);
    expect(second.startedAt).toBeCloseTo(1 + START_LEAD_S + 0.1);
    expect(context.buffers.at(-1)).toEqual({ length: 1600, rate: 16000 });
    expect(audible).toEqual([true]);

    // 鳴り終えたら「再生中」を消す。
    first.onended?.();
    expect(audible).toEqual([true]);
    second.onended?.();
    expect(audible).toEqual([true, false]);
  });

  it('届くのが途切れた後は、もう一度少し待ってから鳴らす', async () => {
    player.setEnabled(true, true);
    await flush();
    player.play(chunk(100));
    context.currentTime = 5;
    player.play(chunk(100));
    expect(context.scheduled[1].startedAt).toBeCloseTo(5 + START_LEAD_S);
  });

  it('遅れが上限を超えたら、その区切りは鳴らさず遅れを広げない', async () => {
    player.setEnabled(true, true);
    await flush();
    const chunks = Math.ceil((MAX_LAG_S + 0.5) / 0.1);
    for (let i = 0; i < chunks; i += 1) player.play(chunk(100));
    const last = context.scheduled.at(-1)!;
    expect(last.startedAt! - context.currentTime).toBeLessThanOrEqual(MAX_LAG_S + 0.0001);
    expect(context.scheduled.length).toBeLessThan(chunks);
  });

  it('ブラウザが再生を止めていたら「停止中」にし、画面のどこかを押すと再開する', async () => {
    context.allowResume = false;
    player.setEnabled(true, false);
    await flush();
    expect(player.state).toBe('needs_gesture');
    player.play(chunk(100));
    expect(context.scheduled).toHaveLength(0);

    context.allowResume = true;
    // タッチで押した瞬間（pointerdown）は、ブラウザが操作と認めないので使わない。
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flush();
    expect(player.state).toBe('needs_gesture');
    document.body.dispatchEvent(new Event('touchend', { bubbles: true }));
    await flush();
    expect(player.state).toBe('on');
    // 再開を試している間は「オン」のまま待ち、動かないと分かってから「停止中」にする。
    expect(states).toEqual(['on', 'needs_gesture', 'on']);
  });

  it('保存できないブラウザでも、選んだ値をこのページの間は覚える', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    savePartnerVoicePreference(true);
    expect(loadPartnerVoicePreference()).toBe(true);
    savePartnerVoicePreference(false);
    expect(loadPartnerVoicePreference()).toBe(false);
    setItem.mockRestore();
    savePartnerVoicePreference(false);
  });

  it('切り替えのボタンを押したときは自動で再開せず、ボタンの処理に任せる', async () => {
    context.allowResume = false;
    player.setEnabled(true, false);
    await flush();
    context.allowResume = true;
    const toggle = document.createElement('button');
    toggle.setAttribute(PARTNER_VOICE_TOGGLE_ATTRIBUTE, '');
    document.body.append(toggle);
    toggle.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    expect(player.state).toBe('needs_gesture');
    toggle.remove();
  });

  it('電話の着信などで止まったら、鳴らす予定の音を捨てて「停止中」にする', async () => {
    player.setEnabled(true, true);
    await flush();
    player.play(chunk(100));
    context.setState('interrupted' as AudioContextState);
    expect(player.state).toBe('needs_gesture');
    expect(context.scheduled[0].stopped).toBe(true);
    expect(audible.at(-1)).toBe(false);
  });

  it('オフにすると、鳴らす予定の音をすぐ止める', async () => {
    player.setEnabled(true, true);
    await flush();
    player.play(chunk(100));
    player.play(chunk(100));
    player.setEnabled(false, true);
    expect(context.scheduled.every((source) => source.stopped)).toBe(true);
    expect(player.state).toBe('off');
    expect(audible).toEqual([true, false]);
    player.play(chunk(100));
    expect(context.scheduled).toHaveLength(2);
  });

  it('16kHz の部品を作れないブラウザでは、端末のレートに変えてから鳴らす', async () => {
    context.rejectLowRate = true;
    player.setEnabled(true, true);
    await flush();
    player.play(chunk(100));
    player.play(chunk(100));
    expect(context.buffers.at(-1)).toEqual({ length: 4800, rate: 48000 });
    expect(context.scheduled[1].startedAt).toBeCloseTo(START_LEAD_S + 0.1);
  });

  it('通話を終えたら部品を閉じ、その後は鳴らさない', async () => {
    player.setEnabled(true, true);
    await flush();
    player.dispose();
    expect(context.closed).toBe(true);
    player.play(chunk(100));
    expect(context.scheduled).toHaveLength(0);
  });
});
