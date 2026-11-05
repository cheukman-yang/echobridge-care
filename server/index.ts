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
  fastifyInstance.get('/ws/call', { websocket: true }, (socket) => {
    let turnCount = 0;
    let fallbackTimer: NodeJS.Timeout | null = null;

    socket.on('message', async (rawMessage: Buffer) => {
      try {
        const parsed = JSON.parse(rawMessage.toString());
        const result = ClientWsMessageSchema.safeParse(parsed);

        if (!result.success) {
          const errMsg: ServerWsMessage = {
            type: 'ERROR',
            payload: { code: 'INVALID_PAYLOAD', message: result.error.message, fatal: false },
          };
          socket.send(JSON.stringify(errMsg));
          return;
        }

        const msg = result.data;

        switch (msg.type) {
          case 'SESSION_START':
            turnCount = 1;
            socket.send(
              JSON.stringify({
                type: 'STT_TRANSCRIPT',
                payload: {
                  text: `${msg.payload.targetClinic}でございます。ご用件をお伺いいたします。`,
                  isFinal: true,
                },
              } as ServerWsMessage)
            );

            // 初期サジェスト（受付フェーズ）
            const initialSuggestions = generateCircuitBreakerSuggestions('', turnCount);
            socket.send(
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
            break;

          case 'USER_SPEECH_REQUEST':
            turnCount += 1;
            if (fallbackTimer) clearTimeout(fallbackTimer);

            // 医院側のシナリオ遷移レスポンス
            setTimeout(() => {
              if (fallbackTimer) clearTimeout(fallbackTimer);

              let mockReply = '';
              let intent = 'negotiation';

              if (turnCount === 2) {
                // 初回発話後: 日時を提示
                mockReply = '承知いたしました。来週火曜日の14時はいかがでしょうか？';
                intent = 'negotiation';
              } else if (turnCount === 3) {
                // 日時合意後: 予約確定と持ち物案内
                mockReply = 'かしこまりました。11月10日火曜日の14時でお取りいたしました。当日は保険証とお薬手帳をご持参のうえ、10分前にお越しください。';
                intent = 'confirmation';
              } else {
                // 終了確認
                mockReply = '他にご不明点はございますでしょうか？なければお電話を切らせていただきます。';
                intent = 'closing';
              }

              socket.send(
                JSON.stringify({
                  type: 'STT_TRANSCRIPT',
                  payload: { text: mockReply, isFinal: true },
                } as ServerWsMessage)
              );

              const suggestions = generateCircuitBreakerSuggestions(mockReply, turnCount);
              const payload: GeminiSuggestionResponse = {
                detected_intent: intent,
                confidence_score: 0.95,
                suggestions,
              };

              socket.send(
                JSON.stringify({
                  type: 'AI_SUGGESTIONS',
                  payload,
                } as ServerWsMessage)
              );
            }, 600);
            break;

          case 'SESSION_END':
            if (fallbackTimer) clearTimeout(fallbackTimer);
            socket.send(
              JSON.stringify({
                type: 'CALL_SUMMARY',
                payload: {
                  clinic_name: 'ひまわり医院',
                  appointment_date: '2026-11-10',
                  appointment_time: '14:00',
                  department: '内科',
                  items_to_bring: ['健康保険証 / マイナ保険証', 'お薬手帳'],
                  notes: '初診のため問診票記入あり。予約時間の10分前に来院。',
                  raw_transcript_summary: '来週火曜（11/10）14:00の内科初診予約が完了。持ち物と来院時間を案内済み。',
                },
              } as ServerWsMessage)
            );
            break;

          case 'PING':
            socket.send(JSON.stringify({ type: 'PONG' } as ServerWsMessage));
            break;
        }
      } catch (err) {
        socket.send(
          JSON.stringify({
            type: 'ERROR',
            payload: { code: 'PARSE_ERROR', message: 'Invalid JSON', fatal: false },
          } as ServerWsMessage)
        );
      }
    });

    socket.on('close', () => {
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