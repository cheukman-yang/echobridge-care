import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 相手の画面は /join に移した。配ったリンクを壊さないよう旧パスを転送する。
  // 招待コードはURLのフラグメントにあり、ブラウザは転送先にもそのまま引き継ぐ。
  redirects() {
    return [{ source: "/hospital", destination: "/join", permanent: false }];
  },
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
