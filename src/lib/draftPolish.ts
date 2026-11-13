import type { UserLanguage } from './userLanguage';

/** AIブラッシュアップ対象の入力欄種別。 */
export type DraftPolishField = 'symptoms' | 'intent' | 'consult_memo';

export interface DraftPolishInput {
  text: string;
  field: DraftPolishField;
  userLanguage: UserLanguage;
  departmentLabel?: string;
  preferredSlots?: string[];
}

function normalizeColloquialJa(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/\r?\n+/g, '、')
    .replace(/きのう/g, '昨日')
    .replace(/おととい/g, '一昨日')
    .replace(/けさ/g, '今朝')
    .replace(/ゆうべ/g, '昨夜')
    .replace(/(?:のど|喉)が?痛(?:い|くて)|(?:のど|喉)の痛み/g, '咽頭痛（喉の痛み）')
    .replace(/(?:あたま|頭)が?痛(?:い|くて)/g, '頭痛')
    .replace(/(?:おなか|お腹)が?痛(?:い|くて)/g, '腹痛')
    .replace(/(?:みみ|耳)が?痛(?:い|くて)/g, '耳の痛み')
    .replace(/熱が?\s*(\d{2}(?:\.\d)?)\s*(?:度|℃)/g, '$1度の発熱')
    .replace(/(\d{2}(?:\.\d)?)\s*(?:度|℃)の熱/g, '$1度の発熱')
    .replace(/(?:昨日|昨夜|今朝|一昨日)から熱と/g, (m) => m.replace('熱と', '発熱と'))
    .replace(/アレルギー(?:は)?(?:なし|ないです)/g, '薬物・食物アレルギーはございません')
    .replace(/今日(?:み|診)てもらいたい(?:です)?/g, '本日の受診を希望しております')
    .replace(/(?:み|診)てもらいたい(?:です)?/g, '受診を希望しております')
    .replace(/、{2,}/g, '、')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeColloquialEn(raw: string): string {
  const compact = raw
    .replace(/\r?\n+/g, ', ')
    .replace(/\bw\/\b/gi, 'with')
    .replace(/\btemp\b/gi, 'temperature')
    .replace(/\b(?:my\s+)?throat hurts\b/gi, 'a sore throat')
    .replace(/\b(?:my\s+)?stomach hurts\b/gi, 'abdominal pain')
    .replace(/\b(?:my\s+)?head hurts\b/gi, 'a headache')
    .replace(/\bno allergies\b/gi, 'no known drug or food allergies')
    .replace(/(\d{2}(?:\.\d)?)\s*(?:c|deg|degrees)\b/gi, '$1°C')
    .replace(/\bfever\s+(\d{2}(?:\.\d)?(?:°C)?)/gi, 'a $1 fever')
    .replace(/\s+/g, ' ')
    .trim();
  if (!compact) return '';
  return compact.charAt(0).toUpperCase() + compact.slice(1);
}

/**
 * Gemini API 未設定時・タイムアウト時でも即座に自然な医療表現へ整形するローカルフォールバック。
 * ユーザーが入力していない症状や事実を創作せず、丁寧で伝わりやすい文章へ整える。
 */
