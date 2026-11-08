import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpeechPlaybackQueue, audioWaitMs, readingWatchdogMs } from '@/lib/speechPlayback';
import type {
  AudioOutput,
  DeviceVoice,
  DeviceVoiceSupport,
  PlaybackEvents,
  SpeechQueueState,
} from '@/lib/speechPlayback';
import type { SpeechAudio } from '@/lib/callProtocol';

interface FakePlayback {
  kind: 'cloud' | 'device';
  /** cloud なら音声、device なら文。 */
  content: string;
  events: PlaybackEvents;
  stopped: boolean;
}

const audioOf = (name: string): SpeechAudio => ({ audio: name, mimeType: 'audio/mpeg' });

function setup(support: DeviceVoiceSupport = 'japanese') {
  const playbacks: FakePlayback[] = [];
  const reports: [number, string, string][] = [];
  const spoken: number[] = [];
  const requested: number[] = [];
  const states: SpeechQueueState[] = [];
  let paused = false;
  let deviceSupport = support;

  const output: AudioOutput = {
    unlock: vi.fn(),
    play(audio, events) {
      const playback: FakePlayback = { kind: 'cloud', content: audio.audio, events, stopped: false };
      playbacks.push(playback);
      return { stop: () => (playback.stopped = true) };
    },
  };
  const device: DeviceVoice = {
    support: () => deviceSupport,
    unlock: vi.fn(),
    speak(text, events) {
      const playback: FakePlayback = { kind: 'device', content: text, events, stopped: false };
      playbacks.push(playback);
      return { stop: () => (playback.stopped = true) };
    },
    cancelAll: vi.fn(),
  };
  const queue = new SpeechPlaybackQueue({
    output,
    device,
    isPaused: () => paused,
    onState: (state) => states.push(state),
    onReport: (seq, status, engine) => reports.push([seq, status, engine]),
    onSpoken: (seq) => spoken.push(seq),
    onNeedAudio: (seq) => requested.push(seq),
  });

  const current = () => playbacks.at(-1)!;
  const played = () => playbacks.map((playback) => `${playback.kind}:${playback.content}`);
  return {
    queue,
    output,
    device,
    playbacks,
    reports,
    spoken,
    requested,
    states,
    current,
    played,
    lastState: () => states.at(-1),
    setPaused: (value: boolean) => (paused = value),
    setSupport: (value: DeviceVoiceSupport) => (deviceSupport = value),
    finish: () => {
      current().events.onStart();
      current().events.onEnd();
    },
  };
}

describe('相手の画面の読み上げの順番', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('サーバーの音声が届いたら鳴らし、始まりと終わりを番号で報告する', () => {
    const t = setup();
    t.queue.enqueue({ text: 'あいさつ', seq: 1, expectAudio: true });
    expect(t.playbacks).toHaveLength(0);
    expect(t.lastState()).toMatchObject({ seq: 1, phase: 'waiting' });

    t.queue.provideAudio(1, audioOf('A1'));
    expect(t.played()).toEqual(['cloud:A1']);
    expect(t.queue.isPlaying).toBe(true);

    t.finish();
    expect(t.reports).toEqual([
      [1, 'started', 'cloud'],
      [1, 'ended', 'cloud'],
    ]);
    expect(t.spoken).toEqual([1]);
    expect(t.queue.isPlaying).toBe(false);
    expect(t.lastState()).toMatchObject({ seq: null, phase: 'idle' });
  });

  it('後の文の音声が先に届いても、先頭の文を待ってから順に鳴らす', () => {
    const t = setup();
    t.queue.enqueue({ text: '一つ目', seq: 2, expectAudio: true });
    t.queue.enqueue({ text: '二つ目', seq: 3, expectAudio: true });

    t.queue.provideAudio(3, audioOf('A3'));
    expect(t.playbacks).toHaveLength(0);

    t.queue.provideAudio(2, audioOf('A2'));
    expect(t.played()).toEqual(['cloud:A2']);
    t.finish();
    expect(t.played()).toEqual(['cloud:A2', 'cloud:A3']);
  });

  it('サーバーが音声を作れなかった文は、端末の声で読む', () => {
    const t = setup();
    t.queue.enqueue({ text: '本人の文', seq: 2, expectAudio: true });

    t.queue.audioFailed(2);
    expect(t.played()).toEqual(['device:本人の文']);
    t.finish();
    expect(t.reports).toEqual([
      [2, 'started', 'device'],
      [2, 'ended', 'device'],
    ]);
  });

  it('音声が時間内に届かなければ、端末の声で読む', () => {
    const t = setup();
    t.queue.enqueue({ text: '本人の文', seq: 2, expectAudio: true });

    vi.advanceTimersByTime(audioWaitMs('本人の文') - 1);
    expect(t.playbacks).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(t.played()).toEqual(['device:本人の文']);

    // 遅れて届いた音声で、同じ文を二度鳴らさない。
    t.queue.provideAudio(2, audioOf('late'));
    t.finish();
    expect(t.played()).toEqual(['device:本人の文']);
  });

  it('音声を待たない文（サーバーが合成できない）は、すぐ端末の声で読む', () => {
    const t = setup();
    t.queue.enqueue({ text: '入力中です', expectAudio: false });
    expect(t.played()).toEqual(['device:入力中です']);
  });

  it('自動案内に音声が付いていれば、その音声で鳴らし、報告はしない', () => {
    const t = setup();
    t.queue.enqueue({ text: '入力中です', audio: audioOf('notice'), expectAudio: false });
    expect(t.played()).toEqual(['cloud:notice']);
    t.finish();
    expect(t.reports).toEqual([]);
  });

  it('音声を再生できなかったら、同じ文を端末の声で読み直す', () => {
    const t = setup();
    t.queue.enqueue({ text: '本人の文', seq: 2, audio: audioOf('broken'), expectAudio: true });

    t.current().events.onError('failed');

    expect(t.played()).toEqual(['cloud:broken', 'device:本人の文']);
    t.finish();
    expect(t.reports).toEqual([
      [2, 'started', 'device'],
      [2, 'ended', 'device'],
    ]);
  });

  it('端末の声でも読めなかったら、失敗と報告する', () => {
    const t = setup();
    t.queue.enqueue({ text: '本人の文', seq: 2, expectAudio: false });
    t.current().events.onError('failed');
    expect(t.reports).toEqual([[2, 'failed', 'device']]);
    expect(t.spoken).toEqual([2]);
  });
});

