import { NextRequest, NextResponse } from 'next/server';

const ACTIVE_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
];

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();
    if (!text || typeof text !== 'string') {
      return NextResponse.json({ polishedText: text || '' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn('[Polish API] GEMINI_API_KEY is not set');
      return NextResponse.json({ polishedText: text });
    }

    const prompt = `あなたは病院・クリニックへの電話予約を支援するAIアシスタントです。
以下の患者からのラフな入力文を、電話口の受付スタッフに対して話すのに最も適した「丁寧で礼儀正しい敬語の発話文」に1文で変換（ブラッシュアップ）してください。

【ルール】
- 余計な解説、挨拶文、引用符などは一切含めず、変換後の発話文のみを出力してください。
- 意図（日時希望、症状の伝達、質問など）を一切損なわず、電話予約のマナーに即した自然な敬語にしてください。
- 長すぎず、1〜2文程度の簡潔な発話にしてください。

入力文: "${text}"
変換後の発話文:`;

    for (const model of ACTIVE_MODELS) {
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 100,
            },
          }),
        });

        if (!res.ok) continue;

        const data = await res.json();
        const output = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (output) {
          // 余分な引用符や改行を除去
          const cleanOutput = output.replace(/^["「』]+|["」』]+$/g, '').trim();
          return NextResponse.json({ polishedText: cleanOutput });
        }
      } catch (err) {
        console.error(`[Polish API] Error with ${model}:`, err);
        continue;
      }
    }

    // フォールバック: そのまま返す
    return NextResponse.json({ polishedText: text });
  } catch (error) {
    console.error('[Polish API] Internal error:', error);
    return NextResponse.json({ polishedText: text });
  }
}