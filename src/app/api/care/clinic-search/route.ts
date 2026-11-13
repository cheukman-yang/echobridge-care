import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerCareAiService } from '../../../../../server/careAiService';

const RequestSchema = z.object({
  symptoms: z.string().max(600).default(''),
  area: z.string().max(120).optional(),
  preferredDepartment: z
    .enum(['ai_auto', 'internal', 'ent', 'dermatology', 'pediatrics'])
    .optional(),
  preferredSlots: z.array(z.string().max(100)).max(3).optional(),
  userLanguage: z.enum(['ja', 'en']).default('ja'),
});

export async function POST(request: Request) {
  try {
    const json: unknown = await request.json();
    const parsed = RequestSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    const service = getServerCareAiService();
    const result = await service.searchClinics(parsed.data);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
