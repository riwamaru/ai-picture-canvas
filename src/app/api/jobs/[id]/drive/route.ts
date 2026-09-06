import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncImageToDrive } from "@/lib/driveSync";

/**
 * 選んだ 1 枚を Google Drive の共有ドライブへ保存する（仕様書 F-06 / 4.7）。
 *
 * ★ 保存に失敗しても 200 を返す。
 *   仕様書 4.7.2 の 4 行目「ユーザーには保存済みとして扱い、UI をブロックしない」に沿う。
 *   画像は Supabase Storage に残っており、失われていない。
 *   本文の ok / status で結果を伝え、画面は「未同期」と出すだけにする。
 *   ここで 5xx を返すと、UI 側が例外処理へ落ちて操作が止まってしまう。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Drive へのアップロードは数秒かかる。既定の 10 秒では足りないことがある。
export const maxDuration = 60;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const body = (await request.json().catch(() => null)) as { slot?: unknown } | null;
  const slot = Number(body?.slot);
  if (!Number.isInteger(slot) || slot < 0) {
    return NextResponse.json({ ok: false, message: "スロットの指定が不正です。" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, message: "ログインしてください。" }, { status: 401 });
  }

  // ★ 持ち主の確認は RLS 下のクライアントで行う。
  //   このあと使う service_role は RLS を迂回するので、
  //   ここを飛ばすと他人のジョブの画像を Drive へ出せてしまう。
  const { data: job } = await supabase.from("jobs").select("id").eq("id", id).maybeSingle();
  if (!job) {
    return NextResponse.json({ ok: false, message: "見つかりません。" }, { status: 404 });
  }

  const admin = createAdminClient();
  const outcome = await syncImageToDrive(admin, { jobId: id, slot });

  if (outcome.ok) {
    return NextResponse.json({
      ok: true,
      status: outcome.status,
      viewUrl: outcome.viewUrl,
      fileId: outcome.fileId,
      folderPath: outcome.folderPath,
      message:
        outcome.status === "already"
          ? `この候補は既に Drive へ保存済みです（${outcome.folderPath}）。`
          : `Drive へ保存しました（${outcome.folderPath}）。`,
    });
  }

  return NextResponse.json({
    ok: false,
    status: outcome.status,
    retryable: outcome.retryable,
    message: outcome.message,
  });
}
