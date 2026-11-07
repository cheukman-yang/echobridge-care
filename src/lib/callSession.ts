import { CALL_SOCKET_PATH } from './callProtocol';
import type { CallRole } from './callProtocol';

/** 開発時の通話サーバーのポート。Next.jsとは別のプロセスで動く。 */
const DEV_SERVER_PORT = 8080;

const SEAT_KEY_PREFIX = 'echobridge.seat.';
const SPOKEN_KEY = 'echobridge.hospital.spoken';

/**
 * 通話サーバーの接続先を決める。
 * 本番は同一オリジンを既定にする。別サービスに分けるときは NEXT_PUBLIC_WS_URL をビルド時に指定する。
 */
export function resolveCallSocketUrl(
  location: Pick<Location, 'protocol' | 'host' | 'hostname'>,
  configuredUrl = process.env.NEXT_PUBLIC_WS_URL,
  isDevelopment = process.env.NODE_ENV === 'development',
): string {
  if (configuredUrl) return configuredUrl;
  if (isDevelopment) return `ws://${location.hostname}:${DEV_SERVER_PORT}${CALL_SOCKET_PATH}`;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}${CALL_SOCKET_PATH}`;
}

/**
 * sessionStorage はプライベートモードなどで例外を投げることがある。
 * 使えなくても通話は続けられるので、読めなかったものとして扱う。
 */
function readStorage(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) {
      window.sessionStorage.removeItem(key);
    } else {
      window.sessionStorage.setItem(key, value);
    }
  } catch {
    // 再読み込みで復帰できなくなるだけなので、通話は止めない。
  }
}

/**
 * 席のトークンはタブごとに持つ。
 * localStorage だとタブ間で共有され、同じPCの2タブが別の通話に入れなくなる。
 */
export function loadSeatToken(role: CallRole): string | null {
  return readStorage(`${SEAT_KEY_PREFIX}${role}`);
}

export function saveSeatToken(role: CallRole, token: string | null): void {
  writeStorage(`${SEAT_KEY_PREFIX}${role}`, token);
}

/** どの発言まで読み上げたかを、席ごとに読み出す。別の通話の値は使わない。 */
export function loadSpokenSeq(seatToken: string): number {
  const saved = readStorage(SPOKEN_KEY);
  if (!saved) return 0;
  try {
    const parsed = JSON.parse(saved) as { seatToken?: unknown; seq?: unknown };
    return parsed.seatToken === seatToken && typeof parsed.seq === 'number' ? parsed.seq : 0;
  } catch {
    return 0;
  }
}

export function saveSpokenSeq(seatToken: string, seq: number): void {
  writeStorage(SPOKEN_KEY, JSON.stringify({ seatToken, seq }));
}
