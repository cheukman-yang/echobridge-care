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

export async function generateSuggestionsWithGemini(hospitalTranscript: string): Promise<SuggestionResponse> {
  const text = hospitalTranscript.trim();

  // 1. ルールベースの即時フォールバック（最新の制度に合わせた候補定義）
  let fallback: SuggestionResponse = {
    suggestions: [
      { text: 'はい、承知いたしました。', tag: '了解' },
      { text: '別の日時でお願いできますでしょうか？', tag: '別日程' },
      { text: '他に持参するものはございますでしょうか？', tag: '持ち物確認' }
    ]
  };

  if (text.includes('マイナンバー') || text.includes('資格確認書') || text.includes('保険証')) {
    fallback = {
      suggestions: [
        { text: '承知いたしました。マイナンバーカードを持参いたします。', tag: 'マイナ持参' },
        { text: '資格確認書の方を持参いたします。', tag: '資格確認書持参' },
        { text: 'お薬手帳や紹介状なども持参した方がよろしいでしょうか？', tag: '持ち物確認' }
      ]
    };
  } else if (text.includes('いつ') || text.includes('都合') || text.includes('何時') || text.includes('予約')) {
    fallback = {
      suggestions: [
        { text: '明日の午前中を希望いたします。', tag: '明日午前' },
        { text: '明日の午後で空いている時間はございますか？', tag: '明日午後' },
        { text: '一番早い日時でお願いできますでしょうか？', tag: '最短希望' }
      ]
    };
  } else if (text.includes('初診') || text.includes('受診')) {
    fallback = {
      suggestions: [
        { text: 'はい、初診です。予約をお願いできますでしょうか？', tag: '初診予約' },
        { text: '以前かかったことがあります。', tag: '再診' },
        { text: '受付時間を教えていただけますでしょうか？', tag: '時間確認' }
      ]
    };
  }

  if (!genAI) {
    return fallback;
  }

  // 2. Gemini による動的生成（プロンプトでも現行制度を指示）
  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });

    const prompt = `あなたは聴覚・発話困難者のための電話代行アシスタントです。
病院受付の発言内容を聞き、患者がワンタップで即座に返信・発話できる「自然で礼儀正しい返答選択肢3つ」を生成してください。

【制約事項】
- 現行の医療保険制度に基づき、「従来の健康保険証」を持参するような提案は一切出さないでください。保険確認に関する候補は「マイナンバーカード」または「健康保険資格確認書」を使用してください。
- 1つ目は「承諾・肯定」、2つ目は「別の日時や代替案の提示」、3つ目は「持ち物（お薬手帳等）や質問・確認」など、状況に応じた使い分けができるバリエーションにしてください。

病院受付の発言:
"${text}"

出力スキーマ:
{
  "suggestions": [
    { "text": "患者が返答する丁寧な敬語1文", "tag": "簡潔なタグ(3〜6文字)" },
    { "text": "患者が返答する丁寧な敬語1文", "tag": "簡潔なタグ(3〜6文字)" },
    { "text": "患者が返答する丁寧な敬語1文", "tag": "簡潔なタグ(3〜6文字)" }
  ]
}`;

    const res = await model.generateContent(prompt);
    const parsed = JSON.parse(res.response.text().trim());
    if (parsed.suggestions && parsed.suggestions.length >= 3) {
      return parsed;
    }
  } catch (err) {
    console.error('[Gemini Suggestions Error]', err);
  }

  return fallback;
}