describe('端末に日本語の声がないとき', () => {
  it('別の言語の声で読ませず、字幕だけになったことを示す', () => {
    const t = setup('none');
    t.queue.enqueue({ text: '本人の文', seq: 2, expectAudio: false });

    expect(t.playbacks).toHaveLength(0);
    expect(t.reports).toEqual([[2, 'failed', 'device']]);
    expect(t.lastState()).toMatchObject({ deviceVoiceMissing: true });
  });

  it('サーバーの音声は端末の声と関係なく鳴らせる', () => {
    const t = setup('none');
    t.queue.enqueue({ text: '本人の文', seq: 2, audio: audioOf('A2'), expectAudio: true });
    expect(t.played()).toEqual(['cloud:A2']);
  });

  it('声の一覧がまだ読み込まれていなければ、言語を指定して読む', () => {
    const t = setup('unknown');
    t.queue.enqueue({ text: '本人の文', seq: 2, expectAudio: false });
    expect(t.played()).toEqual(['device:本人の文']);
  });

  it('読み上げの機能がなければ読まない', () => {
    const t = setup('unsupported');
    t.queue.enqueue({ text: '本人の文', seq: 2, expectAudio: false });
    expect(t.playbacks).toHaveLength(0);
    expect(t.reports).toEqual([[2, 'failed', 'device']]);
  });
});

describe('ブラウザが自動再生を止めたとき', () => {
  it('先頭の文を残して待ち、操作の後に同じ文から鳴らす', () => {
    const t = setup();
    t.queue.enqueue({ text: '一つ目', seq: 2, audio: audioOf('A2'), expectAudio: true });
    t.queue.enqueue({ text: '二つ目', seq: 3, audio: audioOf('A3'), expectAudio: true });

    t.current().events.onError('blocked');

    expect(t.reports).toEqual([[2, 'blocked', 'cloud']]);
    expect(t.lastState()).toMatchObject({ blocked: true, phase: 'idle' });
    expect(t.queue.isPlaying).toBe(false);
    // 後ろの文を先に鳴らさない。
    expect(t.played()).toEqual(['cloud:A2']);

    t.queue.unlock();

    expect(t.output.unlock).toHaveBeenCalled();
    expect(t.played()).toEqual(['cloud:A2', 'cloud:A2']);
    expect(t.lastState()).toMatchObject({ blocked: false, phase: 'playing', seq: 2 });
    t.finish();
    expect(t.played()).toEqual(['cloud:A2', 'cloud:A2', 'cloud:A3']);
  });

  it('同じ文で何度止められても、止められた報告は1回', () => {
    const t = setup();
    t.queue.enqueue({ text: '一つ目', seq: 2, audio: audioOf('A2'), expectAudio: true });
    t.current().events.onError('blocked');
    t.queue.unlock();
    t.current().events.onError('blocked');
    expect(t.reports).toEqual([[2, 'blocked', 'cloud']]);
  });
});

