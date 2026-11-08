import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    // 実APIのテストは認証が必要なので npm run test:live、配置のテストは実ブラウザが要るので npm run test:layout で別に実行する。
    exclude: ['tests/live/**', 'tests/layout/**', 'node_modules/**'],
    restoreMocks: true,
  },
});
