import type { SupabaseClient } from "@supabase/supabase-js";
import { analyzeMask, renderMaskGuide } from "./mask";
import { buildSemanticRemovalPrompt } from "./removal";
import { buildSlotPrompt, createProvider, estimateOne, type ProviderKeys, type Selection } from "./generate";
import { PER_CALL_TIMEOUT_MS, type ProviderName } from "./models";
import { classifyError } from "./vendor/providers/errors";
import type { CategoryInput } from "./vendor/prompts/build";
import type { CategoryId, MakeupStrength } from "./vendor/prompts/categories";
import { PROCESS_KIND } from "./vendor/prompts/categories";
import type { VariantIndex, VariantStrategy } from "./vendor/prompts/variants";
import type { Resolution } from "./vendor/providers/types";
import { syncFinalToDrive, type SyncOutcome } from "./driveSync";
import { buildEditPrompt } from "./edit";
import { notifyDriveIncident } from "./slack";

/**
 * 確定処理（機能仕様書 v2.1 STEP 5）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 仕様書 STEP 5：
 *   「選択された 1 枚のみを高解像度で再生成し確定画像とする。
 *     確定画像は Google Drive の共有ドライブへ自動格納され、
 *     履歴レコードにファイル ID・閲覧 URL・使用モデル・推定コストが記録される」
 *
 * ここでやるのは 3 つ：
 *   ① 選んだドラフトと同じ条件で、高解像度で作り直す
 *   ② できたものを Drive へ入れる（driveSync に任せる）
 *   ③ 使用モデル・推定コスト・処理時間を final_images へ残す
 *
 * 【なぜ「作り直す」のか】
 * ドラフトを引き伸ばすのではない。同じプロンプトで解像度だけ上げて
 * もう一度生成する（仕様書 5.4 の 2 段階生成）。したがって
 * **ドラフトと完全に同じ絵にはならない**。画面にもそう書いてある。
 *
 * 【費用】
 * 2k は 1 枚あたり約 $0.85 かかる（gpt-image-2 の quality:high は
 * 1024x1024 で $0.211、2048x2048 はその 4 倍の画素数）。
 * ★ 必ず reserve_generation を通す。ここを迂回する経路を作ってはならない。
 * ═══════════════════════════════════════════════════════════════
 */

export type FinalizeOutcome =
  | {
      ok: true;
      status: "created" | "already";
      resolution: Resolution;
      provider: ProviderName | null;
      costUsd: number;
      latencyMs: number | null;
      /** Drive への保存結果。設定がオフなら null。 */
      drive: SyncOutcome | null;
    }
  | {
      ok: false;
      /** 上限に当たったのか、生成が失敗したのか。画面の出し分けに使う。 */
      reason: "limit" | "failed" | "invalid" | "busy";
      message: string;
      retryAfterSeconds?: number;
      errorKind?: "policy" | "input" | "infra";
    };

type JobRow = {
  id: string;
  user_id: string;
  job_mode: "normal" | "removal";
  category_ids: string[];
  template_ids: Record<string, string>;
  free_texts: Record<string, string>;
  removal_type: string | null;
  source_path: string;
  mask_path: string | null;
};

type DraftRow = {
  slot: number;
  status: string;
  makeup_strength: MakeupStrength;
  variant: number;
  variant_strategy: VariantStrategy;
  provider: ProviderName | null;
  edit_method: "inpaint" | "semantic_mask" | "instruct" | null;
};

type Attempt = { provider: ProviderName; method: "inpaint" | "semantic_mask" | "instruct" };

/**
 * 選んだ 1 枚を高解像度で作り直し、Drive へ入れる。
 *
 * ★ 呼び出す前に「そのジョブが本人のものか」を確認しておくこと。
 *   ここは service_role で動くので RLS が効かない。
 */
