import type { SpeechVoice } from './callProtocol';
import { MAX_PATIENT_TEXT_LENGTH } from './callProtocol';
import type { ConsultLanguagePair, DepartmentChoice } from './careTypes';
import { MAX_CUSTOM_PHRASES } from './customPhrases';
import type { UserLanguage } from './userLanguage';

export interface CareExampleSet {
  clinicSymptoms: string;
  clinicArea: string;
  clinicOrigin: string;
  preferredSlots: [string, string, string];
  setupOpeningMessage: string;
  consultChiefComplaint: string;
  consultAllergyMemo: string;
  quickPhraseExamples: readonly string[];
}

export const DEPARTMENT_OPTIONS: readonly {
  id: DepartmentChoice;
  labelJa: string;
  labelEn: string;
}[] = [
  { id: 'internal', labelJa: '内科', labelEn: 'Internal Medicine' },
  { id: 'ent', labelJa: '耳鼻咽喉科', labelEn: 'ENT' },
  { id: 'dermatology', labelJa: '皮膚科', labelEn: 'Dermatology' },
  { id: 'pediatrics', labelJa: '小児科', labelEn: 'Pediatrics' },
  { id: 'ai_auto', labelJa: 'AIにおまかせ', labelEn: 'Let AI Decide' },
];

export const PREFERRED_SLOT_PRESETS: Record<UserLanguage, readonly string[]> = {
  ja: [
    '今日の午前（9:30〜12:00）',
    '今日の午後（14:00〜17:00）',
    '明日の午前（10:00〜12:00）',
    '明日の午後（14:00〜17:00）',
    '明後日の午前（10:00〜12:00）',
    '最短で空いている日時',
  ],
  en: [
    'Today AM (9:30–12:00)',
    'Today PM (14:00–17:00)',
    'Tomorrow AM (10:00–12:00)',
    'Tomorrow PM (14:00–17:00)',
    'Day after tomorrow AM',
    'Earliest available slot',
  ],
};

export const CARE_EXAMPLES: Record<UserLanguage, CareExampleSet> = {
  ja: {
    clinicSymptoms: '昨日の夜から38度の熱と喉の痛みがあります。今日受診できる内科を予約したいです。',
    clinicArea: '新宿駅周辺',
    clinicOrigin: '新宿駅',
    preferredSlots: [
      '今日の午後（14:00〜17:00）',
      '明日の午前（10:00〜12:00）',
      '明日の午後（14:00〜17:00）',
    ],
    setupOpeningMessage: '昨日の夜から38度の熱と喉の痛みがあり、本日受診できる内科の初診予約をお願いしたいです。',
    consultChiefComplaint: '昨日の夜から喉の痛みがあり、今朝は38.0度の熱がありました。',
    consultAllergyMemo: '服用中の薬：なし / アレルギー：特になし',
    quickPhraseExamples: [
      '発話に障害があるため、AIの音声でお話ししています。ゆっくりお話しいただけると助かります。',
      '聴覚に障害があるため、画面の文字で確認しています。一文ずつお話しいただけると助かります。',
      '初診のため、持参する持ち物と受付時間をもう一度教えていただけますでしょうか。',
    ],
  },
  en: {
    clinicSymptoms:
      'I have had a 38°C fever and sore throat since last night. I would like to book a first-time internal medicine appointment today.',
    clinicArea: 'Around Shinjuku Station',
    clinicOrigin: 'Shinjuku Station',
    preferredSlots: [
      'Today PM (14:00–17:00)',
      'Tomorrow AM (10:00–12:00)',
      'Tomorrow PM (14:00–17:00)',
    ],
    setupOpeningMessage:
      'I have had a 38°C fever and sore throat since last night, and would like to book a first-time internal medicine appointment today.',
    consultChiefComplaint: 'Sore throat and 38.0°C fever since last night.',
    consultAllergyMemo: 'Current medications: None / Allergies: None',
    quickPhraseExamples: [
      'I am using an AI voice assistant to communicate in Japanese. Thank you for speaking slowly and clearly.',
      'I am an English speaker using real-time medical translation. Please speak one short sentence at a time.',
      'Could you please confirm my appointment time and what items I should bring for my first visit?',
    ],
  },
};

export function getDepartmentLabel(choice: DepartmentChoice, lang: UserLanguage): string {
  const found = DEPARTMENT_OPTIONS.find((item) => item.id === choice) ?? DEPARTMENT_OPTIONS[4];
  return lang === 'en' ? found.labelEn : found.labelJa;
}

