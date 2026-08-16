import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeMask, prepareSource, sharpMaskCodec } from "@/lib/mask";
import { DEMO_RESOLUTION, MAX_UPLOAD_BYTES, OPENAI_CONFIG, PER_CALL_TIMEOUT_MS } from "@/lib/models";
import { OpenAIProvider, pixelsOf } from "@/lib/vendor/providers/openai";
import { classifyError } from "@/lib/vendor/providers/errors";
import { estimateCost } from "@/lib/vendor/providers/pricing";
import { buildPrompt, type CategoryInput } from "@/lib/vendor/prompts/build";
import {
  isCategoryId,
  MAKEUP_STRENGTHS,
  PROCESS_KIND,
  type CategoryId,
  type MakeupStrength,
} from "@/lib/vendor/prompts/categories";
import { requireTemplate } from "@/lib/vendor/prompts/templates";

/**
 * 生成の唯一の入口。
 *
 * ★ 呼び出しの流れは PoC の CLI（executeRun）と同じ順序を保っている：
 *     入力の検証 → プロンプト構築 → 上限の確認 → 1 回だけ呼ぶ → 記録
 *   再試行・フォールバックは実装しない（PoC 実装指示書 4 章）。
 *   1 回呼んで失敗したら、そのまま分類して記録し、利用者へ理由を返す。
 *
 * ★ 上限の確認は reserve_generation（DB 側）が行う。
 *   Vercel は関数ごとにプロセスが分かれるため、プロセス内のカウンタでは
 *   同時アクセス時に上限を守れない。行ロックのある DB へ寄せてある。
 */

// gpt-image-2 は 1 枚で 1 分を超えることがある。Vercel の関数上限まで引き上げる。
export const maxDuration = 300;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ParsedRequest = {
  makeupStrength: MakeupStrength;
  categories: Partial<Record<CategoryId, CategoryInput>>;
  templateIds: Record<string, string>;
  categoryIds: CategoryId[];
  requiresMask: boolean;
};

/** 画面から来た選択を、プロンプト構築が受け取れる形へ検証しながら組み替える。 */
function parseSelection(raw: unknown): ParsedRequest {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("選択内容を読み取れませんでした。");
  }
  const body = raw as Record<string, unknown>;

  const makeupStrength = body.makeupStrength;
  if (
    typeof makeupStrength !== "string" ||
    !(MAKEUP_STRENGTHS as readonly string[]).includes(makeupStrength)
  ) {
    throw new Error("メイクの強さを選んでください（弱・中・強）。");
  }

  // メイクは必須カテゴリ（機能仕様書 2.2.1）。指示内容は強度で決まるので templateId は渡さない。
  const categories: Partial<Record<CategoryId, CategoryInput>> = {
    makeup: { referenceCount: 0 },
  };
  const templateIds: Record<string, string> = {};

  const selected = body.selections;
  if (selected !== undefined && !Array.isArray(selected)) {
    throw new Error("選択内容の形式が不正です。");
  }

  for (const entry of (selected ?? []) as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { categoryId, templateId } = entry as Record<string, unknown>;

    if (typeof categoryId !== "string" || !isCategoryId(categoryId)) {
      throw new Error(`知らないカテゴリです: ${String(categoryId)}`);
    }
    if (categoryId === "makeup") continue;
    if (typeof templateId !== "string") {
      throw new Error(`テンプレートを選んでください: ${categoryId}`);
    }

    // ★ 自由入力は受け付けない（禁止事項②）。
    //   requireTemplate は凍結済みカタログに無い ID で必ず落ちる。
    const template = requireTemplate(templateId);
    if (template.categoryId !== categoryId) {
      throw new Error(`テンプレート ${templateId} は ${categoryId} 用ではありません。`);
    }

    categories[categoryId] = { templateId, referenceCount: 0 };
    templateIds[categoryId] = templateId;
  }

  const categoryIds = Object.keys(categories) as CategoryId[];
  const requiresMask = categoryIds.some((id) => PROCESS_KIND[id] === "C");

  return {
    makeupStrength: makeupStrength as MakeupStrength,
    categories,
    templateIds,
    categoryIds,
    requiresMask,
  };
}

function fail(status: number, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, message, ...extra }, { status });
}

