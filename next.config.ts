import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 相手の画面は /join に移した。配ったリンクを壊さないよう旧パスを転送する。
  // 招待コードはURLのフラグメントにあり、ブラウザは転送先にもそのまま引き継ぐ。
  redirects() {
    return [{ source: "/hospital", destination: "/join", permanent: false }];
  },
  // 開発サーバーを同じLANの別の端末から開くときのホスト名（scripts/dev.mjs が設定する）。本番の動作は変わらない。
  allowedDevOrigins: process.env.EB_ALLOWED_DEV_ORIGINS?.split(",")
    .map((host) => host.trim())
    .filter(Boolean),
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
