import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { finalizeJob } from "@/lib/finalize";

/**
 * 確定処理（機能仕様書 v2.1 STEP 5）。
 *
 *   ① 選んだ 1 枚を高解像度で再生成する
 *   ② 共有ドライブへ保存する
 *   ③ 使用モデル・推定コスト・処理時間を記録する
 *
 * ★ 実費が発生する。reserve_generation を必ず通す（finalize.ts の中で通している）。
 *   ここを迂回する経路を作ってはならない。
 *
 * ★ Drive への保存だけが失敗した場合も 200 を返す。
 *   確定画像は Supabase Storage にあり、未同期として後から再送される
 *   （仕様書 4.7.2 の 4 行目「ユーザーには保存済みとして扱い、UI をブロックしない」）。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 2K の生成はドラフトより時間がかかる。フォールバックすると 2 回呼ぶ。
export const maxDuration = 300;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const body = (await request.json().catch(() => null)) as
    | { slot?: unknown; stepId?: unknown; replace?: unknown }
    | null;
  const slot = Number(body?.slot);
  if (!Number.isInteger(slot) || slot < 0) {
    return NextResponse.json({ ok: false, message: "スロットの指定が不正です。" }, { status: 400 });
  }
  // 個別修正を経てから確定する場合、最後の修正の ID（仕様書 STEP 4 → STEP 5）
  const stepId = typeof body?.stepId === "string" && body.stepId.length > 0 ? body.stepId : null;
  const replace = body?.replace === true;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, message: "ログインしてください。" }, { status: 401 });
  }

  // ★ 持ち主の確認は RLS 下のクライアントで行う。
  //   このあと使う service_role は RLS を迂回するので、
  //   ここを飛ばすと他人のジョブを確定させて課金できてしまう。
  const { data: job } = await supabase.from("jobs").select("id").eq("id", id).maybeSingle();
  if (!job) {
    return NextResponse.json({ ok: false, message: "見つかりません。" }, { status: 404 });
  }

  const admin = createAdminClient();
  const outcome = await finalizeJob(admin, {
    jobId: id,
    slot,
    stepId,
    replace,
    userId: user.id,
    email: user.email ?? user.id,
  });

  if (!outcome.ok) {
    // 上限は 429（画面が待ち時間を出せるように）、それ以外は 200 で理由を返す。
    const status = outcome.reason === "limit" ? 429 : 200;
    return NextResponse.json(
      {
        ok: false,
        reason: outcome.reason,
        message: outcome.message,
        retryAfterSeconds: outcome.retryAfterSeconds,
        errorKind: outcome.errorKind,
      },
      { status },
    );
  }

  const drive = outcome.drive;

  return NextResponse.json({
    ok: true,
    status: outcome.status,
    resolution: outcome.resolution,
    provider: outcome.provider,
    costUsd: outcome.costUsd,
    latencyMs: outcome.latencyMs,
    drive: drive
      ? {
          ok: drive.ok,
          status: drive.status,
          viewUrl: drive.ok ? drive.viewUrl : null,
          folderPath: drive.ok ? drive.folderPath : null,
          message: drive.ok ? null : drive.message,
        }
      : null,
    message: buildMessage(outcome.status, outcome.resolution, drive),
  });
}

function buildMessage(
  status: "created" | "already",
  resolution: string,
  drive: { ok: boolean; status: string; folderPath?: string; message?: string } | null,
): string {
  const head =
    status === "already"
      ? "この回はすでに確定済みです。"
      : `確定画像を ${resolution.toUpperCase()} で作成しました。`;

  if (!drive) {
    return `${head} Google Drive への保存は管理者設定でオフのため、Supabase 側にのみ保存しています。`;
  }
  if (drive.ok) {
    return `${head} Drive へ保存しました（${drive.folderPath}）。`;
  }
  return `${head} ただし Drive へは送れませんでした。画像は保存されています。${drive.message ?? ""}`;
}
