import type { SupabaseClient } from "@supabase/supabase-js";
import { sharpMaskCodec } from "./mask";
import { DEMO_RESOLUTION, OPENAI_CONFIG, PER_CALL_TIMEOUT_MS } from "./models";
import { OpenAIProvider, pixelsOf } from "./vendor/providers/openai";
import { classifyError } from "./vendor/providers/errors";
import { estimateCost } from "./vendor/providers/pricing";
import { buildPrompt, type CategoryInput } from "./vendor/prompts/build";
import { MAKEUP_STRENGTHS, type CategoryId, type MakeupStrength } from "./vendor/prompts/categories";
import type { VariantIndex, VariantStrategy } from "./vendor/prompts/variants";

/**
 * ドラフト 6 枚の生成。
 *
 * ★ 確定 UI（index.html）の STEP 3 は「メイク強度 弱・中・強 × 各 2 枚 ＝ 6 枚を
 *   非同期で生成し、できたものからスロットへ反映する」設計である（機能仕様書 2.2.1）。
 *   6 枚は 1 回の呼び出しではなく 6 回の API 呼び出しになる。
 *
 * ★ 再試行・フォールバックは実装しない（PoC 実装指示書 4 章）。
 *   1 枚が失敗しても、その枚だけ失敗として記録し、他は続ける。
 *   確定 UI の「代替プロバイダで再試行」ボタンは、押した時点で
 *   新しい 1 枚として枠を消費する（黙って作り直さない）。
 */

/** 同時に走らせる本数。Vercel の関数上限（300 秒）に 6 枚を収めるための値。 */
const CONCURRENCY = 3;

export type SlotSpec = {
  slot: number;
  makeupStrength: MakeupStrength;
  variant: VariantIndex;
};

/** 弱・中・強 × 各 2 枚 ＝ 6 スロット。並び順は確定 UI と同じ。 */
export function buildSlotSpecs(): SlotSpec[] {
  const slots: SlotSpec[] = [];
  for (const strength of MAKEUP_STRENGTHS) {
    for (const variant of [1, 2] as const) {
      slots.push({ slot: slots.length, makeupStrength: strength, variant });
    }
  }
  return slots;
}

export type Selection = {
  categories: Partial<Record<CategoryId, CategoryInput>>;
  variantStrategy: VariantStrategy;
  requiresMask: boolean;
};

/** 1 枚ぶんの推定コスト。上限判定に使う。 */
export function estimateOne(requiresMask: boolean): number {
  const setting = OPENAI_CONFIG.resolution[DEMO_RESOLUTION];
  return estimateCost({
    provider: "openai",
    modelId: OPENAI_CONFIG.modelId,
    mode: requiresMask ? "inpaint" : "instruct",
    resolution: DEMO_RESOLUTION,
    outputPixels: pixelsOf(setting.size),
    quality: setting.quality,
    referenceCount: 0,
  });
}

export function buildSlotPrompt(selection: Selection, spec: SlotSpec) {
  return buildPrompt({
    categories: selection.categories,
    makeupStrength: spec.makeupStrength,
    variant: spec.variant,
    variantStrategy: selection.variantStrategy,
  });
}

type ProcessInput = {
  admin: SupabaseClient;
  jobId: string;
  userId: string;
  usageDay: string;
  sourcePng: Buffer;
  maskPng: Buffer | null;
  selection: Selection;
  slots: SlotSpec[];
  /** 予約時に引いた見積の合計。実額との差し替えに使う。 */
  reservedCostUsd: number;
};

/**
 * 6 枚を順次生成し、1 枚できるたびに DB を更新する。
 * 画面はこの行をポーリングしてスロットを埋める。
 */
export async function processJob(input: ProcessInput): Promise<void> {
  const {
    admin,
    jobId,
    userId,
    usageDay,
    sourcePng,
    maskPng,
    selection,
    slots,
    reservedCostUsd,
  } = input;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    await admin
      .from("job_images")
      .update({
        status: "failed",
        error_kind: "infra",
        error_message: "OPENAI_API_KEY が設定されていません",
        finished_at: new Date().toISOString(),
      })
      .eq("job_id", jobId);
    await admin.from("jobs").update({ status: "failed" }).eq("id", jobId);
    // こちら側の設定漏れなので枚数は全部返す
    await admin.rpc("settle_generation", {
      p_user: userId,
      p_day: usageDay,
      p_est_cost: reservedCostUsd,
      p_actual_cost: 0,
      p_refund_images: slots.length,
    });
    return;
  }

  const provider = new OpenAIProvider(OPENAI_CONFIG, apiKey, sharpMaskCodec);
  const mode = selection.requiresMask ? "inpaint" : "instruct";

  let actualCostUsd = 0;
  let refundImages = 0;

  const queue = [...slots];

  async function worker(): Promise<void> {
    for (;;) {
      const spec = queue.shift();
      if (!spec) return;

      await admin
        .from("job_images")
        .update({ status: "running", started_at: new Date().toISOString() })
        .eq("job_id", jobId)
        .eq("slot", spec.slot);

      const built = buildSlotPrompt(selection, spec);
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

        const resultPath = `${userId}/${jobId}/slot-${spec.slot}.png`;
        await admin.storage.from("results").upload(resultPath, Buffer.from(result.image), {
          contentType: "image/png",
          upsert: true,
        });

        actualCostUsd += result.estimatedCostUsd;

        await admin
          .from("job_images")
          .update({
            status: "succeeded",
            result_path: resultPath,
            actual_cost_usd: result.estimatedCostUsd,
            latency_ms: result.latencyMs,
            finished_at: new Date().toISOString(),
          })
          .eq("job_id", jobId)
          .eq("slot", spec.slot);
      } catch (error) {
        const classified = classifyError(error);
        // 枚数を返すのはインフラ障害のときだけ（禁止事項③の趣旨）。
        if (classified.kind === "infra") refundImages += 1;

        await admin
          .from("job_images")
          .update({
            status: "failed",
            error_kind: classified.kind,
            error_message: `${classified.code}: ${classified.detail}`.slice(0, 2000),
            finished_at: new Date().toISOString(),
          })
          .eq("job_id", jobId)
          .eq("slot", spec.slot);
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slots.length) }, worker));

  const { count: succeeded } = await admin
    .from("job_images")
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId)
    .eq("status", "succeeded");

  await admin
    .from("jobs")
    .update({
      status: (succeeded ?? 0) > 0 ? "succeeded" : "failed",
      finished_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  await admin.rpc("settle_generation", {
    p_user: userId,
    p_day: usageDay,
    p_est_cost: reservedCostUsd,
    p_actual_cost: actualCostUsd,
    p_refund_images: refundImages,
  });
}
