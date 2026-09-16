import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 生成画像のダウンロード。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【なぜサーバーを経由するのか】
 *
 * 以前は署名付き URL を <a download> に入れてクリックさせていた。
 * これは **動かない**。download 属性はクロスオリジンの URL では無視される仕様で、
 * 署名付き URL は Supabase（別オリジン）を指すため、
 * ブラウザはダウンロードせず **その URL へ遷移する**。
 * 画面いっぱいに画像が表示され、アプリへ戻れなくなる（実際にそうなった）。
 *
 * 同一オリジンのこのルートが Content-Disposition: attachment を付けて返せば、
 * iOS Safari を含めて確実にダウンロードになる。
 *
 * ★ 画像そのものは非公開のまま。ここは認証を通り、
 *   さらに「そのジョブが自分のものか」を RLS で確認してから返す。
 * ═══════════════════════════════════════════════════════════════
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 日本語を含むファイル名を Content-Disposition に載せる（RFC 5987）。 */
function contentDisposition(filename: string): string {
  // 古い実装向けの ASCII 版と、UTF-8 版を併記する
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * 何をダウンロードするか。
 *   ?slot=N     … ドラフト候補 N
 *   ?step=<id>  … 個別修正の結果（F-05）
 *   ?final=1    … 確定画像（2K）
 */
type Target = { kind: "slot"; slot: number } | { kind: "step"; stepId: string } | { kind: "final" };

function parseTarget(url: string): Target | null {
  const params = new URL(url).searchParams;
  if (params.get("final") === "1") return { kind: "final" };
  const step = params.get("step");
  if (step) return /^[0-9a-f-]{36}$/i.test(step) ? { kind: "step", stepId: step } : null;
  const slot = Number(params.get("slot"));
  return Number.isInteger(slot) && slot >= 0 ? { kind: "slot", slot } : null;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const target = parseTarget(request.url);
  if (!target) {
    return NextResponse.json({ ok: false, message: "対象の指定が不正です。" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, message: "ログインしてください。" }, { status: 401 });
  }

  // ★ RLS 下のクライアントで読む。他人のジョブなら行が返らない。
  const { data: job } = await supabase
    .from("jobs")
    .select("id, session_title, store_name, cast_name")
    .eq("id", id)
    .maybeSingle();
  if (!job) {
    return NextResponse.json({ ok: false, message: "見つかりません。" }, { status: 404 });
  }

  // ── 対象の行を RLS 下で読む（他人のものなら返らない） ──
  let resultPath: string | null = null;
  let suffix = "";

  if (target.kind === "slot") {
    const { data: image } = await supabase
      .from("job_images")
      .select("result_path, status")
      .eq("job_id", id)
      .eq("slot", target.slot)
      .maybeSingle();
    if (image?.status === "succeeded") resultPath = image.result_path;
    suffix = `候補${target.slot + 1}`;
  } else if (target.kind === "step") {
    const { data: step } = await supabase
      .from("edit_steps")
      .select("result_path, status, step_no")
      .eq("job_id", id)
      .eq("id", target.stepId)
      .maybeSingle();
    if (step?.status === "succeeded") resultPath = step.result_path;
    suffix = `修正${step?.step_no ?? ""}`;
  } else {
    const { data: final } = await supabase
      .from("final_images")
      .select("result_path, status, resolution")
      .eq("job_id", id)
      .maybeSingle();
    if (final?.status === "succeeded") resultPath = final.result_path;
    suffix = `確定${String(final?.resolution ?? "").toUpperCase()}`;
  }

  if (!resultPath) {
    return NextResponse.json(
      { ok: false, message: "ダウンロードできる画像がありません。" },
      { status: 404 },
    );
  }

  const admin = createAdminClient();
  const { data: file, error } = await admin.storage.from("results").download(resultPath);
  if (error || !file) {
    return NextResponse.json(
      { ok: false, message: `画像を取得できませんでした: ${error?.message ?? "不明"}` },
      { status: 502 },
    );
  }

  const base =
    job.session_title?.trim() ||
    [job.store_name, job.cast_name].filter(Boolean).join("_") ||
    "ai-canvas";
  const filename = `${base}_${suffix}.png`.replace(/[\/\\:*?"<>|]/g, "_");

  return new NextResponse(await file.arrayBuffer(), {
    headers: {
      "content-type": "image/png",
      "content-disposition": contentDisposition(filename),
      "cache-control": "no-store",
    },
  });
}
