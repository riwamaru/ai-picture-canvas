import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/auth";
import { DriveError, diagnoseDrive, inspectRootFolder } from "@/lib/drive";
import { listOrphanFolders, resyncPendingImages } from "@/lib/driveSync";

/**
 * Drive 連携の状態確認と、手動での再送・接続テスト。ADMIN_EMAILS の人だけ。
 *
 * 仕様書 4.7.2 が管理画面に求めているもの：
 *   - 孤児フォルダの一覧（Drive にはあるが台帳が知らないもの）
 *   - 未同期の一覧と、手動での再送
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;


export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ ok: false, message: "権限がありません。" }, { status: 403 });
  }

  const admin = createAdminClient();

  const [{ data: pending }, { data: folders }, orphans] = await Promise.all([
    admin
      .from("final_images")
      .select("job_id, source_slot, drive_status, drive_attempts, drive_error, drive_last_attempt_at")
      .eq("drive_status", "failed")
      .order("drive_last_attempt_at", { ascending: false })
      .limit(20),
    admin
      .from("drive_folders")
      .select("folder_name, store_name, folder_id, recreate_count, recreated_at, created_at")
      .order("created_at", { ascending: false })
      .limit(20),
    listOrphanFolders(admin, 20),
  ]);

  const { count: syncedCount } = await admin
    .from("final_images")
    .select("id", { count: "exact", head: true })
    .eq("drive_status", "synced");

  return NextResponse.json({
    ok: true,
    // 鍵は返さない。返すのは「設定できているか」と、共有ドライブへ招待する相手のアドレスだけ。
    diagnosis: await diagnoseDrive(),
    syncedCount: syncedCount ?? 0,
    pending: pending ?? [],
    folders: folders ?? [],
    orphans,
  });
}

export async function POST(request: Request) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ ok: false, message: "権限がありません。" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  const action = body?.action;

  if (action === "test") {
    // ★ 保存を試す前に「共有ドライブの中か」を確かめる。
    //   マイドライブのフォルダ ID を設定していると、保存時に
    //   storageQuotaExceeded（容量不足）という紛らわしいエラーになる。
    try {
      const result = await inspectRootFolder();
      return NextResponse.json({ ok: result.ok, message: result.message, detail: result });
    } catch (error) {
      const message =
        error instanceof DriveError ? error.message : `確認できませんでした: ${String(error)}`;
      return NextResponse.json({ ok: false, message });
    }
  }

  if (action === "resync") {
    const admin = createAdminClient();
    const report = await resyncPendingImages(admin, 20);
    return NextResponse.json({
      ok: true,
      message:
        report.picked === 0
          ? "未同期の画像はありません。"
          : `${report.picked} 件を試し、${report.synced} 件を送信しました` +
            `（失敗 ${report.stillFailed} 件・再試行回数の上限に達したもの ${report.skippedExhausted} 件）。`,
      report,
    });
  }

  return NextResponse.json({ ok: false, message: "不明な操作です。" }, { status: 400 });
}