export async function POST(request: Request) {
  // ── ① 本人確認 ──
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail(401, "ログインしてください。");

  // ── ② 入力の受け取り ──
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, "アップロードを読み取れませんでした。");
  }

  const sourceFile = form.get("source");
  if (!(sourceFile instanceof File)) {
    return fail(400, "写真を選んでください。");
  }
  if (sourceFile.size > MAX_UPLOAD_BYTES) {
    return fail(
      400,
      `写真が大きすぎます（${(sourceFile.size / 1024 / 1024).toFixed(1)}MB / 上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）。`,
    );
  }

  // ★ 権利の同意。PoC 側はマニフェストの rights がこれを担保していた。
  //   任意画像を受け付けるこちらでは、アップロードする人の申告が唯一の担保になる。
  //   同意していない要求はここで止め、API へは一切送らない。
  if (form.get("rightsConfirmed") !== "true") {
    return fail(
      400,
      "「掲載・加工について本人の同意を得た写真である」にチェックしてください。同意のない写真は送信できません。",
    );
  }

  let selection: ParsedRequest;
  try {
    selection = parseSelection(JSON.parse(String(form.get("selection") ?? "{}")));
  } catch (error) {
    return fail(400, error instanceof Error ? error.message : "選択内容が不正です。");
  }

  // ── ③ 画像とマスクの下ごしらえ ──
  let sourcePng: Buffer;
  try {
    sourcePng = await prepareSource(Buffer.from(await sourceFile.arrayBuffer()));
  } catch {
    return fail(400, "写真を読み込めませんでした。JPEG / PNG / WebP のいずれかで試してください。");
  }

  let maskPng: Buffer | null = null;
  if (selection.requiresMask) {
    const maskFile = form.get("mask");
    if (!(maskFile instanceof File)) {
      return fail(400, "消したい範囲をブラシで塗ってください。");
    }
    try {
      const normalized = await normalizeMask(
        Buffer.from(await maskFile.arrayBuffer()),
        sourcePng,
      );
      if (normalized.paintedRatio <= 0) {
        return fail(400, "塗られた範囲がありません。消したい部分をブラシでなぞってください。");
      }
      if (normalized.paintedRatio > 0.6) {
        // 画面のほとんどを塗ると「局所修復」ではなく作り直しになる。
        return fail(400, "塗った範囲が広すぎます。消したい部分だけを塗ってください。");
      }
      maskPng = normalized.mask;
    } catch (error) {
      return fail(400, error instanceof Error ? error.message : "マスクを処理できませんでした。");
    }
  }

  // ── ④ プロンプト構築（凍結済みテンプレートのみ） ──
  let built;
  try {
    built = buildPrompt({
      categories: selection.categories,
      makeupStrength: selection.makeupStrength,
      variant: 1,
      variantStrategy: "identical",
    });
  } catch (error) {
    return fail(400, error instanceof Error ? error.message : "プロンプトを組み立てられません。");
  }

  const mode = selection.requiresMask ? "inpaint" : "instruct";
  const setting = OPENAI_CONFIG.resolution[DEMO_RESOLUTION];

  const estimatedCostUsd = estimateCost({
    provider: "openai",
    modelId: OPENAI_CONFIG.modelId,
    mode,
    resolution: DEMO_RESOLUTION,
    outputPixels: pixelsOf(setting.size),
    quality: setting.quality,
    referenceCount: 0,
  });

  // ── ⑤ 上限の確認（ここを通らない生成経路を作ってはならない） ──
  //
  // 特権クライアントはここで初めて作る。入力の検証より先に作ると、
  // 設定漏れ（service_role キー未設定）のときに「写真を選んでください」ではなく
  // 500 が返り、利用者には何が悪いのか分からなくなる。
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (error) {
    return fail(500, error instanceof Error ? error.message : "サーバー側の設定が未完了です。");
  }

  const { data: reservation, error: reserveError } = await admin.rpc("reserve_generation", {
    p_user: user.id,
    p_est_cost: estimatedCostUsd,
  });
  if (reserveError) {
    return fail(500, `上限の確認に失敗しました: ${reserveError.message}`);
  }
  const reserved = reservation as {
    ok: boolean;
    reason?: string;
    message?: string;
    day?: string;
    retry_after_seconds?: number;
    remaining_user_images?: number;
  };
  if (!reserved.ok) {
    return fail(429, reserved.message ?? "上限に達しました。", {
      reason: reserved.reason,
      retryAfterSeconds: reserved.retry_after_seconds ?? null,
    });
  }

  const usageDay = reserved.day!;
  const stamp = `${user.id}/${Date.now()}`;
  const sourcePath = `${stamp}/source.png`;
  const maskPath = maskPng ? `${stamp}/mask.png` : null;
  const resultPath = `${stamp}/result.png`;

  // ── ⑥ 記録を先に作る（呼び出す前に残す。落ちても「何を投げたか」が残るように） ──
  const { data: job, error: jobError } = await admin
    .from("jobs")
    .insert({
      user_id: user.id,
      status: "running",
      scenario_id: mode === "inpaint" ? "D-MASK" : "D-INSTRUCT",
      category_ids: selection.categoryIds,
      makeup_strength: selection.makeupStrength,
      template_ids: selection.templateIds,
      prompt_hash: built.hash,
      template_version: built.templateVersion,
      model_name: OPENAI_CONFIG.modelId,
      source_path: sourcePath,
      mask_path: maskPath,
      estimated_cost_usd: estimatedCostUsd,
      rights_confirmed: true,
      usage_day: usageDay,
    })
    .select("id")
    .single();

  if (jobError || !job) {
    // 予約を戻してから返す。戻さないと押しただけで枠が減る。
    await admin.rpc("settle_generation", {
      p_user: user.id,
      p_day: usageDay,
      p_est_cost: estimatedCostUsd,
      p_actual_cost: 0,
      p_refund_image: true,
    });
    return fail(500, `記録を作成できませんでした: ${jobError?.message ?? "不明"}`);
  }

  await admin.storage.from("sources").upload(sourcePath, sourcePng, {
    contentType: "image/png",
    upsert: true,
  });
  if (maskPng && maskPath) {
    await admin.storage.from("sources").upload(maskPath, maskPng, {
      contentType: "image/png",
      upsert: true,
    });
  }

  // ── ⑦ 1 回だけ呼ぶ ──
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    await admin.rpc("settle_generation", {
      p_user: user.id,
      p_day: usageDay,
      p_est_cost: estimatedCostUsd,
      p_actual_cost: 0,
      p_refund_image: true,
    });
    await admin
      .from("jobs")
      .update({
        status: "failed",
        error_kind: "infra",
        error_message: "OPENAI_API_KEY が設定されていません",
        finished_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    return fail(500, "サーバー側の設定が未完了です（API キー未設定）。管理者へ連絡してください。");
  }

  const provider = new OpenAIProvider(OPENAI_CONFIG, apiKey, sharpMaskCodec);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS);

  try {
    const result = await provider.edit(
      {
        mode,
        baseImage: new Uint8Array(sourcePng),
        maskImage: maskPng ? new Uint8Array(maskPng) : undefined,
        prompt: built.text,
        resolution: DEMO_RESOLUTION,
        variantSeedHint: built.variantSeedHint,
      },
      controller.signal,
    );

    await admin.storage.from("results").upload(resultPath, Buffer.from(result.image), {
      contentType: "image/png",
      upsert: true,
    });

    await admin
      .from("jobs")
      .update({
        status: "succeeded",
        result_path: resultPath,
        actual_cost_usd: result.estimatedCostUsd,
        latency_ms: result.latencyMs,
        model_name: result.modelName,
        finished_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    // 見積で引いた分を実額へ差し替える。
    await admin.rpc("settle_generation", {
      p_user: user.id,
      p_day: usageDay,
      p_est_cost: estimatedCostUsd,
      p_actual_cost: result.estimatedCostUsd,
      p_refund_image: false,
    });

    const [sourceUrl, resultUrl] = await Promise.all([
      admin.storage.from("sources").createSignedUrl(sourcePath, 3600),
      admin.storage.from("results").createSignedUrl(resultPath, 3600),
    ]);

    return NextResponse.json({
      ok: true,
      jobId: job.id,
      sourceUrl: sourceUrl.data?.signedUrl ?? null,
      resultUrl: resultUrl.data?.signedUrl ?? null,
      latencyMs: result.latencyMs,
      costUsd: result.estimatedCostUsd,
      remainingUserImages: reserved.remaining_user_images ?? null,
      noteJa: built.noteJa,
    });
  } catch (error) {
    const classified = classifyError(error);

    // ★ 枚数を返すのはインフラ障害のときだけ。
    //   policy 拒否・入力不備で返すと、拒否されるまで何度でも押せることになる
    //   （禁止事項③「拒否された内容を文言を変えて再投入しない」の趣旨）。
    await admin.rpc("settle_generation", {
      p_user: user.id,
      p_day: usageDay,
      p_est_cost: estimatedCostUsd,
      p_actual_cost: 0,
      p_refund_image: classified.kind === "infra",
    });

    await admin
      .from("jobs")
      .update({
        status: "failed",
        error_kind: classified.kind,
        error_message: `${classified.code}: ${classified.detail}`.slice(0, 2000),
        finished_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    const messages: Record<string, string> = {
      policy:
        "この写真と指示の組み合わせは、OpenAI の安全性判定により拒否されました。別の写真で試してください。（同じ内容を言い換えて再投入することは、この環境では行いません）",
      input: `送信内容に不備がありました: ${classified.detail}`,
      infra: `生成に失敗しました（一時的な障害の可能性があります）: ${classified.detail}`,
    };

    return NextResponse.json(
      {
        ok: false,
        jobId: job.id,
        errorKind: classified.kind,
        message: messages[classified.kind],
      },
      { status: classified.kind === "infra" ? 502 : 400 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
