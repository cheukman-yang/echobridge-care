import type { CallClosedReason, CallErrorCode } from './callProtocol';

/** 通話が閉じられたときに、画面に出す説明。 */
export const CALL_CLOSED_NOTICES: Record<CallClosedReason, string> = {
  reset: '相手が通話を終了しました。',
  invite_expired: '時間内に応答がなかったため、発信を取り消しました。',
  abandoned: '接続が切れたまま戻らなかったため、通話を終了しました。',
  time_limit: '通話の上限時間に達したため、通話を終了しました。',
  retention_expired: 'サーバーの通話記録を削除しました。この画面を閉じると内容は消えます。',
  server_closing: 'サーバーの停止により、通話を終了しました。',
};

/** 利用者に知らせる必要がある失敗の説明。ほかの理由は操作の行き違いなので画面に出さない。 */
export const CALL_ERROR_NOTICES: Partial<Record<CallErrorCode, string>> = {
  invalid_invite: 'このコードは使えません。期限切れか、すでに応答済みの可能性があります。',
  call_not_found: '通話が見つかりません。終了したか、サーバーが再起動した可能性があります。',
  server_busy: '混み合っているため発信できませんでした。しばらくしてからお試しください。',
};

export const SEAT_TAKEN_NOTICE = 'この通話は別の画面で開かれたため、ここでの接続を終了しました。';

export const PEER_DISCONNECTED_NOTICE = '相手の接続が切れています。戻ると、送った文から読み上げます。';

export const RECONNECTING_NOTICE = '接続が切れました。再接続しています...';
