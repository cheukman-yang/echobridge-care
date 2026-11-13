import type { AiMeta } from './aiMeta';
import type { SuggestionItem } from './callProtocol';
import type { UserLanguage } from './userLanguage';

/** 対面診察モードの画面パス。 */
export const CONSULT_PATH = '/consult';

/** 候補として表示する医療機関の情報。 */
export interface ClinicCandidate {
  id: string;
  name: string;
  nameEn?: string;
  /** 審査・検証用の模擬クリニック（外部発信せずブラウザ内AI受付ボットと通話する）。 */
  isSandbox: boolean;
  departments: string[];
  departmentsEn?: string[];
  address: string;
  addressEn?: string;
  /** Google Maps の経路案内・周辺地図検索の両方に共通で渡す実在の基準住所または駅ランドマーク。 */
  mapQuery?: string;
  hours: string;
  distanceNote: string;
  distanceNoteEn?: string;
  features: string[];
  matchReason?: string;
  matchReasonEn?: string;
}

/**
 * 審査員が実在の病院へ誤発信せず安全にテストできるよう、常に最上部にピン留めする模擬クリニック。
 */
export const SANDBOX_CLINIC: ClinicCandidate = {
  id: 'echobridge-care-sandbox-clinic',
  name: '[審査・検証用] EchoBridge Care 模擬クリニック',
  nameEn: '[For Review/Testing] EchoBridge Care Mock Clinic',
  isSandbox: true,
  departments: ['総合内科', '耳鼻咽喉科', '多言語外来（AI模擬受付）'],
  departmentsEn: ['Internal Medicine', 'ENT', 'Multilingual AI Reception'],
  address: '東京都千代田区丸の内1-9-1 丸の内メディカルプラザ 3階',
  addressEn: 'Marunouchi Medical Plaza 3F, 1-9-1 Marunouchi, Chiyoda-ku, Tokyo',
  mapQuery: '東京都千代田区丸の内1-9-1',
  hours: '9:00〜18:00（ブラウザ内AI模擬受付ボット常時応答）',
  distanceNote: '東京駅丸の内北口 徒歩2分（架空の検証用施設）',
  distanceNoteEn: '2 min walk from Tokyo Sta. North Exit (Fictional sandbox clinic)',
  features: ['常時ピン留め', '外部発信なし・安全テスト', '日本語音声合成TTS', '日英リアルタイム医療翻訳'],
  matchReason: '実在の病院へ電話を発信せず、ブラウザ内でGemini AI模擬受付ボットと予約通話を安全に検証できます。',
  matchReasonEn:
    'Safely test an appointment call in your browser with our Gemini AI receptionist — no real phone call is placed.',
};

/** Geminiによる症状整理と近隣クリニック推薦の結果。 */
export interface ClinicSearchResult {
  organizedSymptoms: string;
  organizedSymptomsEn?: string;
  recommendedDepartments: string[];
  urgencyNote: string;
  urgencyNoteEn?: string;
  suggestedIntent: string;
  clinics: ClinicCandidate[];
  ai: AiMeta;
}

/** 模擬クリニック通話の1発言。 */
export interface SandboxTurn {
  id: string;
  sender: 'patient' | 'receptionist';
  /** 受付・患者の間で読み上げられる日本語の文。 */
  textJa: string;
  /** 英語話者向けの英語訳または原文。 */
  textEn?: string;
  origin?: 'greeting' | 'suggestion' | 'polished' | 'typed' | 'quick_phrase';
}

/** Gemini AI模擬受付ボットの応答。 */
export interface SandboxReceptionResponse {
  receptionistJa: string;
  receptionistEn: string;
  suggestions: SuggestionItem[];
  isReservationConfirmed: boolean;
  ai: AiMeta;
}

/** 対面診察モードの対話の1行。 */
export interface ConsultationTurn {
  id: string;
  speaker: 'doctor' | 'patient';
  /** 医師側に正立表示（180度回転エリア）または医師の発話文字起こしとなる日本語医療表現。 */
  japaneseText: string;
  /** English選択時に併記する英語訳、または英語話者の入力文。 */
  englishText?: string;
  /** 整形・翻訳前の元テキスト（必要な場合のみ保持）。 */
  rawInput?: string;
  timestamp: string;
}

/** 診察終了後に抽出する次回受診（再診）情報。 */
export interface FollowUpExtraction {
  /** 会話から抽出した再診時期の表現（例: 「2週間後に再受診」）。言及がなければ null。 */
  spokenText: string | null;
  /** 自動算出した推奨受診日（YYYY-MM-DD、Asia/Tokyo基準）。 */
  recommendedDate: string | null;
  /** 会話内で明示された開始時刻（HH:mm）。時刻の言及がない場合は空文字 ""（終日予定として登録可能）。 */
  recommendedStartTime: string;
  /** カレンダー予定タイトル。 */
  title: string;
  /** カレンダー詳細欄に入れる引き継ぎメモ。 */
  details: string;
}

/** 診察終了後のGemini構造化要約。 */
export interface ConsultationSummary {
  chiefComplaint: string;
  chiefComplaintEn?: string;
  diagnosticPoints: string[];
  diagnosticPointsEn?: string[];
  prescriptionsAndInstructions: string[];
  prescriptionsAndInstructionsEn?: string[];
  followUp: FollowUpExtraction;
  ai: AiMeta;
}

/** 電話予約ウィザード Step 1 で選べる希望診療科チップ。 */
export type DepartmentChoice = 'ai_auto' | 'internal' | 'ent' | 'dermatology' | 'pediatrics';

/** 対面診察モードにおける医師側の使用言語。 */
export type DoctorLanguage = 'ja' | 'en';

/**
 * 対面診察モードの対話言語ペア。
 * - ja_ja: 🇯🇵 患者: 日本語 ⇄ 医師: 日本語（国内・発話/聴覚サポート）
 * - en_ja: 🇺🇸 患者: English ⇄ 医師: 日本語（国内の外国人患者サポート）
 * - ja_en: ✈️ 患者: 日本語 ⇄ 医師: English（海外滞在中の日本人患者が英語圏の病院を受診するモード）
 */
export type ConsultLanguagePair = 'ja_ja' | 'en_ja' | 'ja_en';

/** ブラウザの localStorage にのみ保存する診察記録（クラウド非保存）。 */
export interface SavedConsultationRecord {
  id: string;
  createdAt: string;
  clinicName: string;
  clinicAddress?: string;
  userLanguage: UserLanguage;
  doctorLanguage?: DoctorLanguage;
  turns: ConsultationTurn[];
  summary: ConsultationSummary;
}

/**
 * 電話予約ウィザード完了時（Step 4）に localStorage へ自動保存し、
 * 来院後の対面診察モード（/consult Step 1）へワンタップで引き継ぐ予約記録。
 */
export interface SavedReservationRecord {
  id: string;
  createdAt: string;
  clinicName: string;
  clinicNameEn?: string;
  address?: string;
  originLocation?: string;
  date: string | null;
  startTime: string | null;
  symptomsMemo: string;
  preferredSlots?: string[];
  departmentLabel?: string;
  turns?: SandboxTurn[];
  userLanguage: UserLanguage;
}
