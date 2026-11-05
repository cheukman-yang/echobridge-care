import fastify from 'fastify';
import websocket from '@fastify/websocket';
import * as dotenv from 'dotenv';
import {
  ClientWsMessageSchema,
  ServerWsMessage,
  GeminiSuggestionResponse,
} from '../src/types/websocket';
import { generateCircuitBreakerSuggestions } from '../src/lib/fallbackSuggestions';

dotenv.config({ path: '.env.local' });

const server = fastify({ logger: true });
const PORT = Number(process.env.PORT) || 8080;

server.register(websocket);

server.register(async (fastifyInstance) => {
  fastifyInstance.get('/ws/call', { websocket: true }, (connection) => {
    let turnCount = 0;
    let fallbackTimer: NodeJS.Timeout | null = null;

    connection.socket.on('message', async (rawMessage: Buffer) => {
      try {
        const parsed = JSON.parse(rawMessage.toString());
        const result = ClientWsMessageSchema.safeParse(parsed);

        if (!result.success) {
          const errMsg: ServerWsMessage = {
            type: 'ERROR',
            payload: { code: 'INVALID_PAYLOAD', message: result.error.message, fatal: false },
          };
          connection.socket.send(JSON.stringify(errMsg));
          return;
        }

        const msg = result.data;

        switch (msg.type) {
          case 'SESSION_START':
            turnCount = 1;
            connection.socket.send(
              JSON.stringify({
                type: 'STT_TRANSCRIPT',
                payload: {
                  text: `${msg.payload.targetClinic}でございます。ご用件をお伺いいたします。`,
                  isFinal: true,
                },
              } as ServerWsMessage)
            );

            // 初期サジェスト提示
            const initialSuggestions = generateCircuitBreakerSuggestions('', turnCount);
            connection.socket.send(
              JSON.stringify({
                type: 'AI_SUGGESTIONS',
                payload: {
                  detected_intent: 'reception',
                  confidence_score: 1.0,
                  suggestions: initialSuggestions,
                },
              } as ServerWsMessage)
            );
            break;

          case 'AUDIO_CHUNK':
            // 16kHz PCM 音声チャンク受信（本番時は STT ストリームへ pipe）
            break;

          case 'USER_SPEECH_REQUEST':
            turnCount += 1;
            // 1.2秒サーキットブレーカーの起動
            if (fallbackTimer) clearTimeout(fallbackTimer);

            fallbackTimer = setTimeout(() => {
              const fallbackItems = generateCircuitBreakerSuggestions(msg.payload.text, turnCount);
              const fallbackPayload: GeminiSuggestionResponse = {
                detected_intent: 'fallback_timeout',
                confidence_score: 0.5,
                suggestions: fallbackItems,
              };
              connection.socket.send(
                JSON.stringify({
                  type: 'AI_SUGGESTIONS',
                  payload: fallbackPayload,
                } as ServerWsMessage)
              );
            }, 1200);

            // 相手側の返答シミュレーション（モック動作）
            setTimeout(() => {
              if (fallbackTimer) clearTimeout(fallbackTimer);

              const mockReply = '承知いたしました。来週火曜日の14時はいかがでしょうか？';
              connection.socket.send(
                JSON.stringify({
                  type: 'STT_TRANSCRIPT',
                  payload: { text: mockReply, isFinal: true },
                } as ServerWsMessage)
              );

              const suggestions = generateCircuitBreakerSuggestions(mockReply, turnCount);
              connection.socket.send(
                JSON.stringify({
                  type: 'AI_SUGGESTIONS',
                  payload: {
                    detected_intent: 'negotiation',
                    confidence_score: 0.95,
                    suggestions,
                  },
                } as ServerWsMessage)
              );
            }, 600);
            break;

          case 'SESSION_END':
            if (fallbackTimer) clearTimeout(fallbackTimer);
            connection.socket.send(
              JSON.stringify({
                type: 'CALL_SUMMARY',
                payload: {
                  clinic_name: 'ひまわり医院',
                  appointment_date: '2026-11-10',
                  appointment_time: '14:00',
                  department: '内科',
                  items_to_bring: ['保険証', 'お薬手帳'],
                  notes: '予約時間の10分前にお越しください。',
                  raw_transcript_summary: '初診予約の受付完了。11月10日14時枠で確定。',
                },
              } as ServerWsMessage)
            );
            break;

          case 'PING':
            connection.socket.send(JSON.stringify({ type: 'PONG' } as ServerWsMessage));
            break;
        }
      } catch (err) {
        connection.socket.send(
          JSON.stringify({
            type: 'ERROR',
            payload: { code: 'PARSE_ERROR', message: 'Invalid JSON', fatal: false },
          } as ServerWsMessage)
        );
      }
    });

    connection.socket.on('close', () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
    });
  });
});

const start = async () => {
  try {
    await server.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`> EchoBridge WS Server running on ws://localhost:${PORT}/ws/call`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
