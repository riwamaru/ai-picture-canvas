import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { envAdmins, requireAdmin } from "@/lib/auth";
import { diagnoseWebhook, isSlackConfigured } from "@/lib/slack";
import { PROVIDER_ENV_KEY, PROVIDER_NAMES, isProviderName } from "@/lib/models";

/**
 * 上限設定（demo_limits）の読み書き。ADMIN_EMAILS の人だけ。
 *
 * ★ 確定 UI の設定モーダルは「可視化とアラートのみ・強制停止は実装しない」と書いてあるが、
 *   この体験環境は任意の人が実費のかかるボタンを押せる。
 *   したがってここは表示だけでなく、実際に効く上限として扱う。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";



export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ ok: false, message: "権限がありません。" }, { status: 403 });
  }

  const admin = createAdminClient();
  const [{ data: limits }, { data: today }] = await Promise.all([
    admin.from("demo_limits").select("*").eq("id", true).single(),
    admin
      .from("usage_daily")
      .select("day, images, cost_usd")
      .order("day", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const { data: users } = await admin
    .from("profiles")
    .select("email, role, max_images, used_images, last_call_at")
    .order("created_at", { ascending: true });

  // 直近の通知が届いているか（黙って失敗していることに気づけるように）
  const { data: deliveries } = await admin
    .from("slack_deliveries")
    .select("kind, ok, status_code, error, created_at")
    .order("created_at", { ascending: false })
    .limit(5);

  return NextResponse.json({
    ok: true,
    // 環境変数で固定されている管理者（画面で「固定」と出す）
    pinnedAdmins: envAdmins(),
    limits,
    today,
    users: users ?? [],
    slack: {
      // Webhook URL そのものは返さない（画面へ出す必要が無い）
      configured: isSlackConfigured(),
      // 「設定したのに認識されない」を切り分けるための診断（URL のパスは含まない）
      diagnosis: diagnoseWebhook(),
      deliveries: deliveries ?? [],
    },
    // 各プロバイダの API キーが設定されているか（真偽値だけ。キーそのものは返さない）。
    // 未設定のプロバイダはフォールバックの順番から黙って外れるので、画面で気づけるようにする。
    providerKeys: Object.fromEntries(
      PROVIDER_NAMES.map((name) => [name, Boolean(process.env[PROVIDER_ENV_KEY[name]])]),
    ),
  });
}

export async function PATCH(request: Request) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ ok: false, message: "権限がありません。" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ ok: false, message: "内容を読み取れません。" }, { status: 400 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  const num = (key: string, min: number, max: number) => {
    const value = body[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      patch[key] = Math.min(Math.max(value, min), max);
    }
  };

  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  num("daily_budget_usd", 0, 200);
  num("daily_max_images", 0, 2000);
  num("global_min_interval_ms", 0, 600_000);
  num("user_min_interval_ms", 0, 600_000);
  num("edit_min_interval_ms", 0, 600_000);
  num("default_user_max_images", 1, 500);
  // 生成する強度が弱・中の 2 段階になったので、1 回の上限は 4 枚
  num("images_per_job", 1, 4);
  if (body.variant_strategy === "identical" || body.variant_strategy === "micro_delta") {
    patch.variant_strategy = body.variant_strategy;
  }

  // ── フォールバック（OpenAI → Google → Grok） ──
  if (typeof body.fallback_enabled === "boolean") patch.fallback_enabled = body.fallback_enabled;
  if (typeof body.fallback_on_policy === "boolean") {
    patch.fallback_on_policy = body.fallback_on_policy;
  }
  if (isProviderName(body.primary_provider)) patch.primary_provider = body.primary_provider;
  if (isProviderName(body.fallback_provider)) patch.fallback_provider = body.fallback_provider;
  // null ＝「2 段で止める」。キーが無いときは触らない（undefined と null を混同しない）
  if ("second_fallback_provider" in body) {
    if (body.second_fallback_provider === null || isProviderName(body.second_fallback_provider)) {
      patch.second_fallback_provider = body.second_fallback_provider;
    }
  }

  // ── Slack 通知 ──
  if (typeof body.removal_fallback_enabled === "boolean") {
    patch.removal_fallback_enabled = body.removal_fallback_enabled;
  }

  // ── 確定処理（仕様書 STEP 5 / F-06） ──
  if (typeof body.drive_enabled === "boolean") patch.drive_enabled = body.drive_enabled;
  // ★ 2k は 1 枚あたり約 $0.85。測定目的で回すときに落とせるようにしてある。
  if (body.final_resolution === "1k" || body.final_resolution === "2k") {
    patch.final_resolution = body.final_resolution;
  }

  for (const key of ["slack_enabled", "slack_on_limit", "slack_include_subject"] as const) {
    if (typeof body[key] === "boolean") patch[key] = body[key];
  }

  const admin = createAdminClient();
  const { error } = await admin.from("demo_limits").update(patch).eq("id", true);
  if (error) {
    return NextResponse.json({ ok: false, message: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
