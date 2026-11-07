import type { CallRole, CallSnapshot, ServerMessage } from '@/lib/callProtocol';

export const SEAT_TOKEN = 'test-seat-token';

/** サーバーが参加時に送るスナップショットの既定値。 */
export function makeSnapshot(overrides: Partial<CallSnapshot> = {}): CallSnapshot {
  return {
    phase: 'connected',
    turns: [],
    peerConnected: true,
    isHospitalSpeaking: false,
    isPatientSpeaking: false,
    isGeneratingSuggestions: false,
    suggestions: null,
    appointment: null,
    invite: null,
    ...overrides,
  };
}

export function callJoined(
  role: CallRole,
  snapshot: Partial<CallSnapshot> = {},
  seatToken = SEAT_TOKEN,
): ServerMessage {
  return { type: 'call_joined', role, seatToken, snapshot: makeSnapshot(snapshot) };
}
