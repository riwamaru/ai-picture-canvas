import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 1 ジョブの進捗。確定 UI のスロット 6 個がこれをポーリングして埋まる。
 *
 * 読み取りは RLS 下のクライアントで行う（他人のジョブは DB 側で返らない）。
 * 署名付き URL の発行だけ特権クライアントを使う。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, message: "ログインしてください。" }, { status: 401 });
  }

  const { data: job } = await supabase
    .from("jobs")
    .select(
      "id, status, job_mode, image_count, store_name, cast_name, session_title, category_ids, source_path, created_at, finished_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (!job) {
    return NextResponse.json({ ok: false, message: "ジョブが見つかりません。" }, { status: 404 });
  }

  const { data: images } = await supabase
    .from("job_images")
    .select(
      "slot, makeup_strength, variant, status, provider, edit_method, attempted_provider, attempted_error_kind, result_path, latency_ms, actual_cost_usd, error_kind, error_message, drive_status, drive_view_url, drive_synced_at",
    )
    .eq("job_id", id)
    .order("slot", { ascending: true });

  const admin = createAdminClient();

  const slots = await Promise.all(
    (images ?? []).map(async (image) => {
      const signed = image.result_path
        ? await admin.storage.from("results").createSignedUrl(image.result_path, 3600)
        : { data: null };
      return {
        slot: image.slot,
        makeupStrength: image.makeup_strength,
        variant: image.variant,
        status: image.status as "queued" | "running" | "succeeded" | "failed",
        provider: image.provider,
        // inpaint（マスク画像を渡す）か semantic_mask（目印と文章で伝える）か。
        // 「マスク外は不変」の保証の有無が違うので、画面でも区別する。
        editMethod: image.edit_method,
        // フォールバックが起きた場合、先に失敗したプロバイダとその理由。
        // 画面に「OpenAI が拒否 → Google で生成」と出すために返す。
        attemptedProvider: image.attempted_provider,
        attemptedErrorKind: image.attempted_error_kind,
        latencyMs: image.latency_ms,
        costUsd: image.actual_cost_usd === null ? null : Number(image.actual_cost_usd),
        errorKind: image.error_kind,
        errorMessage: image.error_message,
        // Drive への同期状態（仕様書 4.7.2）。failed は「Supabase には残っているが
        // Drive へ送れていない」状態であり、画像そのものは失われていない。
        driveStatus: image.drive_status as "none" | "pending" | "synced" | "failed",
        driveViewUrl: image.drive_view_url,
        driveSyncedAt: image.drive_synced_at,
        url: signed.data?.signedUrl ?? null,
      };
    }),
  );

  const sourceSigned = job.source_path
    ? await admin.storage.from("sources").createSignedUrl(job.source_path, 3600)
    : { data: null };

  return NextResponse.json({
    ok: true,
    job: {
      id: job.id,
      status: job.status,
      jobMode: job.job_mode,
      imageCount: job.image_count,
      storeName: job.store_name,
      castName: job.cast_name,
      sessionTitle: job.session_title,
      categoryIds: job.category_ids,
      sourceUrl: sourceSigned.data?.signedUrl ?? null,
      createdAt: job.created_at,
      finishedAt: job.finished_at,
    },
    slots,
    // 画面の「n/6 完了」表示に使う
    done: slots.filter((s) => s.status === "succeeded" || s.status === "failed").length,
    succeeded: slots.filter((s) => s.status === "succeeded").length,
  });
}
