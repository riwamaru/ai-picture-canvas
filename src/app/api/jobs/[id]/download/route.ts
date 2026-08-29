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

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const slot = Number(new URL(request.url).searchParams.get("slot"));

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

  // ★ RLS 下のクライアントで読む。他人のジョブなら行が返らない。
  const { data: job } = await supabase
    .from("jobs")
    .select("id, session_title, store_name, cast_name")
    .eq("id", id)
    .maybeSingle();
  if (!job) {
    return NextResponse.json({ ok: false, message: "見つかりません。" }, { status: 404 });
  }

  const { data: image } = await supabase
    .from("job_images")
    .select("result_path, makeup_strength, variant, status")
    .eq("job_id", id)
    .eq("slot", slot)
    .maybeSingle();

  if (!image?.result_path || image.status !== "succeeded") {
    return NextResponse.json(
      { ok: false, message: "この候補にはダウンロードできる画像がありません。" },
      { status: 404 },
    );
  }

  const admin = createAdminClient();
  const { data: file, error } = await admin.storage.from("results").download(image.result_path);
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
  const filename = `${base}_候補${slot + 1}.png`.replace(/[\/\\:*?"<>|]/g, "_");

  return new NextResponse(await file.arrayBuffer(), {
    headers: {
      "content-type": "image/png",
      "content-disposition": contentDisposition(filename),
      "cache-control": "no-store",
    },
  });
}
