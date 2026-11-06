import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';

const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const rawText = (body.text || '').trim();

    if (!rawText) {
      return NextResponse.json({ error: 'Text is required' }, { status: 400 });
    }

    const dict: { [key: string]: string } = {
      'わかった': '承知いたしました。',
      'わかりました': '承知いたしました。',
      '了解': '承知いたしました。',
      '了解です': '承知いたしました。',
      'ありがとう': 'ありがとうございます。',
      'ありがとうございます': 'ありがとうございます。',
      'ありがとうございました': 'ありがとうございました。失礼いたします。',
      '大丈夫': '問題ございません。大丈夫です。',
      '大丈夫です': '問題ございません。大丈夫です。',
      'ok': 'かしこまりました。そちらでお願いいたします。',
      'okです': 'かしこまりました。そちらでお願いいたします。',
      'おけ': 'かしこまりました。そちらでお願いいたします。',
      'はい': 'はい、よろしくお願いいたします。',
      'いいえ': 'いいえ、そちらは都合が合いません。'
    };

    const cleaned = rawText.replace(/[。、！？.!?]+$/, '');
    const lower = cleaned.toLowerCase();

    if (dict[lower] || dict[cleaned]) {
      return NextResponse.json({ polished: dict[lower] || dict[cleaned] });
    }

    if (genAI) {
      try {
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const prompt = `あなたは聴覚・発話困難者のための電話代行アシスタントです。
患者が手入力したメッセージを、病院の受付に伝えるための「最も自然で丁寧な電話口の敬語1文」に変換してください。
決して文末に「〜です。」を機械的に付けず、前後の文脈に即した美しい敬語1文にしてください。
前置きや解説は一切出力せず、変換後の文のみを出力してください。

患者の入力: "${cleaned}"`;

        const res = await model.generateContent(prompt);
        const polished = res.response.text().trim();
        if (polished) {
          return NextResponse.json({ polished });
        }
      } catch (geminiError) {
        console.error('[Gemini API Polish Error]', geminiError);
      }
    }

    const fallbackPolished = (
      cleaned.endsWith('か') || 
      cleaned.endsWith('ます') || 
      cleaned.endsWith('でした') || 
      cleaned.endsWith('ございます') || 
      cleaned.endsWith('です')
    ) ? `${cleaned}。` : `${cleaned}です。`;

    return NextResponse.json({ polished: fallbackPolished });
  } catch (error) {
    console.error('[Route Error]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}