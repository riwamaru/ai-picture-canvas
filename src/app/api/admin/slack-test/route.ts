import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/auth";
import { isSlackConfigured, notifyJobFinished } from "@/lib/slack";

/**
 * Slack へテスト送信する。管理者だけ。
 *
 * 「設定したつもりで届いていない」を配る前に潰すためのもの。
 * 生成は一切行わないので費用はかからない。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const user = await requireAdmin();
  if (!user) {
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

  const result = await notifyJobFinished(
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
      // 表示用のダミー。記録側には渡さない（実在しないので外部キーに弾かれる）。
      jobId: "テスト送信",
      email: user.email ?? user.id,
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
    // ★ テスト送信は実在するジョブに紐づかないので、記録の job_id は null。
    //   ダミーの UUID を渡すと jobs への外部キーに弾かれ、
    //   「送れたのに履歴が空」になる。
    null,
  );

  // ★ DB を読み戻さず、送信結果そのものを返す。
  //   読み戻す作りだと、記録の書き込みが失敗したときに
  //   「送信も失敗した」と誤って報告してしまう。
  if (result.ok) {
    return NextResponse.json({
      ok: true,
      message:
        "Slack へテスト送信しました。チャンネルを確認してください。" +
        (result.recorded ? "" : `（ただし送信履歴を残せませんでした: ${result.recordError}）`),
    });
  }

  return NextResponse.json({
    ok: false,
    message: result.skipped
      ? (result.error ?? "通知が無効です。")
      : `送信できませんでした（HTTP ${result.statusCode ?? "応答なし"}）: ${result.error ?? "不明"}`,
  });
}