export async function finalizeJob(
  admin: SupabaseClient,
  input: {
    jobId: string;
    /** 系統の元になったドラフト。修正を経た場合も「どの候補から始めたか」として残す。 */
    slot: number;
    /** 個別修正を経てから確定する場合、その最後の修正（仕様書 STEP 4 → STEP 5）。 */
    stepId: string | null;
    userId: string;
    email: string;
  },
): Promise<FinalizeOutcome> {
  const { data: job } = await admin
    .from("jobs")
    .select(
      "id, user_id, job_mode, category_ids, template_ids, free_texts, removal_type, source_path, mask_path",
    )
    .eq("id", input.jobId)
    .maybeSingle<JobRow>();

  const { data: draft } = await admin
    .from("job_images")
    .select("slot, status, makeup_strength, variant, variant_strategy, provider, edit_method")
    .eq("job_id", input.jobId)
    .eq("slot", input.slot)
    .maybeSingle<DraftRow>();

  if (!job || !draft) {
    return { ok: false, reason: "invalid", message: "対象が見つかりません。" };
  }
  if (draft.status !== "succeeded") {
    return { ok: false, reason: "invalid", message: "この候補は生成に失敗しています。" };
  }

  // ── 個別修正を経ているなら、その最後の修正を「選んだ 1 枚」とみなす ──
  //
  // 2K での作り直しは「その修正の指示を、その修正の入力画像に対して 2K で適用し直す」。
  // 修正結果（1K）を引き伸ばすのではなく、同じ変換を高解像度でやり直す。
  type EditStep = {
    id: string;
    status: string;
    instruction: string;
    provider: ProviderName | null;
    source_kind: "draft" | "step";
    source_slot: number | null;
    source_step_id: string | null;
  };
  let editStep: EditStep | null = null;
  let editSourcePath: string | null = null;
  if (input.stepId) {
    const { data: step } = await admin
      .from("edit_steps")
      .select("id, status, instruction, provider, source_kind, source_slot, source_step_id")
      .eq("id", input.stepId)
      .eq("job_id", input.jobId)
      .maybeSingle<EditStep>();
    if (!step || step.status !== "succeeded") {
      return { ok: false, reason: "invalid", message: "その修正結果は確定できません。" };
    }
    editStep = step;

    if (step.source_kind === "draft") {
      const { data: src } = await admin
        .from("job_images")
        .select("result_path")
        .eq("job_id", input.jobId)
        .eq("slot", step.source_slot!)
        .maybeSingle();
      editSourcePath = (src?.result_path as string | null) ?? null;
    } else {
      const { data: src } = await admin
        .from("edit_steps")
        .select("result_path")
        .eq("id", step.source_step_id!)
        .maybeSingle();
      editSourcePath = (src?.result_path as string | null) ?? null;
    }
    if (!editSourcePath) {
      return { ok: false, reason: "invalid", message: "修正の入力画像が見つかりません。" };
    }
  }

  // ── 既に確定済みか ──
  //
  // final_images.job_id は unique（1 セッションにつき確定画像は 1 枚）。
  const { data: existing } = await admin
    .from("final_images")
    .select("id, status, source_slot, provider, resolution, actual_cost_usd, latency_ms, drive_status")
    .eq("job_id", input.jobId)
    .maybeSingle();

  if (existing?.status === "succeeded") {
    // 同じ候補なら Drive への保存だけやり直せるようにする（未同期の再送）。
    const drive = await syncFinalToDrive(admin, { jobId: input.jobId });
    return {
      ok: true,
      status: "already",
      resolution: existing.resolution as Resolution,
      provider: (existing.provider as ProviderName | null) ?? null,
      costUsd: Number(existing.actual_cost_usd ?? 0),
      latencyMs: (existing.latency_ms as number | null) ?? null,
      drive,
    };
  }

  if (existing?.status === "running") {
    return {
      ok: false,
      reason: "busy",
      message: "確定処理を実行中です。しばらくお待ちください。",
    };
  }

  // ── 設定を読む ──
  const { data: limits } = await admin
    .from("demo_limits")
    .select(
      "final_resolution, fallback_enabled, fallback_on_policy, primary_provider, fallback_provider, removal_fallback_enabled, drive_enabled",
    )
    .eq("id", true)
    .maybeSingle();

  const resolution = (limits?.final_resolution ?? "2k") as Resolution;
  const fallbackEnabled = limits?.fallback_enabled ?? true;

  // ── 選択内容をジョブの記録から組み直す ──
  //
  // 生成のときの入力は jobs に全部残してある（category_ids / template_ids / free_texts）。
  // ★ ここで作り直す条件はドラフトと同一でなければならない。
  //   条件が変わると「選んだ 1 枚を高解像度にした」ことにならない。
  const selection = rebuildSelection(job, draft.variant_strategy);
  const spec = {
    slot: draft.slot,
    makeupStrength: draft.makeup_strength,
    variant: draft.variant as VariantIndex,
  };

  let built: { text: string; hash: string; variantSeedHint?: string };
  try {
    built = editStep ? buildEditPrompt(editStep.instruction) : buildSlotPrompt(selection, spec);
  } catch (error) {
    return {
      ok: false,
      reason: "invalid",
      message: `プロンプトを組み立てられません: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // ── 試す順番を決める ──
  //
  // ★ ドラフトを作ったのと同じプロバイダ・方式を最初に試す。
  //   確定画像はそのドラフトを選んだ結果なので、別のモデルで作ると
  //   「選んだものと違う絵」が確定画像になってしまう。
  const chain = buildChain({
    mode: editStep ? "normal" : job.job_mode,
    draftProvider: editStep ? editStep.provider : draft.provider,
    draftMethod: editStep ? "instruct" : draft.edit_method,
    fallbackEnabled,
    primary: (limits?.primary_provider ?? "openai") as ProviderName,
    removalFallback: limits?.removal_fallback_enabled ?? true,
  });

  const keys: ProviderKeys = {
    openai: process.env.OPENAI_API_KEY,
    google: process.env.GEMINI_API_KEY,
  };
  const usable = chain.filter((attempt) => createProvider(attempt.provider, keys) !== null);
  if (usable.length === 0) {
    return { ok: false, reason: "failed", message: "画像生成の API キーが設定されていません。" };
  }

  // ── 上限の確認（★ ここを迂回する経路を作ってはならない） ──
  //
  // 予約は「試す可能性のあるプロバイダのうち高いほう」で押さえる。
  // 拒否は課金されないので、実額は最後に成功した 1 回ぶんになる。
  const perImageUsd = Math.max(
    ...usable.map((attempt) =>
      estimateOne(attempt.provider, attempt.method === "inpaint", resolution),
    ),
  );

  const { data: reservation, error: reserveError } = await admin.rpc("reserve_generation", {
    p_user: input.userId,
    p_est_cost: perImageUsd,
    p_count: 1,
  });
  if (reserveError) {
    return { ok: false, reason: "failed", message: `上限の確認に失敗しました: ${reserveError.message}` };
  }

  const reserved = reservation as {
    ok: boolean;
    reason?: string;
    message?: string;
    day?: string;
    retry_after_seconds?: number;
  };
  if (!reserved.ok) {
    return {
      ok: false,
      reason: "limit",
      message: reserved.message ?? "上限に達しました。",
      retryAfterSeconds: reserved.retry_after_seconds,
    };
  }

  const usageDay = reserved.day!;

  // ── 行を用意する（失敗しても記録が残るように、生成の前に作る） ──
  const { data: row, error: rowError } = await admin
    .from("final_images")
    .upsert(
      {
        job_id: input.jobId,
        source_slot: input.slot,
        source_step_id: editStep?.id ?? null,
        status: "running",
        resolution,
        prompt_hash: built.hash,
        reserved_cost_usd: perImageUsd,
        started_at: new Date().toISOString(),
        // 作り直しのときに前回の失敗が残らないようにする
        error_kind: null,
        error_message: null,
        attempted_provider: null,
        attempted_error_kind: null,
        attempted_error_message: null,
      },
      { onConflict: "job_id" },
    )
    .select("id")
    .maybeSingle();

  if (rowError || !row) {
    await settle(admin, input.userId, usageDay, perImageUsd, 0, 1);
    return { ok: false, reason: "failed", message: `確定処理を開始できません: ${rowError?.message ?? "不明"}` };
  }
  const finalId = row.id as string;

  // ── 素材を読む ──
  const source = editStep
    ? await downloadFromStorage(admin, "results", editSourcePath!)
    : await downloadFromStorage(admin, "sources", job.source_path);
  if (!source) {
    await failFinal(admin, finalId, "infra", "元画像を取得できませんでした。");
    await settle(admin, input.userId, usageDay, perImageUsd, 0, 1);
    return { ok: false, reason: "failed", message: "元画像を取得できませんでした。", errorKind: "infra" };
  }

  let maskPng: Buffer | null = null;
  if (job.mask_path && !editStep) {
    maskPng = await downloadFromStorage(admin, "sources", job.mask_path);
  }
  if (selection.requiresMask && !editStep && !maskPng) {
    await failFinal(admin, finalId, "input", "マスク画像を取得できませんでした。");
    await settle(admin, input.userId, usageDay, perImageUsd, 0, 1);
    return { ok: false, reason: "failed", message: "マスク画像を取得できませんでした。", errorKind: "input" };
  }

  // semantic masking の材料（Gemini へ回すときだけ要る）
  let maskGuide: Buffer | null = null;
  let maskRegion = null;
  if (maskPng && usable.some((a) => a.method === "semantic_mask")) {
    try {
      maskRegion = await analyzeMask(maskPng);
      maskGuide = await renderMaskGuide(source, maskPng);
    } catch (error) {
      console.error("[finalize] 目印つき画像を作れませんでした:", error);
    }
  }

  const removalTemplateId = job.template_ids?.tattoo_removal;

  // ── 生成 ──
  const startedAt = Date.now();
  let attempted: { provider: ProviderName; kind: string; detail: string } | null = null;

  for (let index = 0; index < usable.length; index += 1) {
    const { provider: name, method } = usable[index]!;
    const provider = createProvider(name, keys)!;
    const isLast = index === usable.length - 1;

    // 材料が作れなかった semantic_mask は黙って別物を送らずに飛ばす
    if (method === "semantic_mask" && (!maskGuide || !maskRegion || !removalTemplateId)) {
      if (isLast) break;
      continue;
    }

    const semantic =
      method === "semantic_mask" && maskRegion && removalTemplateId
        ? buildSemanticRemovalPrompt({
            templateId: removalTemplateId,
            freeText: job.free_texts?.tattoo_removal ?? null,
            region: maskRegion,
          })
        : null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS);

    try {
      const result = await provider.edit(
        semantic
          ? {
              mode: "reference",
              baseImage: new Uint8Array(source),
              referenceImages: [new Uint8Array(maskGuide!)],
              prompt: semantic.text,
              resolution,
            }
          : {
              mode: method === "inpaint" ? "inpaint" : "instruct",
              baseImage: new Uint8Array(source),
              maskImage: method === "inpaint" && maskPng ? new Uint8Array(maskPng) : undefined,
              prompt: built.text,
              resolution,
              variantSeedHint: built.variantSeedHint,
            },
        controller.signal,
      );

      const resultPath = `${input.userId}/${input.jobId}/final.png`;
      const { error: uploadError } = await admin.storage
        .from("results")
        .upload(resultPath, Buffer.from(result.image), {
          contentType: "image/png",
          upsert: true,
        });
      if (uploadError) throw new Error(`確定画像を保存できませんでした: ${uploadError.message}`);

      await admin
        .from("final_images")
        .update({
          status: "succeeded",
          provider: name,
          edit_method: method,
          ...(semantic ? { prompt_hash: semantic.hash } : {}),
          attempted_provider: attempted?.provider ?? null,
          attempted_error_kind: attempted?.kind ?? null,
          attempted_error_message: attempted ? attempted.detail.slice(0, 2000) : null,
          result_path: resultPath,
          actual_cost_usd: result.estimatedCostUsd,
          latency_ms: result.latencyMs,
          finished_at: new Date().toISOString(),
        })
        .eq("id", finalId);

      await settle(admin, input.userId, usageDay, perImageUsd, result.estimatedCostUsd, 0);

      // ── Drive へ入れる（仕様書 STEP 5 ②） ──
      //
      // ★ ここで失敗しても確定処理は成功として扱う。
      //   画像は Supabase Storage にあり、未同期として後から再送される
      //   （仕様書 4.7.2 の 4 行目）。
      const drive = limits?.drive_enabled
        ? await syncFinalToDrive(admin, { jobId: input.jobId })
        : null;

      return {
        ok: true,
        status: "created",
        resolution,
        provider: name,
        costUsd: result.estimatedCostUsd,
        latencyMs: result.latencyMs,
        drive,
      };
    } catch (error) {
      const classified = classifyError(error);

      const canFallback =
        !isLast &&
        classified.kind !== "input" &&
        (classified.kind !== "policy" || (limits?.fallback_on_policy ?? true));

      if (canFallback) {
        attempted = { provider: name, kind: classified.kind, detail: classified.detail };
        clearTimeout(timeout);
        continue;
      }

      await admin
        .from("final_images")
        .update({
          status: "failed",
          provider: name,
          edit_method: method,
          attempted_provider: attempted?.provider ?? null,
          attempted_error_kind: attempted?.kind ?? null,
          attempted_error_message: attempted ? attempted.detail.slice(0, 2000) : null,
          error_kind: classified.kind,
          error_message: `${classified.code}: ${classified.detail}`.slice(0, 2000),
          finished_at: new Date().toISOString(),
        })
        .eq("id", finalId);

      // 枚数を返すのはインフラ障害のときだけ（禁止事項③の趣旨）
      await settle(
        admin,
        input.userId,
        usageDay,
        perImageUsd,
        0,
        classified.kind === "infra" ? 1 : 0,
      );

      return {
        ok: false,
        reason: "failed",
        errorKind: classified.kind,
        message:
          classified.kind === "policy"
            ? "確定画像の生成が、内容の判定により断られました。条件を変えて 6 枚を作り直してください。"
            : `確定画像を生成できませんでした: ${classified.detail}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  // ここへ来るのは、使える試行がすべて飛ばされた場合だけ
  await failFinal(admin, finalId, "infra", "試せるプロバイダがありませんでした。");
  await settle(admin, input.userId, usageDay, perImageUsd, 0, 1);
  return {
    ok: false,
    reason: "failed",
    errorKind: "infra",
    message: `確定画像を生成できませんでした（所要 ${Date.now() - startedAt}ms）。`,
  };
}

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

/** ジョブの記録から Selection を組み直す。生成時と同じ条件になるようにする。 */
function rebuildSelection(job: JobRow, variantStrategy: VariantStrategy): Selection {
  const categories: Partial<Record<CategoryId, CategoryInput>> = {};

  for (const id of job.category_ids as CategoryId[]) {
    const templateId = job.template_ids?.[id];
    const freeText = job.free_texts?.[id];
    categories[id] = {
      referenceCount: 0,
      ...(typeof templateId === "string" && templateId.length > 0 ? { templateId } : {}),
      ...(typeof freeText === "string" && freeText.length > 0 ? { freeText } : {}),
    };
  }

  return {
    categories,
    variantStrategy,
    requiresMask: (job.category_ids as CategoryId[]).some((id) => PROCESS_KIND[id] === "C"),
  };
}

/** 試す順番。ドラフトを作ったのと同じ組み合わせを先頭に置く。 */
function buildChain(input: {
  mode: "normal" | "removal";
  draftProvider: ProviderName | null;
  draftMethod: "inpaint" | "semantic_mask" | "instruct" | null;
  fallbackEnabled: boolean;
  primary: ProviderName;
  removalFallback: boolean;
}): Attempt[] {
  if (input.mode === "removal") {
    const first: Attempt =
      input.draftMethod === "semantic_mask"
        ? { provider: "google", method: "semantic_mask" }
        : { provider: "openai", method: "inpaint" };
    const second: Attempt =
      first.provider === "openai"
        ? { provider: "google", method: "semantic_mask" }
        : { provider: "openai", method: "inpaint" };
    return input.removalFallback && input.fallbackEnabled ? [first, second] : [first];
  }

  const first: ProviderName = input.draftProvider ?? input.primary;
  const second: ProviderName = first === "openai" ? "google" : "openai";
  const chain: Attempt[] = [{ provider: first, method: "instruct" }];
  if (input.fallbackEnabled) chain.push({ provider: second, method: "instruct" });
  return chain;
}

async function downloadFromStorage(
  admin: SupabaseClient,
  bucket: string,
  path: string,
): Promise<Buffer | null> {
  const { data, error } = await admin.storage.from(bucket).download(path);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

async function failFinal(
  admin: SupabaseClient,
  finalId: string,
  kind: "policy" | "input" | "infra",
  message: string,
): Promise<void> {
  await admin
    .from("final_images")
    .update({
      status: "failed",
      error_kind: kind,
      error_message: message,
      finished_at: new Date().toISOString(),
    })
    .eq("id", finalId);
}

/** 精算。見積で引いた分を実額へ差し替える。 */
async function settle(
  admin: SupabaseClient,
  userId: string,
  usageDay: string,
  estCost: number,
  actualCost: number,
  refundImages: number,
): Promise<void> {
  const { error } = await admin.rpc("settle_generation", {
    p_user: userId,
    p_day: usageDay,
    p_est_cost: estCost,
    p_actual_cost: actualCost,
    p_refund_images: refundImages,
  });
  if (error) {
    // 精算できないと使用量がずれたままになる。黙って流さない。
    console.error("[finalize] 精算に失敗しました:", error.message);
    await notifyDriveIncident(admin, {
      title: "確定処理の精算に失敗しました",
      detail: `使用量の記録がずれています。管理画面の数値をご確認ください。\n${error.message}`,
    }).catch(() => undefined);
  }
}