export function buildWizardOpeningMessage(input: {
  symptoms: string;
  department: DepartmentChoice;
  preferredSlots: readonly string[];
  suggestedIntent?: string;
  lang: UserLanguage;
}): string {
  const filledSlots = input.preferredSlots.map((s) => s.trim()).filter(Boolean);
  const deptOption = DEPARTMENT_OPTIONS.find((d) => d.id === input.department);

  if (input.lang === 'en') {
    const base =
      input.suggestedIntent?.trim() ||
      (input.symptoms.trim()
        ? `I would like to book a first-visit appointment (${
            input.department !== 'ai_auto' && deptOption ? deptOption.labelEn : 'general consultation'
          }): ${input.symptoms.trim().replace(/[.]+$/, '')}.`
        : CARE_EXAMPLES.en.setupOpeningMessage);
    if (filledSlots.length === 0) return base;
    const slotLabels = filledSlots.map((slot, idx) => `#${idx + 1} ${slot}`).join(', ');
    return `${base} Preferred times: ${slotLabels}.`;
  }

  const deptPrefix =
    input.department !== 'ai_auto' && deptOption ? `${deptOption.labelJa}の` : '';
  const baseJa =
    input.suggestedIntent?.trim() ||
    (input.symptoms.trim()
      ? `${input.symptoms.trim().replace(/[。．.]+$/, '')}のため、${deptPrefix}初診予約をお願いしたいです。`
      : CARE_EXAMPLES.ja.setupOpeningMessage);
  if (filledSlots.length === 0) return baseJa;
  const slotLabelsJa = filledSlots
    .map((slot, idx) => `第${idx + 1}希望：${slot}`)
    .join('、');
  return `${baseJa.replace(/[。．]+$/, '')}。希望日時は${slotLabelsJa}です。`;
}

export function getCustomPhraseErrorLabel(
  problem: 'empty' | 'too_long' | 'duplicate' | 'full',
  lang: UserLanguage,
): string {
  if (lang === 'en') {
    switch (problem) {
      case 'empty':
        return 'Please enter a phrase.';
      case 'too_long':
        return `Please keep it within ${MAX_PATIENT_TEXT_LENGTH} characters.`;
      case 'duplicate':
        return 'This phrase is already saved.';
      case 'full':
        return `You can save up to ${MAX_CUSTOM_PHRASES} phrases. Please delete unused ones first.`;
    }
  }
  switch (problem) {
    case 'empty':
      return '文を入力してください。';
    case 'too_long':
      return `${MAX_PATIENT_TEXT_LENGTH}文字以内にしてください。`;
    case 'duplicate':
      return '同じ文がすでに登録されています。';
    case 'full':
      return `登録できるのは${MAX_CUSTOM_PHRASES}件までです。使わない文を削除してください。`;
  }
}

export function getVoiceLabel(voice: SpeechVoice, lang: UserLanguage): string {
  if (lang === 'en') {
    return voice === 'female' ? 'Female Voice' : 'Male Voice';
  }
  return voice === 'female' ? '女性の声' : '男性の声';
}

export interface SandboxQuickPhraseItem {
  id: string;
  label: string;
  textJa: string;
  textEn?: string;
}

export const SANDBOX_QUICK_PHRASES: Record<UserLanguage, readonly SandboxQuickPhraseItem[]> = {
  ja: [
    {
      id: 'yes-please',
      label: 'はい、お願いします',
      textJa: 'はい、お願いいたします。',
    },
    {
      id: 'wait-moment',
      label: '少しお待ちください',
      textJa: '恐れ入りますが、少しお待ちいただけますでしょうか。',
    },
    {
      id: 'speak-slowly',
      label: 'もう一度ゆっくりお願いします',
      textJa: '恐れ入りますが、もう一度ゆっくりお話しいただけますでしょうか。',
    },
    {
      id: 'using-tts',
      label: 'テキスト読み上げで通話しています',
      textJa: 'テキスト読み上げの音声で通話しています。ゆっくりお話しいただけると助かります。',
    },
  ],
  en: [
    {
      id: 'yes-please',
      label: 'Yes, please',
      textJa: 'はい、お願いいたします。',
      textEn: 'Yes, please.',
    },
    {
      id: 'wait-moment',
      label: 'One moment, please',
      textJa: '恐れ入りますが、少しお待ちいただけますでしょうか。',
      textEn: 'One moment, please.',
    },
    {
      id: 'speak-slowly',
      label: 'Could you repeat that slowly?',
      textJa: '恐れ入りますが、もう一度ゆっくりお話しいただけますでしょうか。',
      textEn: 'Could you please repeat that slowly?',
    },
    {
      id: 'using-tts',
      label: 'Using text-to-speech voice',
      textJa: 'テキスト読み上げの音声で通話しています。ゆっくりお話しいただけると助かります。',
      textEn: 'I am using text-to-speech voice to communicate.',
    },
  ],
};

