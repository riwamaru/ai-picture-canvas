import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSlackConfigured, notifyJobFinished } from "@/lib/slack";

/**
 * Slack へテスト送信する。ADMIN_EMAILS の人だけ。
 *
 * 「設定したつもりで届いていない」を配る前に潰すためのもの。
 * 生成は一切行わないので費用はかからない。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const admins = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (!user?.email || !admins.includes(user.email.toLowerCase())) {
    return NextResponse.json({ ok: false, message: "権限がありません。" }, { status: 403 });
  }

  if (!isSlackConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        message:
          "SLACK_WEBHOOK_URL が未設定か、hooks.slack.com 以外の URL です。環境変数を確認してください。",
      },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { data: limits } = await admin
    .from("demo_limits")
    .select("slack_on_limit, slack_include_subject, daily_budget_usd, daily_max_images")
    .eq("id", true)
    .single();

  await notifyJobFinished(
    admin,
    {
      // テスト送信なので、通知オフの状態でも 1 通だけ送る
      slack_enabled: true,
      slack_on_limit: limits?.slack_on_limit ?? true,
      slack_include_subject: limits?.slack_include_subject ?? true,
      daily_budget_usd: limits?.daily_budget_usd ?? 0,
      daily_max_images: limits?.daily_max_images ?? 0,
    },
    {
      jobId: "00000000-0000-0000-0000-000000000000",
      email: user.email,
      mode: "normal",
      storeName: "（テスト送信）",
      castName: "（テスト送信）",
      sessionTitle: null,
      contentJa: "これはテスト送信です。実際の生成は行っていません",
      requested: 6,
      succeeded: 6,
      policyRejected: 0,
      inputRejected: 0,
      infraFailed: 0,
      byProvider: { openai: 6 },
      fellBack: 0,
      actualCostUsd: 0,
      elapsedMs: 0,
      todayImages: 0,
      todayCostUsd: 0,
    },
  );

  // notifyJobFinished が slack_deliveries へ残した結果を読んで返す
  const { data: last } = await admin
    .from("slack_deliveries")
    .select("ok, status_code, error")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({
    ok: last?.ok ?? false,
    message: last?.ok
      ? "Slack へテスト送信しました。チャンネルを確認してください。"
      : `送信できませんでした（${last?.status_code ?? "応答なし"}）: ${last?.error ?? "不明"}`,
  });
}