describe('鳴らしてはいけない間', () => {
  it('録音中は始めず、終わってから鳴らす', () => {
    const t = setup();
    t.setPaused(true);
    t.queue.enqueue({ text: '本人の文', seq: 2, audio: audioOf('A2'), expectAudio: true });
    expect(t.playbacks).toHaveLength(0);
    expect(t.lastState()?.phase ?? 'idle').toBe('idle');

    t.setPaused(false);
    t.queue.process();
    expect(t.played()).toEqual(['cloud:A2']);
  });
});

describe('終わりの合図が来ないとき', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('サーバーの音声が始まらなければ止めて、端末の声で読み直す', () => {
    const t = setup();
    t.queue.enqueue({ text: '本人の文', seq: 2, audio: audioOf('A2'), expectAudio: true });

    vi.advanceTimersByTime(readingWatchdogMs('本人の文'));
    expect(t.playbacks[0].stopped).toBe(true);
    vi.advanceTimersByTime(300);

    expect(t.played()).toEqual(['cloud:A2', 'device:本人の文']);
  });

  it('始まった後に止まったら、読み上げ済みとも失敗とも報告しない', () => {
    const t = setup();
    t.queue.enqueue({ text: '本人の文', seq: 2, expectAudio: false });
    t.current().events.onStart();

    vi.advanceTimersByTime(readingWatchdogMs('本人の文'));

    expect(t.reports).toEqual([[2, 'started', 'device']]);
    expect(t.spoken).toEqual([2]);
    // 止めた後に届いた合図は使わない。
    t.playbacks[0].events.onEnd();
    expect(t.reports).toEqual([[2, 'started', 'device']]);
  });
});

describe('読み直しと再接続', () => {
  it('読み直しは手元の音声で鳴らし、読み終えた位置を変えない', () => {
    const t = setup();
    t.queue.enqueue({ text: '本人の文', seq: 2, audio: audioOf('A2'), expectAudio: true });
    t.finish();
    expect(t.spoken).toEqual([2]);

    t.queue.replay(2, '本人の文', true);

    expect(t.played()).toEqual(['cloud:A2', 'cloud:A2']);
    expect(t.requested).toEqual([]);
    t.finish();
    expect(t.spoken).toEqual([2]);
    expect(t.reports.filter(([, status]) => status === 'ended')).toHaveLength(2);
  });

  it('手元に音声がなければサーバーへ求める', () => {
    const t = setup();
    t.queue.replay(5, '前の文', true);
    expect(t.requested).toEqual([5]);
    t.queue.provideAudio(5, audioOf('A5'));
    expect(t.played()).toEqual(['cloud:A5']);
  });

  it('同じ文が並んでいれば、読み直しを足さない', () => {
    const t = setup();
    t.queue.enqueue({ text: '本人の文', seq: 2, expectAudio: true });
    t.queue.replay(2, '本人の文', true);
    t.queue.provideAudio(2, audioOf('A2'));
    t.finish();
    expect(t.played()).toEqual(['cloud:A2']);
  });

  it('再接続の後、音声を待っている文だけをサーバーへ求め直す', () => {
    const t = setup();
    t.queue.enqueue({ text: '一つ目', seq: 2, audio: audioOf('A2'), expectAudio: true });
    t.queue.enqueue({ text: '二つ目', seq: 3, expectAudio: true });
    t.queue.enqueue({ text: '案内', expectAudio: false });

    t.queue.requestPendingAudio();

    expect(t.requested).toEqual([3]);
  });

  it('止めると鳴らしている音を止め、並んでいた文を捨てる', () => {
    const t = setup();
    t.queue.enqueue({ text: '一つ目', seq: 2, audio: audioOf('A2'), expectAudio: true });
    t.queue.enqueue({ text: '二つ目', seq: 3, audio: audioOf('A3'), expectAudio: true });

    t.queue.clear();

    expect(t.playbacks[0].stopped).toBe(true);
    expect(t.device.cancelAll).toHaveBeenCalled();
    expect(t.queue.isPlaying).toBe(false);
    t.playbacks[0].events.onEnd();
    expect(t.played()).toEqual(['cloud:A2']);
    expect(t.reports).toEqual([]);
  });
});
