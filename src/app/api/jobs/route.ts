import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 自分の直近の生成履歴と残り枚数。
 *
 * 画像は非公開バケットにあるので、ここで 1 時間の署名付き URL を作って渡す。
 * バケットを公開にすると URL を知る誰でも顔写真を取得できてしまうため、公開にはしない。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RECENT_LIMIT = 12;

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, message: "ログインしてください。" }, { status: 401 });
  }

  // RLS 下のクライアントで読む（自分の行しか返らないことが DB 側で保証される）。
  const [{ data: profile }, { data: jobs }] = await Promise.all([
    supabase.from("profiles").select("email, max_images, used_images").single(),
    supabase
      .from("jobs")
      .select(
        "id, status, created_at, finished_at, category_ids, makeup_strength, template_ids, source_path, result_path, latency_ms, actual_cost_usd, error_kind, error_message",
      )
      .order("created_at", { ascending: false })
      .limit(RECENT_LIMIT),
  ]);

  // 署名付き URL の発行にだけ特権クライアントを使う。
  // 設定漏れのときに黙って空の履歴を返すと、原因が分からないまま使われてしまう。
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : "サーバー側の設定が未完了です。",
      },
      { status: 500 },
    );
  }

  const rows = await Promise.all(
    (jobs ?? []).map(async (job) => {
      const [source, result] = await Promise.all([
        job.source_path
          ? admin.storage.from("sources").createSignedUrl(job.source_path, 3600)
          : Promise.resolve({ data: null }),
        job.result_path
          ? admin.storage.from("results").createSignedUrl(job.result_path, 3600)
          : Promise.resolve({ data: null }),
      ]);
      return {
        id: job.id,
        status: job.status,
        createdAt: job.created_at,
        categoryIds: job.category_ids,
        makeupStrength: job.makeup_strength,
        templateIds: job.template_ids,
        latencyMs: job.latency_ms,
        costUsd: job.actual_cost_usd,
        errorKind: job.error_kind,
        errorMessage: job.error_message,
        sourceUrl: source.data?.signedUrl ?? null,
        resultUrl: result.data?.signedUrl ?? null,
      };
    }),
  );

  return NextResponse.json({
    ok: true,
    profile: profile ?? null,
    jobs: rows,
  });
}
