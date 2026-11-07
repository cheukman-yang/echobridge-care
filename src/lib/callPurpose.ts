/**
 * 通話の目的。目的が変えるのは、文言の既定値とAIへの追加の規則だけで、画面と処理は共通にする。
 * サーバーとブラウザの両方が使うので、Node専用のAPIに依存させない。
 */
export const CALL_PURPOSES = ['medical', 'general'] as const;

export type CallPurpose = (typeof CALL_PURPOSES)[number];

/** 古い画面やテストのように目的を送らない発信は、代表的な利用例として扱う。 */
export const DEFAULT_CALL_PURPOSE: CallPurpose = 'medical';

/** 相手の名前の上限。画面の見出しと予定の場所に使う。 */
export const MAX_PARTNER_NAME_LENGTH = 40;

export interface CallPurposeProfile {
  label: string;
  description: string;
  partnerPlaceholder: string;
  intentPlaceholder: string;
  /** 相手が応答したとき、用件の前に読み上げる文。 */
  greetingPrefix: string;
  /** 用件が空でAIも題名を返さなかったときの、予定の題名。 */
  defaultEventTitle: string;
  /** 予定の場所を読み取れなかったとき、相手の名前を場所にするか。医療機関なら相手の名前が場所になる。 */
  partnerIsPlace: boolean;
}

export const CALL_PURPOSE_PROFILES: Record<CallPurpose, CallPurposeProfile> = {
  medical: {
    label: '医療機関への連絡',
    description: '病院や薬局への予約、問い合わせ',
    partnerPlaceholder: '例：ひまわり医院',
    intentPlaceholder: '例：内科の初診予約をしたいです',
    greetingPrefix: 'お忙しいところ恐れ入ります。AI音声アシスタントを介してお電話しております。',
    defaultEventTitle: '通院の予定',
    partnerIsPlace: true,
  },
  general: {
    label: '日常の連絡',
    description: '家族や知人、お店などへの連絡',
    partnerPlaceholder: '例：母、駅前の美容室',
    intentPlaceholder: '例：土曜日の待ち合わせ時間を決めたいです',
    greetingPrefix: 'もしもし。AI音声アシスタントを使ってお話ししています。',
    defaultEventTitle: '予定',
    partnerIsPlace: false,
  },
};

export function isCallPurpose(value: unknown): value is CallPurpose {
  return typeof value === 'string' && (CALL_PURPOSES as readonly string[]).includes(value);
}

/** 相手の名前を1行の表示用にそろえる。改行や制御文字は空白にする。 */
export function normalizePartnerName(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PARTNER_NAME_LENGTH);
}
