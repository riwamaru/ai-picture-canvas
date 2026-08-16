import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Canvas 体験版",
  description: "任意の写真で画像編集を試せる招待制の体験環境",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
