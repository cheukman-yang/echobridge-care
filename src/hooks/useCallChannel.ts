import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { CLOSE_CODE_IDLE, CLOSE_CODE_SEAT_TAKEN } from '@/lib/callProtocol';
import type { CallRole, ClientMessage, ServerMessage } from '@/lib/callProtocol';
import { loadSeatToken, resolveCallSocketUrl, saveSeatToken } from '@/lib/callSession';

const RECONNECT_DELAY_MS = 1500;

export interface CallChannel {
  readonly role: CallRole;
  socketRef: { current: WebSocket | null };
  seatTokenRef: { current: string | null };
  /** この接続で席に戻れたか。開いた直後は参加前なので、通話のメッセージを送らない。 */
  isSeatedRef: { current: boolean };
  /** 送れたかどうかを返す。席のない間に送れるのは発信と参加だけ。 */
  send(message: ClientMessage): boolean;
  sendAudio(buffer: ArrayBuffer): void;
  hasSeat(): boolean;
  forgetSeat(): void;
}

/** 送信の窓口。受信の処理より先に作り、処理の中から送れるようにする。 */
export function useCallChannel(role: CallRole): CallChannel {
  const socketRef = useRef<WebSocket | null>(null);
  const seatTokenRef = useRef<string | null>(null);
  const isSeatedRef = useRef(false);

  return useMemo(() => {
    const openSocket = () => {
      const socket = socketRef.current;
      return socket && socket.readyState === WebSocket.OPEN ? socket : null;
    };

    return {
      role,
      socketRef,
      seatTokenRef,
      isSeatedRef,
      send(message) {
        const socket = openSocket();
        const isLobbyMessage = message.type === 'start_call' || message.type === 'join_call';
        if (!socket || (!isLobbyMessage && !isSeatedRef.current)) return false;
        socket.send(JSON.stringify(message));
        return true;
      },
      sendAudio(buffer) {
        if (isSeatedRef.current) openSocket()?.send(buffer);
      },
      hasSeat: () => seatTokenRef.current !== null,
      forgetSeat() {
        seatTokenRef.current = null;
        isSeatedRef.current = false;
        saveSeatToken(role, null);
      },
    };
  }, [role]);
}

interface CallSocketHandlers {
  onMessage(message: ServerMessage): void;
  /** バイナリのフレーム。本人の画面では、中継された相手の声（PARTNER_AUDIO_SAMPLE_RATE_HZ のPCM）。 */
  onAudio?(chunk: ArrayBuffer): void;
  /** 接続が切れた。席は残っているので、自動でつなぎ直す。 */
  onDisconnected?(): void;
  /** 同じ席に別の画面が入った。席は相手のものになったので、この画面からは戻らない。 */
  onSeatTaken?(): void;
  /** 接続のたびに、参加の仕方を決める。既定は席があれば戻る。 */
  chooseJoin?(seatToken: string | null): ClientMessage | null;
}

const defaultJoin = (seatToken: string | null): ClientMessage | null =>
  seatToken ? { type: 'join_call', seatToken } : null;

/**
 * 通話サーバーへの接続を保つ。接続中かどうかを返す。
 * 切れたらつなぎ直し、席のトークンがあれば同じ通話へ戻る。
 */
export function useCallSocket(channel: CallChannel, handlers: CallSocketHandlers): boolean {
  const [isConnected, setIsConnected] = useState(false);
  const { role, socketRef, seatTokenRef, isSeatedRef } = channel;

  const handleOpen = useEffectEvent((socket: WebSocket) => {
    setIsConnected(true);
    const join = (handlers.chooseJoin ?? defaultJoin)(seatTokenRef.current);
    if (join) socket.send(JSON.stringify(join));
  });

  const handleMessage = useEffectEvent((message: ServerMessage) => {
    if (message.type === 'call_joined') {
      isSeatedRef.current = true;
      seatTokenRef.current = message.seatToken;
      saveSeatToken(role, message.seatToken);
    } else if (
      message.type === 'call_closed' ||
      (message.type === 'call_error' && message.code === 'call_not_found')
    ) {
      channel.forgetSeat();
    }
    handlers.onMessage(message);
  });

  const handleAudio = useEffectEvent((chunk: ArrayBuffer) => {
    handlers.onAudio?.(chunk);
  });

  const handleClose = useEffectEvent((code: number | undefined) => {
    setIsConnected(false);
    isSeatedRef.current = false;
    if (code === CLOSE_CODE_SEAT_TAKEN) {
      channel.forgetSeat();
      handlers.onSeatTaken?.();
    }
    handlers.onDisconnected?.();
  });

  useEffect(() => {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    seatTokenRef.current = loadSeatToken(role);

    // 待機中で閉じられたら、すぐにはつなぎ直さない。操作があるか、タブが前面に戻ったらつなぐ。
    const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'focus'] as const;
    let waitingForActivity = false;
    const onActivity = () => {
      if (!waitingForActivity || document.visibilityState !== 'visible') return;
      stopWaitingForActivity();
      connect();
    };
    const stopWaitingForActivity = () => {
      waitingForActivity = false;
      ACTIVITY_EVENTS.forEach((type) => window.removeEventListener(type, onActivity, true));
      document.removeEventListener('visibilitychange', onActivity);
    };
    const waitForActivity = () => {
      waitingForActivity = true;
      ACTIVITY_EVENTS.forEach((type) => window.addEventListener(type, onActivity, true));
      document.addEventListener('visibilitychange', onActivity);
    };

    const connect = () => {
      const socket = new WebSocket(resolveCallSocketUrl(window.location));
      // 中継された音声を ArrayBuffer で受け取る（既定の Blob だと読むたびに待ちが入る）。
      socket.binaryType = 'arraybuffer';
      socketRef.current = socket;

      socket.onopen = () => {
        if (!disposed) handleOpen(socket);
      };

      socket.onclose = (event) => {
        if (disposed) return;
        handleClose(event?.code);
        if (event?.code === CLOSE_CODE_IDLE) {
          waitForActivity();
          return;
        }
        retryTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      };

      socket.onmessage = (event) => {
        if (disposed) return;
        if (event.data instanceof ArrayBuffer) {
          handleAudio(event.data);
          return;
        }
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        handleMessage(message);
      };
    };

    connect();

    return () => {
      disposed = true;
      stopWaitingForActivity();
      if (retryTimer) clearTimeout(retryTimer);
      socketRef.current?.close();
    };
  }, [role, socketRef, seatTokenRef]);

  return isConnected;
}
