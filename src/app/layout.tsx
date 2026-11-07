import type { Metadata, Viewport } from "next";
import { BIZ_UDPGothic } from "next/font/google";
import "./globals.css";

/**
 * モリサワのユニバーサルデザイン書体。字形が大きく、似た文字を見分けやすい。
 * 本人が文を確かめ、相手が字幕を読む画面なので、読みやすさを優先した。
 */
const udGothic = BIZ_UDPGothic({
  weight: ["400", "700"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-ud",
});

export const metadata: Metadata = {
  title: "EchoBridge",
  description: "発話が難しい人が、AIの支援で自分の言葉を伝えられるWeb通話",
};

export const viewport: Viewport = {
  themeColor: "#f3f5f5",
  // スマートフォンでキーボードが開いたら、下部の返答欄が隠れないよう画面を縮める。
  interactiveWidget: "resizes-content",
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className={`${udGothic.variable} h-full`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