export function polishDraftLocally(input: DraftPolishInput): string {
  const raw = input.text.trim();
  if (!raw) return '';

  const slots = (input.preferredSlots ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 3);
  const dept = input.departmentLabel?.trim() ?? '';

  if (input.userLanguage === 'en') {
    const baseEn = normalizeColloquialEn(raw).replace(/[.!?,;\s]+$/, '');
    if (input.field === 'intent') {
      const hasBookingPhrase = /\b(appointment|book|schedule|visit|calling)\b/i.test(baseEn);
      const slotPart =
        slots.length > 0 && !slots.some((slot) => baseEn.includes(slot))
          ? ` Preferred times: ${slots.map((s, idx) => `(${idx + 1}) ${s}`).join(', ')}.`
          : '';
      if (hasBookingPhrase) {
        return `${baseEn.replace(/\bi want to\b/gi, 'I would like to')}.${slotPart}`.trim();
      }
      const deptPart = dept ? `${dept} ` : '';
      return `I would like to request a first-visit ${deptPart}appointment regarding the following symptoms: ${baseEn}.${slotPart}`.trim();
    }

    if (input.field === 'consult_memo') {
      if (/\b(please|appreciate|thank you|today)\b/i.test(baseEn)) {
        return `${baseEn}. Please let me know what you recommend.`;
      }
      return `Symptoms & course: ${baseEn}. Thank you for examining me today.`;
    }

    // symptoms (Step 1)
    if (/\b(would like|looking for|request|appointment|consult)\b/i.test(baseEn)) {
      return `${baseEn.replace(/\blooking for\b/gi, 'I would like to request')}.`;
    }
    return `I have been experiencing ${baseEn.charAt(0).toLowerCase() + baseEn.slice(1)}, and I would like to consult a doctor.`;
  }

  // Japanese ('ja')
  const baseJa = normalizeColloquialJa(raw).replace(/[。．.!！?？、,\s]+$/, '');

  if (input.field === 'intent') {
    const slotSuffix =
      slots.length > 0 && !slots.some((slot) => baseJa.includes(slot))
        ? `。希望日時は${slots.map((slot, idx) => `第${idx + 1}希望が${slot}`).join('、')}です`
        : '';

    if (/初診予約したい|予約したい|予約を取りたい/.test(baseJa)) {
      const refined = baseJa
        .replace(/初診予約したい(?:です)?/g, '初診の予約をお願いしたくご連絡いたしました')
        .replace(/予約(?:を)?取りたい(?:です)?/g, '予約をお願いしたくご連絡いたしました')
        .replace(/予約したい(?:です)?/g, '予約をお願いしたくご連絡いたしました');
      return `${refined}${slotSuffix}`;
    }

    if (/予約をお願い|受診をお願い|相談をお願い/.test(baseJa)) {
      const refined = baseJa
        .replace(/お願いしたいです$/, 'お願いいたしたく存じます')
        .replace(/取りたいです$/, 'お願いしたいです');
      return `${refined}${slotSuffix}`;
    }

    const deptPhrase = dept && !baseJa.includes(dept) ? `${dept}での` : '';
    const clause = /(?:です|ます|あります|ございます)$/.test(baseJa)
      ? `${baseJa}。そのため、${deptPhrase}初診の予約をお願いしたくご連絡いたしました`
      : `${baseJa}の症状があるため、${deptPhrase}初診の予約をお願いしたくご連絡いたしました`;
    return `${clause}${slotSuffix}`;
  }

  if (input.field === 'consult_memo') {
    if (/お願いいたし|お願いします/.test(baseJa)) {
      return `${baseJa}。`;
    }
    if (/(?:です|ます|あります|ございます)$/.test(baseJa)) {
      return `${baseJa.replace(/あります$/, 'ございます')}。本日は診察をお願いいたします。`;
    }
    return `${baseJa}の症状がございます。本日は診察をお願いいたします。`;
  }

  // symptoms (Step 1)
  if (/受診|診察|予約|相談|希望/.test(baseJa)) {
    const refined = baseJa
      .replace(/取りたいです$/, '希望しております')
      .replace(/相談したいです$/, 'ご相談を希望しております');
    return `${refined}。`;
  }

  if (/(?:です|ます|あります|ございます)$/.test(baseJa)) {
    return `${baseJa}。受診のご相談を希望しております。`;
  }
  return `${baseJa}の症状があり、受診を希望しております。`;
}

/**
 * `/api/polish-draft` を呼び出し、通信エラーやオフライン時は即座にローカル医療表現整形へフォールバックする。
 */
export async function requestDraftPolish(input: DraftPolishInput): Promise<{
  polishedText: string;
  aiSource: 'gemini' | 'fallback';
}> {
  const trimmed = input.text.trim();
  if (!trimmed) {
    return { polishedText: '', aiSource: 'fallback' };
  }
  try {
    const res = await fetch('/api/polish-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error('polish_draft_failed');
    const data = (await res.json()) as {
      polishedText?: string;
      ai?: { source?: 'gemini' | 'fallback' };
    };
    const resolved = data.polishedText?.trim();
    if (!resolved) throw new Error('empty_polished_text');
    return {
      polishedText: resolved,
      aiSource: data.ai?.source === 'gemini' ? 'gemini' : 'fallback',
    };
  } catch {
    return {
      polishedText: polishDraftLocally(input),
      aiSource: 'fallback',
    };
  }
}
