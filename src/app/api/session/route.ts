import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * 左サイドバーの「当月の利用状況」・履歴一覧と、
 * 右カラムの「セッション / 当月 / 本日推定」カウンタの実データ。
 *
 * 確定 UI はここを固定値（128 回・$31.75）で描いていた。同じ場所に実測値を入れる。
 * 読み取りはすべて RLS 下（自分の行だけ）。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HISTORY_LIMIT = 20;

/** Asia/Tokyo での「今日」と「今月 1 日」。日付の切り方を DB 側（usage_daily）と揃える。 */
function tokyoBoundaries() {
  const now = new Date();
  const tokyo = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = tokyo.getUTCFullYear();
  const m = tokyo.getUTCMonth();
  const d = tokyo.getUTCDate();
  // JST の 0 時 = UTC の前日 15 時
  const startOfDay = new Date(Date.UTC(y, m, d, -9, 0, 0));
  const startOfMonth = new Date(Date.UTC(y, m, 1, -9, 0, 0));
  return { startOfDay, startOfMonth };
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, message: "ログインしてください。" }, { status: 401 });
  }

  const { startOfDay, startOfMonth } = tokyoBoundaries();

  const [{ data: profile }, { data: jobs }, { data: monthImages }] = await Promise.all([
    supabase.from("profiles").select("email, max_images, used_images").maybeSingle(),
    supabase
      .from("jobs")
      .select(
        "id, status, created_at, store_name, cast_name, session_title, category_ids, model_name, image_count",
      )
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT),
    // 当月ぶんの 1 枚単位の記録（回数とコストの集計に使う）
    supabase
      .from("job_images")
      .select("actual_cost_usd, finished_at, status")
      .gte("finished_at", startOfMonth.toISOString()),
  ]);

  const succeeded = (monthImages ?? []).filter((row) => row.status === "succeeded");
  const monthCount = succeeded.length;
  const monthCost = succeeded.reduce((sum, row) => sum + Number(row.actual_cost_usd ?? 0), 0);
  const todayCost = succeeded
    .filter((row) => row.finished_at !== null && new Date(row.finished_at) >= startOfDay)
    .reduce((sum, row) => sum + Number(row.actual_cost_usd ?? 0), 0);

  return NextResponse.json({
    ok: true,
    profile: profile
      ? {
          email: profile.email,
          maxImages: profile.max_images,
          usedImages: profile.used_images,
          remainingImages: profile.max_images - profile.used_images,
        }
      : null,
    usage: {
      monthCount,
      monthCostUsd: Number(monthCost.toFixed(4)),
      todayCostUsd: Number(todayCost.toFixed(4)),
    },
    history: (jobs ?? []).map((job) => ({
      id: job.id,
      status: job.status,
      createdAt: job.created_at,
      title:
        job.session_title ??
        `${job.store_name ?? "店舗未選択"}_${job.cast_name ?? "キャスト未入力"}`,
      modelName: job.model_name,
      imageCount: job.image_count,
      categoryIds: job.category_ids,
    })),
  });
}
