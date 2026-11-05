import { SuggestionItem } from '../types/websocket';

export type ConversationPhase = 'reception' | 'negotiation' | 'confirmation';

export const FALLBACK_TEMPLATES: Record<
  ConversationPhase,
  (param?: string) => [SuggestionItem, SuggestionItem, SuggestionItem]
> = {
  reception: () => [
    {
      id: 'fb_rec_1',
      label: '初診の予約希望',
      speech_text: '初めて受診したいのですが、予約をお願いできますでしょうか。',
      intent: 'general',
      is_fallback: true,
    },
    {
      id: 'fb_rec_2',
      label: '再診・いつ空いているか確認',
      speech_text: '診察券を持っています。今週で予約可能な空き枠はありますか？',
      intent: 'general',
      is_fallback: true,
    },
    {
      id: 'fb_rec_3',
      label: '診療科・担当医の相談',
      speech_text: '症状についてご相談したいのですが、本日は診察を受けられますか？',
      intent: 'general',
      is_fallback: true,
    },
  ],
  negotiation: (nextFreeSlot: string = '15:00') => [
    {
      id: 'fb_neg_1',
      label: 'その時間でお願いします (受諾)',
      speech_text: 'はい、その時間でよろしくお願いいたします。',
      intent: 'accept',
      is_fallback: true,
    },
    {
      id: 'fb_neg_2',
      label: '別の時間帯を希望 (逆提案)',
      speech_text: `あいにくその時間は都合が悪く、${nextFreeSlot}以降の枠は空いていますでしょうか？`,
      intent: 'counter_offer',
      is_fallback: true,
    },
    {
      id: 'fb_neg_3',
      label: '別の日程を検討 (辞退)',
      speech_text: '申し訳ありません、その日は難しいので別の日程を案内していただけますか？',
      intent: 'decline',
      is_fallback: true,
    },
  ],
  confirmation: () => [
    {
      id: 'fb_conf_1',
      label: '復唱して確定 (了解)',
      speech_text: '承知いたしました。当日は保険証とお薬手帳を持参して10分前に伺います。',
      intent: 'accept',
      is_fallback: true,
    },
    {
      id: 'fb_conf_2',
      label: '事前問診や持ち物の再確認',
      speech_text: '初診問診票は事前にWEBで回答可能でしょうか？',
      intent: 'general',
      is_fallback: true,
    },
    {
      id: 'fb_conf_3',
      label: 'お礼を言って通話を終える',
      speech_text: '丁寧にご対応いただきありがとうございました。失礼いたします。',
      intent: 'general',
      is_fallback: true,
    },
  ],
};

export function detectConversationPhase(transcript: string, turnCount: number): ConversationPhase {
  // ターン数または確定キーワードを最優先
  if (turnCount >= 3 || /(お取り|確定|保険証|お薬手帳|お越し|お待ちして|お大事に)/.test(transcript)) {
    return 'confirmation';
  }
  if (/(\d+月|\d+日|\d+時|来週|火曜|水曜|木曜|金曜|土曜|空いて|いかが)/.test(transcript)) {
    return 'negotiation';
  }
  if (/(予約|初診|ご用件|お電話ありがとうございます|どうされました)/.test(transcript)) {
    return 'reception';
  }

  if (turnCount <= 1) return 'reception';
  if (turnCount === 2) return 'negotiation';
  return 'confirmation';
}

export function generateCircuitBreakerSuggestions(
  transcript: string,
  turnCount: number,
  nextFreeSlot: string = '15:00'
): [SuggestionItem, SuggestionItem, SuggestionItem] {
  const phase = detectConversationPhase(transcript, turnCount);
  if (phase === 'negotiation') {
    return FALLBACK_TEMPLATES.negotiation(nextFreeSlot);
  }
  return FALLBACK_TEMPLATES[phase]();
}