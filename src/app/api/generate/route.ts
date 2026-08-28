import { NextResponse, after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeMask, prepareSource } from "@/lib/mask";
import { MAX_UPLOAD_BYTES, OPENAI_CONFIG } from "@/lib/models";
import {
  buildSlotPrompt,
  buildSlotSpecs,
  processJob,
  reservationUnitUsd,
  type FallbackPolicy,
  type JobMode,
  type Selection,
} from "@/lib/generate";
import type { CategoryInput } from "@/lib/vendor/prompts/build";
import { isCategoryId, PROCESS_KIND, type CategoryId } from "@/lib/vendor/prompts/categories";
import { requireTemplate } from "@/lib/vendor/prompts/templates";
import type { VariantStrategy } from "@/lib/vendor/prompts/variants";

/**
 * 生成の唯一の入口（確定 UI の STEP 3「ドラフト6枚を生成」）。
 *
 * ★ ジョブを登録して jobId をすぐ返し、生成そのものは応答後に続ける。
 *   確定 UI が「非同期ジョブ・できたものからスロットへ反映」を前提にしているため、
 *   6 枚そろうまで応答を待たせる作りにはできない。
 *   画面は /api/jobs/[id] をポーリングしてスロットを埋める。
 *
 * ★ 上限の確認（reserve_generation）は 6 枚まとめて行う。
 *   1 枚ずつだと、途中で予算が尽きて「3 枚だけ出来たジョブ」が生まれる。
 */

export const maxDuration = 300;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 自由テキストの上限。確定 UI の入力欄に合わせて受け付けるが、長文は通さない。 */
const FREE_TEXT_MAX = 200;

type ParsedSelection = Selection & {
  categoryIds: CategoryId[];
  templateIds: Record<string, string>;
  freeTexts: Record<string, string>;
  removalType: string | null;
};

function parseSelection(
  raw: unknown,
  variantStrategy: VariantStrategy,
  jobMode: JobMode,
): ParsedSelection {
  if (typeof raw !== "object" || raw === null) throw new Error("選択内容を読み取れませんでした。");
  const body = raw as Record<string, unknown>;

  const categories: Partial<Record<CategoryId, CategoryInput>> = {};
  const templateIds: Record<string, string> = {};
  const freeTexts: Record<string, string> = {};

  const entries = body.selections;
  if (entries !== undefined && !Array.isArray(entries)) {
    throw new Error("選択内容の形式が不正です。");
  }

  for (const entry of (entries ?? []) as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { categoryId, templateId, freeText } = entry as Record<string, unknown>;

    if (typeof categoryId !== "string" || !isCategoryId(categoryId)) {
      throw new Error(`知らないカテゴリです: ${String(categoryId)}`);
    }

    const input: { templateId?: string; freeText?: string; referenceCount: number } = {
      referenceCount: 0,
    };

    if (typeof templateId === "string" && templateId.length > 0) {
      // 凍結済みカタログに無い ID はここで落ちる。
      const template = requireTemplate(templateId);
      if (template.categoryId !== categoryId) {
        throw new Error(`テンプレート ${templateId} は ${categoryId} 用ではありません。`);
      }
      input.templateId = templateId;
      templateIds[categoryId] = templateId;
    }

    if (typeof freeText === "string" && freeText.trim().length > 0) {
      const text = freeText.trim().slice(0, FREE_TEXT_MAX);
      input.freeText = text;
      freeTexts[categoryId] = text;
    }

    // メイク以外はテンプレート必須（buildPrompt が要求する）。
    if (categoryId !== "makeup" && input.templateId === undefined) {
      throw new Error(`テンプレートを選んでください（${categoryId}）。`);
    }

    categories[categoryId] = input;
  }

  // メイクは必須カテゴリ。カードが送られてこなくても有効にする（機能仕様書 2.2.1）。
  //
  // ★ ただし除去専用モードでは足さない。
  //   inpaint ではプロンプトが「マスク領域の中身」を指示するため、
  //   肩のタトゥーを塗ったマスクに「メイクを変えろ」と言うと指示が破綻する。
  //   PoC の S-05 は構造上メイクを含めていたが、除去だけを見たいこの
  //   コーナーでは外すほうが正しい（buildPrompt 側も除去のみを許可済み）。
  if (jobMode !== "removal" && categories.makeup === undefined) {
    categories.makeup = { referenceCount: 0 };
  }

  if (jobMode === "removal" && categories.tattoo_removal === undefined) {
    throw new Error("除去対象の種類を選んでください。");
  }

  const categoryIds = Object.keys(categories) as CategoryId[];

  return {
    categories,
    variantStrategy,
    requiresMask: categoryIds.some((id) => PROCESS_KIND[id] === "C"),
    categoryIds,
    templateIds,
    freeTexts,
    removalType: typeof body.removalType === "string" ? body.removalType : null,
  };
}

