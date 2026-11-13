import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerCareAiService } from '../../../../server/careAiService';

const RequestSchema = z.object({
  text: z.string().trim().min(1).max(500),
  field: z.enum(['symptoms', 'intent', 'consult_memo']).default('symptoms'),
  userLanguage: z.enum(['ja', 'en']).default('ja'),
  departmentLabel: z.string().max(60).optional(),
  preferredSlots: z.array(z.string().max(80)).max(3).optional(),
});

/**
 * 各ステップの自由記述メモ欄（「✨ AIブラッシュアップ」）専用の整形APIルート。
 * サーバー・クラウドへの永続保存は一切行わず、APIキー未設定・タイムアウト時は即座にローカル整形へフォールバックする。
 */
export async function POST(request: Request) {
  try {
    const json: unknown = await request.json();
    const parsed = RequestSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    const service = getServerCareAiService();
    const result = await service.polishDraftField(parsed.data);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
