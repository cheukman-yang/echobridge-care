This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## 環境変数

`server/` が読む環境変数です。値を入れた `.env` はコミットしないでください。

| 変数 | 用途 | 既定値 |
|---|---|---|
| `GOOGLE_GENAI_USE_VERTEXAI` | `true` でVertex AIを使う（本番の想定）。認証はサービスアカウントかADC | なし |
| `GOOGLE_CLOUD_PROJECT` | Vertex AIのプロジェクトID | なし |
| `GOOGLE_CLOUD_LOCATION` | Vertex AIのロケーション | `global` |
| `GEMINI_API_KEY` | ローカル検証用のGemini Developer APIキー。架空のデータだけで使う | なし |
| `GEMINI_MODEL` | 使うモデル。変えるときは公式の退役日を確認する | `gemini-3.5-flash-lite` |
| `GEMINI_TIMEOUT_MS` | 返答候補と文の整形を待つ上限（ミリ秒） | `8000` |
| `GEMINI_EXTRACTION_TIMEOUT_MS` | 通話後の予定の読み取りを待つ上限（ミリ秒） | `20000` |
| `PORT` | WebSocketサーバーのポート | `8080` |

Vertex AIの指定があれば、`GEMINI_API_KEY` は使いません。

## テスト

```bash
npm test
```

```bash
npm run test:live
```

`npm test` は認証なしで動きます。`npm run test:live` は実際のGeminiを呼ぶので、上の環境変数と課金が必要です。認証がないと失敗します。

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
