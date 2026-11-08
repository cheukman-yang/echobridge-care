import type {
  CallTurn,
  PlaybackStatus,
  SpeechEngine,
  SynthesisFailureReason,
  SynthesisStatus,
} from './callProtocol';

/**
 * 本人の1文が相手に届くまでの状態。本人の画面に出す。
 * 音声を作れたこと（サーバー）と、相手の端末で鳴ったこと（相手の画面の報告）は別に持つ。
 */
export interface SpeechDelivery {
  synthesis?: SynthesisStatus;
  synthesisReason?: SynthesisFailureReason;
  playback?: PlaybackStatus;
  engine?: SpeechEngine;
  /** 本人が読み直しを頼み、まだ相手の端末から報告がない。 */
  replayRequested?: boolean;
}

export type DeliveryTone = 'muted' | 'live' | 'done' | 'warning' | 'danger';

export interface DeliveryView {
  label: string;
  tone: DeliveryTone;
}

const ENGINE_LABELS: Record<SpeechEngine, string> = {
  cloud: 'Google音声',
  device: '端末の読み上げ機能',
};

/** 本人の画面の「送信済み」の行に出す文。 */
export function describeDelivery(delivery: SpeechDelivery | undefined, ttsAvailable: boolean): DeliveryView {
  const current = delivery ?? {};
  const engine = current.engine ? `（${ENGINE_LABELS[current.engine]}）` : '';
  switch (current.playback) {
    case 'started':
      return { label: `読み上げ中${engine}`, tone: 'live' };
    case 'ended':
      return { label: `相手の端末で再生済み${engine}`, tone: 'done' };
    case 'blocked':
      return { label: '相手の端末で再生が止められています。相手の操作を待っています', tone: 'warning' };
    case 'failed':
      return { label: '相手の端末で再生できませんでした。相手の字幕には表示されています', tone: 'danger' };
    default:
      break;
  }
  if (current.replayRequested) return { label: 'もう一度読み上げるよう依頼しました', tone: 'muted' };
  if (current.synthesis === 'ready') return { label: '音声を作成済み・相手の端末で再生待ち', tone: 'muted' };
  if (current.synthesis === 'failed') {
    const reason =
      current.synthesisReason === 'quota' ? 'Google音声の利用上限に達したため' : 'Google音声を作れなかったため';
    return { label: `${reason}、相手の端末の音声で読み上げます`, tone: 'warning' };
  }
  return ttsAvailable ? { label: '音声を作成中', tone: 'muted' } : { label: '送信済み', tone: 'muted' };
}

/** 読み直しを頼めるか。鳴り終えた文と、鳴らせなかった文だけ。 */
export function canRequestReplay(delivery: SpeechDelivery | undefined): boolean {
  return delivery?.playback === 'ended' || delivery?.playback === 'failed';
}

export function deliveryFromTurns(turns: CallTurn[]): Record<string, SpeechDelivery> {
  const entries = turns.flatMap((turn): [string, SpeechDelivery][] => {
    if (turn.sender !== '患者') return [];
    const delivery: SpeechDelivery = {
      synthesis: turn.synthesis,
      synthesisReason: turn.synthesisReason,
      playback: turn.playback,
      engine: turn.playbackEngine,
    };
    return Object.values(delivery).some((value) => value !== undefined) ? [[String(turn.seq), delivery]] : [];
  });
  return Object.fromEntries(entries);
}
