import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 上限設定（demo_limits）の読み書き。ADMIN_EMAILS の人だけ。
 *
 * ★ 確定 UI の設定モーダルは「可視化とアラートのみ・強制停止は実装しない」と書いてあるが、
 *   この体験環境は任意の人が実費のかかるボタンを押せる。
 *   したがってここは表示だけでなく、実際に効く上限として扱う。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAdmin(email: string | undefined): boolean {
  if (!email) return false;
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}

async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return isAdmin(user?.email) ? user : null;
}

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
    .select("email, max_images, used_images, last_call_at")
    .order("created_at", { ascending: true });

  return NextResponse.json({ ok: true, limits, today, users: users ?? [] });
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
  num("default_user_max_images", 1, 500);
  num("images_per_job", 1, 6);
  if (body.variant_strategy === "identical" || body.variant_strategy === "micro_delta") {
    patch.variant_strategy = body.variant_strategy;
  }

  const admin = createAdminClient();
  const { error } = await admin.from("demo_limits").update(patch).eq("id", true);
  if (error) {
    return NextResponse.json({ ok: false, message: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
