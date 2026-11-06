import { GoogleGenerativeAI } from '@google/generative-ai';

const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

export interface SuggestionItem {
  text: string;
  tag: string;
}

export interface SuggestionResponse {
  suggestions: SuggestionItem[];
}

// 病院受付の発話内容に応じたインテリジェント・フォールバック候補
function getContextualFallback(text: string): SuggestionItem[] {
  const t = text.toLowerCase();

  // 1. マイナンバーカードに関する発言
  if (t.includes('マイナンバー') || t.includes('マイナン') || t.includes('マイナ')) {
    return [
      { text: '承知いたしました。マイナンバーカードを持参いたします。', tag: '了解' },
      { text: 'マイナンバーカードの他に持参するものはありますか？', tag: '持ち物確認' },
      { text: '健康保険証も念のため持参した方がよろしいでしょうか？', tag: '保険証確認' }
    ];
  }

  // 2. 健康保険証に関する発言
  if (t.includes('保険証')) {
    return [
      { text: '承知いたしました。健康保険証を持参いたします。', tag: '了解' },
      { text: 'マイナンバーカードでも対応可能でしょうか？', tag: 'マイナ確認' },
      { text: '他に持参すべき書類や持ち物はございますか？', tag: '持ち物確認' }
    ];
  }

  // 3. 日程・時間に関する発言（「〜時」「〜日」「都合」「空い」など）
  if (t.includes('時') || t.includes('日') || t.includes('都合') || t.includes('いつ') || t.includes('空い')) {
    return [
      { text: 'はい、その時間でお願いいたします。', tag: '合意' },
      { text: '恐れ入ります、別の時間帯は空いていますでしょうか？', tag: '時間変更' },
      { text: '午前中の早い時間帯を希望したいです。', tag: '時間希望' }
    ];
  }

  // 4. 住所・場所・アクセスに関する発言
  if (t.includes('住所') || t.includes('場所') || t.includes('存知') || t.includes('道') || t.includes('駅')) {
    return [
      { text: 'はい、場所は把握しておりますので大丈夫です。', tag: '把握済' },
      { text: '念のため最寄り駅や目印を教えていただけますでしょうか？', tag: 'アクセス確認' },
      { text: '駐車スペースはございますでしょうか？', tag: '駐車場確認' }
    ];
  }

  // 5. 症状・科に関する発言
  if (t.includes('初診') || t.includes('熱') || t.includes('症状') || t.includes('痛') || t.includes('どうされ')) {
    return [
      { text: '初診で受診を希望しております。', tag: '初診希望' },
      { text: '発熱があり、診察をお願いしたいです。', tag: '症状伝達' },
      { text: '事前のWEB問診票などはありますでしょうか？', tag: '問診確認' }
    ];
  }

  // 6. 挨拶・締め（「お待ちしております」など）
  if (t.includes('お待ち') || t.includes('よろしく') || t.includes('失礼')) {
    return [
      { text: 'ありがとうございます。それでは伺います。', tag: '感謝' },
      { text: 'よろしくお願いいたします。失礼いたします。', tag: '通話終了' },
      { text: 'ご丁寧に対応いただきありがとうございました。', tag: 'お礼' }
    ];
  }

  // 7. デフォルト候補
  return [
    { text: 'はい、承知いたしました。よろしくお願いいたします。', tag: '了解' },
    { text: '恐れ入ります、もう一度お願いできますでしょうか？', tag: '聞き返し' },
    { text: '確認いたしました。問題ございません。', tag: '確認' }
  ];
}

export async function generateSuggestionsWithGemini(hospitalText: string): Promise<SuggestionResponse> {
  const fallback = { suggestions: getContextualFallback(hospitalText) };

  if (!genAI) {
    return fallback;
  }

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
      }
    });

    const prompt = `あなたは聴覚・発話困難者のための電話代行支援AIです。
病院受付からの以下の発言を聞いて、患者がワンタップで即答できる「自然で適切な返答候補」を3つ作成し、JSONで返してください。
相手が求めている持ち物や指示内容に正確に即した返答を作成してください。

病院側の発言: "${hospitalText}"

出力スキーマ:
{
  "suggestions": [
    { "text": "返答メッセージ1 (敬語)", "tag": "要約タグ (例: 了解, 確認)" },
    { "text": "返答メッセージ2 (敬語)", "tag": "要約タグ" },
    { "text": "返答メッセージ3 (敬語)", "tag": "要約タグ" }
  ]
}`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    const parsed = JSON.parse(responseText);

    if (parsed && Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) {
      return parsed;
    }
    return fallback;
  } catch (error) {
    console.warn('[Gemini Service] フォールバック候補を返します。');
    return fallback;
  }
}