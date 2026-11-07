import type { ServerMessage } from '@/lib/callProtocol';

/** ブラウザの WebSocket の代わり。送った内容を記録し、受信を手で起こせる。 */
export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: Record<string, unknown>[] = [];
  audio: ArrayBuffer[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer) {
    if (typeof data === 'string') {
      this.sent.push(JSON.parse(data));
    } else {
      this.audio.push(data);
    }
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  drop(code = 1006) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  receive(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  sentOfType(type: string) {
    return this.sent.filter((message) => message.type === type);
  }
}