function fail(status: number, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, message, ...extra }, { status });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail(401, "ログインしてください。");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, "アップロードを読み取れませんでした。");
  }

  // ── STEP 1：元画像 ──
  const sourceFile = form.get("source");
  if (!(sourceFile instanceof File)) {
    return fail(400, "STEP 1 でキャストの元画像をアップロードしてください。");
  }
  if (sourceFile.size > MAX_UPLOAD_BYTES) {
    return fail(
      400,
      `写真が大きすぎます（${(sourceFile.size / 1024 / 1024).toFixed(1)}MB / 上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）。`,
    );
  }

  // ★ 権利の同意。任意画像を受け付ける以上、これが唯一の担保になる。
  //   PoC 側はマニフェストの rights がこれを担っていた（指示書 3.2）。
  if (form.get("rightsConfirmed") !== "true") {
    return fail(
      400,
      "「掲載・加工について本人の同意を得た写真である」にチェックしてください。同意のない写真は送信できません。",
    );
  }

  // ── STEP 0：店舗・キャスト ──
  const storeName = String(form.get("storeName") ?? "").trim();
  const castName = String(form.get("castName") ?? "").trim();
  if (!storeName) return fail(400, "STEP 0 の店舗名が未入力です。画像整理のため店舗を選択してください。");
  if (!castName) return fail(400, "STEP 0 のキャスト名が未入力です。画像整理のためキャスト名を選択してください。");

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (error) {
    return fail(500, error instanceof Error ? error.message : "サーバー側の設定が未完了です。");
  }

  // 作り分け方（案 1 / 案 2）とフォールバックの設定は DB 側が持つ。
  const { data: limits } = await admin
    .from("demo_limits")
    .select(
      "images_per_job, variant_strategy, fallback_enabled, primary_provider, fallback_provider, fallback_on_policy",
    )
    .eq("id", true)
    .single();

  const variantStrategy = (limits?.variant_strategy ?? "micro_delta") as VariantStrategy;

  const policy: FallbackPolicy = {
    enabled: limits?.fallback_enabled ?? true,
    primary: (limits?.primary_provider ?? "openai") as FallbackPolicy["primary"],
    fallback: (limits?.fallback_provider ?? "google") as FallbackPolicy["fallback"],
    onPolicy: limits?.fallback_on_policy ?? true,
  };

  // ── モード（通常加工 / 除去専用） ──
  //   除去は確定 UI の STEP 2 のカードではなく独立したコーナーとして扱う。
  //   マスクを入力できるのは OpenAI だけで、Google へは回せないため、
  //   通常加工と同じ経路に載せると「フォールバックが効くはず」という誤解を生む。
  const jobMode: JobMode = form.get("jobMode") === "removal" ? "removal" : "normal";

  let selection: ParsedSelection;
  try {
    selection = parseSelection(
      JSON.parse(String(form.get("selection") ?? "{}")),
      variantStrategy,
      jobMode,
    );
  } catch (error) {
    return fail(400, error instanceof Error ? error.message : "選択内容が不正です。");
  }

  // ── 画像とマスク ──
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
      return fail(
        400,
        jobMode === "removal"
          ? "マスクが未指定です。元画像上で除去したい範囲をブラシで塗ってください。"
          : "タトゥー・不要物除去が有効ですが、マスクが未指定です。元画像上で除去範囲をブラシで塗るか、カードを無効化してください。",
      );
    }
    try {
      const normalized = await normalizeMask(Buffer.from(await maskFile.arrayBuffer()), sourcePng);
      if (normalized.paintedRatio <= 0) {
        return fail(400, "塗られた範囲がありません。除去したい箇所をブラシで塗ってください。");
      }
      if (normalized.paintedRatio > 0.6) {
        return fail(400, "塗った範囲が広すぎます。除去したい箇所だけを塗ってください。");
      }
      maskPng = normalized.mask;
    } catch (error) {
      return fail(400, error instanceof Error ? error.message : "マスクを処理できませんでした。");
    }
  }

  // ── プロンプトが組めることを、上限を消費する前に確かめる ──
  const slots =
    jobMode === "removal"
      ? buildSlotSpecs("removal")
      : buildSlotSpecs("normal").slice(0, limits?.images_per_job ?? 6);
  let builtHashes: string[];
  let templateVersion: string;
  try {
    const built = slots.map((spec) => buildSlotPrompt(selection, spec));
    builtHashes = built.map((b) => b.hash);
    templateVersion = built[0]!.templateVersion;
  } catch (error) {
    return fail(400, error instanceof Error ? error.message : "プロンプトを組み立てられません。");
  }

  // 予約は高いほうのプロバイダの単価で押さえる（実額は settle_generation で差し替える）。
  // 除去は OpenAI 専用なのでフォールバック分を見込まない。
  const perImageUsd = reservationUnitUsd(
    jobMode === "removal" ? { ...policy, enabled: false, primary: "openai" } : policy,
    selection.requiresMask,
  );
  const reservedCostUsd = Number((perImageUsd * slots.length).toFixed(6));

  // ── 上限の確認（枚数ぶんまとめて） ──
  const { data: reservation, error: reserveError } = await admin.rpc("reserve_generation", {
    p_user: user.id,
    p_est_cost: reservedCostUsd,
    p_count: slots.length,
  });
  if (reserveError) return fail(500, `上限の確認に失敗しました: ${reserveError.message}`);

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

  // ── 記録を先に作る（呼び出す前に「何を投げたか」を残す） ──
  const { data: job, error: jobError } = await admin
    .from("jobs")
    .insert({
      user_id: user.id,
      status: "queued",
      job_mode: jobMode,
      scenario_id: selection.requiresMask ? "D-MASK" : "D-INSTRUCT",
      category_ids: selection.categoryIds,
      template_ids: selection.templateIds,
      free_texts: selection.freeTexts,
      removal_type: selection.removalType,
      template_version: templateVersion,
      model_name: OPENAI_CONFIG.modelId,
      store_name: storeName,
      cast_name: castName,
      session_title: String(form.get("sessionTitle") ?? "").trim() || null,
      image_count: slots.length,
      source_path: "",
      mask_path: null,
      estimated_cost_usd: reservedCostUsd,
      rights_confirmed: true,
      usage_day: usageDay,
    })
    .select("id")
    .single();

  if (jobError || !job) {
    await admin.rpc("settle_generation", {
      p_user: user.id,
      p_day: usageDay,
      p_est_cost: reservedCostUsd,
      p_actual_cost: 0,
      p_refund_images: slots.length,
    });
    return fail(500, `記録を作成できませんでした: ${jobError?.message ?? "不明"}`);
  }

  const sourcePath = `${user.id}/${job.id}/source.png`;
  const maskPath = maskPng ? `${user.id}/${job.id}/mask.png` : null;

  await admin.storage
    .from("sources")
    .upload(sourcePath, sourcePng, { contentType: "image/png", upsert: true });
  if (maskPng && maskPath) {
    await admin.storage
      .from("sources")
      .upload(maskPath, maskPng, { contentType: "image/png", upsert: true });
  }

  await admin
    .from("jobs")
    .update({ source_path: sourcePath, mask_path: maskPath, status: "running" })
    .eq("id", job.id);

  await admin.from("job_images").insert(
    slots.map((spec, index) => ({
      job_id: job.id,
      slot: spec.slot,
      makeup_strength: spec.makeupStrength,
      variant: spec.variant,
      variant_strategy: variantStrategy,
      prompt_hash: builtHashes[index]!,
      status: "queued" as const,
    })),
  );

  // ── 応答を返したあとで 6 枚を作る ──
  after(async () => {
    try {
      await processJob({
        admin,
        jobId: job.id,
        userId: user.id,
        usageDay,
        sourcePng,
        maskPng,
        selection,
        slots,
        mode: jobMode,
        policy,
        reservedCostUsd,
      });
    } catch (error) {
      // ここで落ちるとスロットが「待機中」のまま残る。理由を残しておく。
      await admin
        .from("job_images")
        .update({
          status: "failed",
          error_kind: "infra",
          error_message: error instanceof Error ? error.message : String(error),
          finished_at: new Date().toISOString(),
        })
        .eq("job_id", job.id)
        .in("status", ["queued", "running"]);
      await admin.from("jobs").update({ status: "failed" }).eq("id", job.id);
    }
  });

  return NextResponse.json({
    ok: true,
    jobId: job.id,
    imageCount: slots.length,
    estimatedCostUsd: reservedCostUsd,
    remainingUserImages: reserved.remaining_user_images ?? null,
  });
}