export interface ConsultQuickPhraseItem {
  id: string;
  label: string;
  japaneseText: string;
  englishText: string;
}

export const CONSULT_QUICK_PHRASES: Record<
  ConsultLanguagePair,
  readonly ConsultQuickPhraseItem[]
> = {
  ja_ja: [
    {
      id: 'yes',
      label: 'はい',
      japaneseText: 'はい、その通りです。',
      englishText: 'Yes, that is correct.',
    },
    {
      id: 'no',
      label: 'いいえ',
      japaneseText: 'いいえ、ありません。',
      englishText: 'No, I do not.',
    },
    {
      id: 'slowly',
      label: '少しゆっくり話してください',
      japaneseText: '恐れ入りますが、少しゆっくりお話しいただけますでしょうか。',
      englishText: 'Could you please speak a little more slowly?',
    },
    {
      id: 'allergy',
      label: '薬のアレルギーがあります',
      japaneseText: '薬のアレルギーがあります。薬品名を入力してお伝えします。',
      englishText: 'I have a medication allergy. Let me type the medication name for you.',
    },
  ],
  en_ja: [
    {
      id: 'yes',
      label: 'Yes',
      japaneseText: 'はい、その通りです。',
      englishText: 'Yes, that is correct.',
    },
    {
      id: 'no',
      label: 'No',
      japaneseText: 'いいえ、ありません。',
      englishText: 'No, I do not.',
    },
    {
      id: 'slowly',
      label: 'Please speak a little more slowly',
      japaneseText: '恐れ入りますが、少しゆっくりお話しいただけますでしょうか。',
      englishText: 'Could you please speak a little more slowly?',
    },
    {
      id: 'allergy',
      label: 'I have a medication allergy',
      japaneseText: '薬のアレルギーがあります。薬品名を入力してお伝えします。',
      englishText: 'I have a medication allergy. Let me type the medication name for you.',
    },
  ],
  ja_en: [
    {
      id: 'yes',
      label: 'はい',
      japaneseText: 'はい、その通りです。',
      englishText: 'Yes, that is correct.',
    },
    {
      id: 'no',
      label: 'いいえ',
      japaneseText: 'いいえ、ありません。',
      englishText: 'No, I do not.',
    },
    {
      id: 'slowly',
      label: '少しゆっくり話してください',
      japaneseText: '恐れ入りますが、少しゆっくりお話しいただけますでしょうか。',
      englishText: 'Could you please speak a little more slowly?',
    },
    {
      id: 'allergy',
      label: '薬のアレルギーがあります',
      japaneseText: '薬のアレルギーがあります。薬品名を入力してお伝えします。',
      englishText: 'I have a medication allergy. Let me type the medication name for you.',
    },
  ],
};

export interface ConsultLanguagePairOption {
  id: ConsultLanguagePair;
  labelJa: string;
  labelEn: string;
  descJa: string;
  descEn: string;
}

export const CONSULT_LANGUAGE_PAIR_OPTIONS: readonly ConsultLanguagePairOption[] = [
  {
    id: 'ja_ja',
    labelJa: '🇯🇵 患者: 日本語 ⇄ 医師: 日本語',
    labelEn: '🇯🇵 Patient: Japanese ⇄ Doctor: Japanese',
    descJa: '国内・発話／聴覚／筆談サポート',
    descEn: 'Domestic Japan · Speech / hearing support in Japanese',
  },
  {
    id: 'en_ja',
    labelJa: '🇺🇸 患者: English ⇄ 医師: 日本語',
    labelEn: '🇺🇸 Patient: English ⇄ Doctor: Japanese',
    descJa: '国内の外国人患者サポート（日英双方向通訳）',
    descEn: 'International patients visiting a Japanese clinic',
  },
  {
    id: 'ja_en',
    labelJa: '✈️ 患者: 日本語 ⇄ 医師: English',
    labelEn: '✈️ Patient: Japanese ⇄ Doctor: English',
    descJa: '海外滞在中の日本人患者が英語圏の病院を受診するモード',
    descEn: 'Japanese traveler/resident visiting an English-speaking clinic abroad',
  },
];
