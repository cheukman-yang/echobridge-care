import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerCareAiService } from '../../../../../server/careAiService';

const SandboxTurnSchema = z.object({
  id: z.string().max(80),
  sender: z.enum(['patient', 'receptionist']),
  textJa: z.string().max(500),
  textEn: z.string().max(600).optional(),
  origin: z.enum(['greeting', 'suggestion', 'polished', 'typed', 'quick_phrase']).optional(),
});

const RequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('turn'),
    intent: z.string().max(500).default(''),
    history: z.array(SandboxTurnSchema).max(40).default([]),
    userLanguage: z.enum(['ja', 'en']).default('ja'),
  }),
  z.object({
    action: z.literal('polish'),
    text: z.string().trim().min(1).max(400),
    userLanguage: z.enum(['ja', 'en']).default('ja'),
  }),
  z.object({
    action: z.literal('summary'),
    intent: z.string().max(500).default(''),
    history: z.array(SandboxTurnSchema).max(60).default([]),
  }),
]);

export async function POST(request: Request) {
  try {
    const json: unknown = await request.json();
    const parsed = RequestSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    const service = getServerCareAiService();
    const data = parsed.data;

    if (data.action === 'turn') {
      const response = await service.generateSandboxReceptionTurn({
        intent: data.intent,
        history: data.history,
        userLanguage: data.userLanguage,
      });
      return NextResponse.json(response);
    }

    if (data.action === 'polish') {
      const polished = await service.polishPatientConsultInput({
        text: data.text,
        userLanguage: data.userLanguage,
        history: [],
      });
      return NextResponse.json(polished);
    }

    const summary = await service.extractSandboxAppointment({
      intent: data.intent,
      history: data.history,
    });
    return NextResponse.json(summary);
  } catch {
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
