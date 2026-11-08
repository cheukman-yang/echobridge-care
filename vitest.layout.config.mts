import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

/**
 * 画面の並べ方（高さ・幅・フォーカス）を実際のブラウザで確かめるテスト。jsdom は配置を計算しないので分けている。
 *   npm run test:layout
 * ブラウザはダウンロードせず、端末に入っている Chrome を使う。Edge を使うときは LAYOUT_TEST_BROWSER=msedge。
 */
export default defineConfig({
  plugins: [tailwindcss()],
  // Next.js がビルド時に埋め込む環境変数。テストでは接続先を偽物の WebSocket にするので、空で足りる。
  define: {
    'process.env.NEXT_PUBLIC_WS_URL': 'undefined',
    'process.env.NODE_ENV': JSON.stringify('test'),
  },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: ['tests/layout/**/*.test.{ts,tsx}'],
    // 失敗時の画面の写しは、Gitの管理外（node_modules）に置く。
    attachmentsDir: 'node_modules/.vitest/attachments',
    browser: {
      enabled: true,
      headless: true,
      screenshotDirectory: 'node_modules/.vitest/screenshots',
      provider: playwright({ launchOptions: { channel: process.env.LAYOUT_TEST_BROWSER ?? 'chrome' } }),
      instances: [{ browser: 'chromium' }],
    },
  },
});
