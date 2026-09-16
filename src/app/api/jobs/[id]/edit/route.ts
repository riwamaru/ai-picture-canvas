import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { INSTRUCTION_MAX, runEditStep } from "@/lib/edit";

/**
 * 個別修正（機能仕様書 v2.1 F-05 逐次編集）。
 *
 * body: { instruction: string, fromDraftSlot?: number }
 *   fromDraftSlot を付けると、その候補（原本）から系統をやり直す。
 *   付けなければ直前の修正結果を入力にする。
 *
 * ★ 実費が発生する。reserve_generation を必ず通す（edit.ts の中で通している）。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const body = (await request.json().catch(() => null)) as
    | { instruction?: unknown; fromDraftSlot?: unknown }
    | null;

  const instruction = typeof body?.instruction === "string" ? body.instruction.trim() : "";
  if (!instruction) {
    return NextResponse.json({ ok: false, message: "指示を入力してください。" }, { status: 400 });
  }
  if (instruction.length > INSTRUCTION_MAX) {
    return NextResponse.json(
      { ok: false, message: `指示は ${INSTRUCTION_MAX} 文字までです。` },
      { status: 400 },
    );
  }

  const fromDraftSlot =
    body?.fromDraftSlot === undefined || body.fromDraftSlot === null
      ? null
      : Number(body.fromDraftSlot);
  if (fromDraftSlot !== null && (!Number.isInteger(fromDraftSlot) || fromDraftSlot < 0)) {
    return NextResponse.json({ ok: false, message: "スロットの指定が不正です。" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, message: "ログインしてください。" }, { status: 401 });
  }

  // ★ 持ち主の確認は RLS 下のクライアントで行う（service_role は RLS を迂回する）
  const { data: job } = await supabase.from("jobs").select("id").eq("id", id).maybeSingle();
  if (!job) {
    return NextResponse.json({ ok: false, message: "見つかりません。" }, { status: 404 });
  }

  const admin = createAdminClient();
  const outcome = await runEditStep(admin, {
    jobId: id,
    userId: user.id,
    email: user.email ?? user.id,
    instruction,
    fromDraftSlot,
  });

  if (!outcome.ok) {
    return NextResponse.json(
      {
        ok: false,
        reason: outcome.reason,
        message: outcome.message,
        retryAfterSeconds: outcome.retryAfterSeconds,
        errorKind: outcome.errorKind,
      },
      { status: outcome.reason === "limit" ? 429 : 200 },
    );
  }

  const { data: signed } = await admin.storage
    .from("results")
    .createSignedUrl(outcome.resultPath, 3600);

  return NextResponse.json({
    ok: true,
    stepId: outcome.stepId,
    stepNo: outcome.stepNo,
    chainLength: outcome.chainLength,
    warning: outcome.warning,
    provider: outcome.provider,
    costUsd: outcome.costUsd,
    latencyMs: outcome.latencyMs,
    url: signed?.signedUrl ?? null,
  });
}
