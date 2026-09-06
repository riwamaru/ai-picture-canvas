import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resyncPendingImages } from "@/lib/driveSync";

/**
 * Drive 未同期の画像をまとめて送り直すバッチ（仕様書 4.7.2 の 4 行目）。
 *
 * Vercel Cron から 1 日 1 回叩かれる（vercel.json）。手動でも叩ける。
 *
 * ★ 認証は CRON_SECRET で行う。
 *   Vercel Cron は Authorization: Bearer <CRON_SECRET> を付けて呼ぶ。
 *   未設定のときは「誰でも叩ける状態」なので、動かさずに 503 を返す。
 *   ここを素通しにすると、外部から何度でも Drive API を叩かせられる。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        message:
          "CRON_SECRET が未設定です。誰でも叩ける状態で動かすわけにいかないため、実行しませんでした。",
      },
      { status: 503 },
    );
  }

  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, message: "権限がありません。" }, { status: 401 });
  }

  const admin = createAdminClient();
  const report = await resyncPendingImages(admin, 20);

  return NextResponse.json({ ok: true, ...report });
}
