import { SuggestionItem } from '@/types/websocket';

export type ConversationPhase = 'reception' | 'negotiation' | 'confirmation';

/**
 * 通話フェーズごとの静的フォールバックテンプレート辞書
 * SRE方針: 音声通話の沈黙限界（1.5秒）を死守し、API遅延時でも決定論的に会話を前進させる
 */
const FALLBACK_TEMPLATES = {
  reception: [
    {
      id: 'fb_rec_1',
      label: 'はい、初診の予約希望です',
      speech_text: 'はい、初診の予約をお願いいたします。',
      intent: 'accept' as const,
      is_fallback: true,
    },
    {
      id: 'fb_rec_2',
      label: '受診について相談したい',
      speech_text: '受診についてご相談させていただけますでしょうか。',
      intent: 'general' as const,
      is_fallback: true,
    },
    {
      id: 'fb_rec_3',
      label: '少々確認させてください',
      speech_text: '少々確認させていただけますでしょうか。',
      intent: 'general' as const,
      is_fallback: true,
    },
  ],
  negotiation: (nextFreeSlot: string) => [
    {
      id: 'fb_neg_1',
      label: `${nextFreeSlot}以降なら伺えます`,
      speech_text: `その時間は都合がつかないため、${nextFreeSlot}以降でお願いできますでしょうか。`,
      intent: 'counter_offer' as const,
      is_fallback: true,
    },
    {
      id: 'fb_neg_2',
      label: '別の曜日でお願いします',
      speech_text: '申し訳ございません、別の曜日で調整いただくことは可能でしょうか。',
      intent: 'decline' as const,
      is_fallback: true,
    },
    {
      id: 'fb_neg_3',
      label: '午前中は空いていますか',
      speech_text: '午前中のお時間帯でしたら空いておりますでしょうか。',
      intent: 'counter_offer' as const,
      is_fallback: true,
    },
  ],
  confirmation: [
    {
      id: 'fb_cnf_1',
      label: '承知しました（予約確定）',
      speech_text: '承知いたしました。当日はよろしくお願いいたします。',
      intent: 'accept' as const,
      is_fallback: true,
    },
    {
      id: 'fb_cnf_2',
      label: '持ち物を再確認したい',
      speech_text: '当日の持ち物について、もう一度確認させていただけますでしょうか。',
      intent: 'general' as const,
      is_fallback: true,
    },
    {
      id: 'fb_cnf_3',
      label: 'ありがとうございました',
      speech_text: 'ご対応いただきありがとうございました。失礼いたします。',
      intent: 'general' as const,
      is_fallback: true,
    },
  ],
};

/**
 * STT文字起こしテキストおよび通話ターン数から会話フェーズを推定する軽量ステートマシン
 *
 * @param transcript 直近の相手側確定発話テキスト
 * @param turnCount 現在の会話ターン数 (1開始)
 */
export function detectConversationPhase(transcript: string, turnCount: number): ConversationPhase {
  // 1. 正規表現によるキーワード即時検知
  if (/(予約|初診|ご用件|お電話ありがとうございます|どうされました)/.test(transcript)) {
    return 'reception';
  }
  if (/(\d+月|\d+日|\d+時|来週|火曜|水曜|木曜|金曜|土曜|空いて|いかが)/.test(transcript)) {
    return 'negotiation';
  }
  if (/(かしこまりました|承知|お取りします|お待ちして|保険証|お大事に)/.test(transcript)) {
    return 'confirmation';
  }

  // 2. キーワード未検出時のターン数フォールバック
  if (turnCount <= 1) return 'reception';
  if (turnCount === 2) return 'negotiation';
  return 'confirmation';
}

/**
 * 1.2秒サーキットブレーカー発動時に呼び出す静的3択生成関数
 *
 * @param transcript 直近の相手側確定テキスト
 * @param turnCount 現在のターン数
 * @param nextFreeSlot カレンダーキャッシュから取得した直近の空き時間（デフォルト: 15:00）
 */
export function generateCircuitBreakerSuggestions(
  transcript: string,
  turnCount: number,
  nextFreeSlot: string = '15時'
): [SuggestionItem, SuggestionItem, SuggestionItem] {
  const phase = detectConversationPhase(transcript, turnCount);

  if (phase === 'negotiation') {
    return FALLBACK_TEMPLATES.negotiation(nextFreeSlot) as [SuggestionItem, SuggestionItem, SuggestionItem];
  }

  return FALLBACK_TEMPLATES[phase] as [SuggestionItem, SuggestionItem, SuggestionItem];
}
