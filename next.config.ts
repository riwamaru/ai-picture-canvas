import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // sharp をサーバー側でそのまま使う（バンドルせず Node の require に任せる）。
  serverExternalPackages: ["sharp"],

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // 生成画像・元画像は署名付き URL で配るが、
          // 画面自体が第三者サイトへ埋め込まれる経路も塞いでおく。
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          // 検索エンジンに拾わせない（招待制の体験環境であるため）。
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
