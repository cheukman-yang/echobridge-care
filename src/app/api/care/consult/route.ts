import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerCareAiService } from '../../../../../server/careAiService';

const ConsultationTurnSchema = z.object({
  id: z.string().max(80),
  speaker: z.enum(['doctor', 'patient']),
  japaneseText: z.string().max(600),
  englishText: z.string().max(700).optional(),
  rawInput: z.string().max(600).optional(),
  timestamp: z.string().max(80),
});

const RequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('simulate_doctor'),
    chiefComplaint: z.string().max(500).default(''),
    history: z.array(ConsultationTurnSchema).max(50).default([]),
    userLanguage: z.enum(['ja', 'en']).default('ja'),
    doctorLanguage: z.enum(['ja', 'en']).default('ja'),
  }),
  z.object({
    action: z.literal('doctor_speech'),
    doctorJapaneseText: z.string().trim().min(1).max(600),
    chiefComplaint: z.string().max(500).default(''),
    history: z.array(ConsultationTurnSchema).max(50).default([]),
    userLanguage: z.enum(['ja', 'en']).default('ja'),
    doctorLanguage: z.enum(['ja', 'en']).default('ja'),
  }),
  z.object({
    action: z.literal('patient_polish'),
    text: z.string().trim().min(1).max(500),
    history: z.array(ConsultationTurnSchema).max(50).default([]),
    userLanguage: z.enum(['ja', 'en']).default('ja'),
    doctorLanguage: z.enum(['ja', 'en']).default('ja'),
  }),
  z.object({
    action: z.literal('summary'),
    turns: z.array(ConsultationTurnSchema).max(80).default([]),
    chiefComplaint: z.string().max(500).default(''),
    clinicName: z.string().max(120).default('EchoBridge Care 模擬クリニック'),
    userLanguage: z.enum(['ja', 'en']).default('ja'),
    doctorLanguage: z.enum(['ja', 'en']).default('ja'),
  }),
]);

/**
 * 対面診察モード用のAPIルート。
 * センシティブな対話データはリクエスト処理中のみメモリ上で扱い、サーバー・クラウドには一切永続保存しない。
 */
export async function POST(request: Request) {
  try {
    const json: unknown = await request.json();
    const parsed = RequestSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    const service = getServerCareAiService();
    const data = parsed.data;

    if (data.action === 'simulate_doctor') {
      const result = await service.simulateDoctorTurn({
        chiefComplaint: data.chiefComplaint,
        history: data.history,
        userLanguage: data.userLanguage,
        doctorLanguage: data.doctorLanguage,
      });
      return NextResponse.json(result);
    }

    if (data.action === 'doctor_speech') {
      const result = await service.processDoctorSpeech({
        doctorJapaneseText: data.doctorJapaneseText,
        chiefComplaint: data.chiefComplaint,
        history: data.history,
        userLanguage: data.userLanguage,
        doctorLanguage: data.doctorLanguage,
      });
      return NextResponse.json(result);
    }

    if (data.action === 'patient_polish') {
      const result = await service.polishPatientConsultInput({
        text: data.text,
        history: data.history,
        userLanguage: data.userLanguage,
        doctorLanguage: data.doctorLanguage,
      });
      return NextResponse.json(result);
    }

    const summary = await service.summarizeConsultation({
      turns: data.turns,
      chiefComplaint: data.chiefComplaint,
      clinicName: data.clinicName,
      userLanguage: data.userLanguage,
      doctorLanguage: data.doctorLanguage,
    });
    return NextResponse.json(summary);
  } catch {
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
