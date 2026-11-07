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
| `ALLOWED_ORIGINS` | 同一オリジンのほかに接続を許可するオリジン（カンマ区切り） | 開発時は `http://localhost:3000` と `http://127.0.0.1:3000`、`NODE_ENV=production` ではなし |
| `NEXT_PUBLIC_WS_URL` | 通話サーバーの接続先。ビルド時に埋め込まれる。別サービスに分けるときだけ指定する | 同一オリジン（開発時は同じホストの8080番） |

Vertex AIの指定があれば、`GEMINI_API_KEY` は使いません。

## 通話への参加

1. 患者の画面（`/`）で用件を入力して発信すると、招待リンクと通話コードが表示されます。
2. 病院役はリンクを開くか、`/hospital` でコードを入力します。
3. 病院役が応答すると通話が始まります。

招待は10分間有効で、応答すると使えなくなります。切断や再読み込みの後は、タブに保存した席のトークンで同じ通話へ戻ります。同じPCでタブを分ければ、別の利用者として試せます。

## 通話の状態と Cloud Run

通話の状態はサーバーのメモリにだけ置き、データベースには保存しません。通話の終了後は10分で消えます。Cloud Run では次の設定が必要です。

| 設定 | 値 | 理由 |
|---|---|---|
| `--max-instances` | `1` | 通話の状態をインスタンス間で共有していないため |
| `--timeout` | `3600` | 既定の5分でWebSocketが切れるため。切れても自動で再接続します |
| `--concurrency` | `200` | WebSocket 1本が同時リクエスト1件に数えられるため |

`--max-instances=1` は上限を一時的に超える場合があり、インスタンスが停止することもあります。そのときの通話は続けられず、「通話が見つかりません」と表示されます。複数インスタンスで動かすには、Memorystore for Redis の Pub/Sub や Firestore で状態を共有する必要があります。

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
