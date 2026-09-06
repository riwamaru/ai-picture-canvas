import type { SupabaseClient } from "@supabase/supabase-js";
import { analyzeMask, renderMaskGuide, sharpMaskCodec, type MaskRegion } from "./mask";
import { buildSemanticRemovalPrompt } from "./removal";
import {
  DEMO_RESOLUTION,
  GOOGLE_CONFIG,
  OPENAI_CONFIG,
  PER_CALL_TIMEOUT_MS,
  type ProviderName,
} from "./models";
import { OpenAIProvider, pixelsOf } from "./vendor/providers/openai";
import { GoogleProvider } from "./vendor/providers/google";
import { classifyError } from "./vendor/providers/errors";
import { estimateCost } from "./vendor/providers/pricing";
import type { ImageProvider, Resolution } from "./vendor/providers/types";
import { buildPrompt, type CategoryInput } from "./vendor/prompts/build";
import { MAKEUP_STRENGTHS, type CategoryId, type MakeupStrength } from "./vendor/prompts/categories";
import type { VariantIndex, VariantStrategy } from "./vendor/prompts/variants";
import { notifyJobFinished, type SlackSettings } from "./slack";

/**
 * 生成の実体。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【2 つのモード】
 *
 *  normal  … 通常加工。メイク強度 弱・中・強 × 各 2 枚 ＝ 6 枚。
 *            OpenAI で試し、失敗したら Google へ回す。
 *
 *  removal … タトゥー・不要物除去。マスク必須・1 枚・OpenAI 専用。
 *            Google はマスク画像を入力できないためフォールバック先が無い。
 *
 * 【フォールバックについて】
 *
 * PoC 実装指示書 4 章は再試行・フォールバックを禁じており、
 * 確定 UI も「障害系エラーのみ・ポリシー起因の拒否は再投入しない」と書いている。
 *
 * しかし実測（docs/日報_2026-08-16.md）では OpenAI の失敗は
 * 30/30 すべてポリシー拒否だった。障害系のみに限ると一度も発動しない。
 * 委託者判断により、ポリシー拒否もフォールバック対象とする
 * （demo_limits.fallback_on_policy で切り替えられる）。
 *
 * 禁止事項③が禁じるのは「拒否された内容を **文言を変えて** 再投入すること」であり、
 * 同一プロンプトを別ベンダーへ送ることはこれに当たらない。
 * また拒否は課金されないため、フォールバックによる追加費用は発生しない。
 *
 * ★ 同じプロバイダへの再試行は行わない。ここは指示書 4 章のままである。
 * ═══════════════════════════════════════════════════════════════
 */

/** 同時に走らせる本数。Vercel の関数上限（300 秒）に収めるための値。 */
const CONCURRENCY = 3;

export type JobMode = "normal" | "removal";

export type SlotSpec = {
  slot: number;
  makeupStrength: MakeupStrength;
  variant: VariantIndex;
};

/** 通常加工のスロット定義：弱・中・強 × 各 2 枚。並び順は確定 UI と同じ。 */
export function buildSlotSpecs(mode: JobMode): SlotSpec[] {
  // 除去は強度の軸を持たない（マスク領域の中身を作り直すだけ）。1 枚だけ。
  if (mode === "removal") {
    return [{ slot: 0, makeupStrength: "medium", variant: 1 }];
  }
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

export type FallbackPolicy = {
  enabled: boolean;
  primary: ProviderName;
  fallback: ProviderName;
  onPolicy: boolean;
};

/**
 * 1 枚あたりの推定コスト（USD）。
 *
 * ★ 解像度を引数に取る。ドラフト 6 枚は 1k、確定画像は 2k で、単価が桁違いに違う
 *   （gpt-image-2 の quality:high は 1024x1024 で $0.211、2048x2048 はその 4 倍の画素数）。
 *   既定を DEMO_RESOLUTION にしてあるので、ドラフト側の呼び出しは変わらない。
 */
export function estimateOne(
  provider: ProviderName,
  requiresMask: boolean,
  resolution: Resolution = DEMO_RESOLUTION,
): number {
  const mode = requiresMask ? "inpaint" : "instruct";
  if (provider === "openai") {
    const setting = OPENAI_CONFIG.resolution[resolution];
    return estimateCost({
      provider: "openai",
      modelId: OPENAI_CONFIG.modelId,
      mode,
      resolution,
      outputPixels: pixelsOf(setting.size),
      quality: setting.quality,
      referenceCount: 0,
    });
  }
  return estimateCost({
    provider: "google",
    modelId: GOOGLE_CONFIG.modelId,
    mode,
    resolution,
    outputPixels: GOOGLE_CONFIG.resolution[resolution].pixels,
    quality: "medium",
    referenceCount: 0,
  });
}

/**
 * 予約に使う 1 枚あたりの単価。
 *
 * ★ フォールバックすると 1 枚で最大 2 回呼ぶが、拒否は課金されない。
 *   実費は「最後に成功した 1 回ぶん」になる。
 *   ただし予約の時点でどちらが成功するか分からないので、
 *   **高いほう**で押さえておく。実額は settle_generation で差し替える。
 */
export function reservationUnitUsd(
  policy: FallbackPolicy,
  requiresMask: boolean,
  resolution: Resolution = DEMO_RESOLUTION,
): number {
  const candidates = policy.enabled
    ? [
        estimateOne(policy.primary, requiresMask, resolution),
        estimateOne(policy.fallback, requiresMask, resolution),
      ]
    : [estimateOne(policy.primary, requiresMask, resolution)];
  return Math.max(...candidates);
}

export function buildSlotPrompt(selection: Selection, spec: SlotSpec) {
  return buildPrompt({
    categories: selection.categories,
    makeupStrength: spec.makeupStrength,
    variant: spec.variant,
    variantStrategy: selection.variantStrategy,
  });
}

export function createProvider(name: ProviderName, keys: ProviderKeys): ImageProvider | null {
  if (name === "openai") {
    return keys.openai ? new OpenAIProvider(OPENAI_CONFIG, keys.openai, sharpMaskCodec) : null;
  }
  return keys.google ? new GoogleProvider(GOOGLE_CONFIG, keys.google) : null;
}

export type ProviderKeys = { openai: string | undefined; google: string | undefined };

type ProcessInput = {
  admin: SupabaseClient;
  jobId: string;
  userId: string;
  usageDay: string;
  sourcePng: Buffer;
  maskPng: Buffer | null;
  selection: Selection;
  slots: SlotSpec[];
  mode: JobMode;
  policy: FallbackPolicy;
  /** 除去モードのときの追加情報（Gemini へ semantic masking で回すために使う）。 */
  removal: {
    /** 除去対象の種類（凍結済みカタログの ID）。 */
    templateId: string;
    freeText: string | null;
    /** OpenAI が失敗したら Gemini へ回すか。 */
    fallbackEnabled: boolean;
  } | null;
  /** 予約時に引いた見積の合計。実額との差し替えに使う。 */
  reservedCostUsd: number;
  /** Slack 通知に使う情報。通知が要らない場合は null。 */
  slack: {
    settings: SlackSettings;
    email: string;
    storeName: string | null;
    castName: string | null;
    sessionTitle: string | null;
    /** 画面に出したのと同じ加工内容の説明。 */
    contentJa: string;
  } | null;
};

/**
 * スロットを順次生成し、1 枚できるたびに DB を更新する。
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
    mode,
    policy,
    removal,
    reservedCostUsd,
    slack,
  } = input;

  const keys: ProviderKeys = {
    openai: process.env.OPENAI_API_KEY,
    google: process.env.GEMINI_API_KEY,
  };

  // ── どのプロバイダを、どの方式で試すか ──
  //
  // 除去（マスク）の扱いが通常加工と違う：
  //   OpenAI … inpaint。マスク画像そのものを渡すので、マスク外の不変が仕組みで担保される
  //   Google … マスク画像を渡せない。目印つき画像と文章で範囲を伝える（semantic masking）
  //
  // ★ 後者は前者の代替ではない。「マスク外は不変」の保証が無いので、
  //   どちらで作ったかを edit_method に必ず残す。
  type Attempt = { provider: ProviderName; method: "inpaint" | "semantic_mask" | "instruct" };

  const chain: Attempt[] =
    mode === "removal"
      ? [
          { provider: "openai", method: "inpaint" },
          ...(removal?.fallbackEnabled && policy.enabled
            ? [{ provider: "google" as ProviderName, method: "semantic_mask" as const }]
            : []),
        ]
      : (policy.enabled && policy.fallback !== policy.primary
          ? [policy.primary, policy.fallback]
          : [policy.primary]
        ).map((provider) => ({ provider, method: "instruct" as const }));

  const usable = chain.filter((attempt) => createProvider(attempt.provider, keys) !== null);

  if (usable.length === 0) {
    const missing = chain
      .map((a) => (a.provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY"))
      .join(" / ");
    await admin
      .from("job_images")
      .update({
        status: "failed",
        error_kind: "infra",
        error_message: `${missing} が設定されていません`,
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

  const editMode = selection.requiresMask ? "inpaint" : "instruct";

  // semantic masking で使う材料。除去モードで Gemini を試すときだけ作る。
  let maskRegion: MaskRegion | null = null;
  let maskGuide: Buffer | null = null;
  if (mode === "removal" && maskPng && usable.some((a) => a.method === "semantic_mask")) {
    try {
      maskRegion = await analyzeMask(maskPng);
      maskGuide = await renderMaskGuide(sourcePng, maskPng);
    } catch (error) {
      // 目印が作れなくても OpenAI の inpaint は動く。ここで止めない。
      console.error("[removal] 目印つき画像を作れませんでした:", error);
    }
  }

  let actualCostUsd = 0;
  let refundImages = 0;
  const startedAt = Date.now();
  const queue = [...slots];

  async function runOne(spec: SlotSpec): Promise<void> {
    await admin
      .from("job_images")
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("job_id", jobId)
      .eq("slot", spec.slot);

    const built = buildSlotPrompt(selection, spec);

    // 先に試して失敗したプロバイダを覚えておく（OpenAI の拒否率を後から数えるため）
    let attempted: { provider: ProviderName; kind: string; detail: string } | null = null;

    for (let index = 0; index < usable.length; index += 1) {
      const { provider: name, method } = usable[index]!;
      const provider = createProvider(name, keys)!;
      const isLast = index === usable.length - 1;

      // semantic masking はマスク画像を渡せないので、目印つき画像と文章で伝える。
      // 材料が作れなかった場合はこの試行を飛ばす（黙って別物を送らない）。
      if (method === "semantic_mask" && (!maskGuide || !maskRegion || !removal)) {
        if (isLast) break;
        continue;
      }

      const semantic =
        method === "semantic_mask" && maskRegion && removal
          ? buildSemanticRemovalPrompt({
              templateId: removal.templateId,
              freeText: removal.freeText,
              region: maskRegion,
            })
          : null;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS);

      try {
        const result = await provider.edit(
          semantic
            ? {
                // 元画像 ＋ 目印つき画像の 2 枚。mode は reference（マスクは渡さない）。
                mode: "reference",
                baseImage: new Uint8Array(sourcePng),
                referenceImages: [new Uint8Array(maskGuide!)],
                prompt: semantic.text,
                resolution: DEMO_RESOLUTION,
              }
            : {
                mode: editMode,
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
            provider: name,
            edit_method: method,
            // semantic masking は別のプロンプトを使うので、ハッシュも差し替える
            ...(semantic ? { prompt_hash: semantic.hash } : {}),
            attempted_provider: attempted?.provider ?? null,
            attempted_error_kind: attempted?.kind ?? null,
            attempted_error_message: attempted ? attempted.detail.slice(0, 2000) : null,
            result_path: resultPath,
            actual_cost_usd: result.estimatedCostUsd,
            latency_ms: result.latencyMs,
            finished_at: new Date().toISOString(),
          })
          .eq("job_id", jobId)
          .eq("slot", spec.slot);
        return;
      } catch (error) {
        const classified = classifyError(error);

        // このプロバイダで打ち止めにするか、次へ回すかを決める。
        //   - 最後のプロバイダなら打ち止め
        //   - input（送信内容の不備）は別ベンダーでも直らないので打ち止め
        //   - policy はフォールバックするかを設定で決める
        const canFallback =
          !isLast &&
          classified.kind !== "input" &&
          (classified.kind !== "policy" || policy.onPolicy);

        if (canFallback) {
          attempted = { provider: name, kind: classified.kind, detail: classified.detail };
          clearTimeout(timeout);
          continue;
        }

        // 枚数を返すのはインフラ障害のときだけ（禁止事項③の趣旨）。
        if (classified.kind === "infra") refundImages += 1;

        await admin
          .from("job_images")
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
          .eq("job_id", jobId)
          .eq("slot", spec.slot);
        return;
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  async function worker(): Promise<void> {
    for (;;) {
      const spec = queue.shift();
      if (!spec) return;
      await runOne(spec);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slots.length) }, worker));

  // ── 結果を数える（Slack にも同じ数字を送る） ──
  const { data: finished } = await admin
    .from("job_images")
    .select("status, provider, attempted_provider, error_kind")
    .eq("job_id", jobId);

  const rows = finished ?? [];
  const succeeded = rows.filter((r) => r.status === "succeeded").length;

  await admin
    .from("jobs")
    .update({
      status: succeeded > 0 ? "succeeded" : "failed",
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

  // ── Slack へ生成ログを送る ──
  //
  // ★ 精算のあとに送る。先に送ると「本日累計」が生成前の値になり、
  //   通知の数字と実際の使用量がずれる。
  // ★ 通知の失敗で生成結果を失わせない。例外は notifyJobFinished 側で握る。
  if (slack) {
    const byProvider: Partial<Record<ProviderName, number>> = {};
    for (const row of rows) {
      if (row.status !== "succeeded" || !row.provider) continue;
      const name = row.provider as ProviderName;
      byProvider[name] = (byProvider[name] ?? 0) + 1;
    }

    // 精算後の当日累計を読み直す（見積ではなく実額を出すため）
    const { data: today } = await admin
      .from("usage_daily")
      .select("images, cost_usd")
      .eq("day", usageDay)
      .maybeSingle();

    await notifyJobFinished(admin, slack.settings, {
      jobId,
      email: slack.email,
      mode,
      storeName: slack.storeName,
      castName: slack.castName,
      sessionTitle: slack.sessionTitle,
      contentJa: slack.contentJa,
      requested: slots.length,
      succeeded,
      policyRejected: rows.filter((r) => r.error_kind === "policy").length,
      inputRejected: rows.filter((r) => r.error_kind === "input").length,
      infraFailed: rows.filter((r) => r.error_kind === "infra").length,
      byProvider,
      fellBack: rows.filter((r) => r.status === "succeeded" && r.attempted_provider).length,
      actualCostUsd,
      elapsedMs: Date.now() - startedAt,
      todayImages: today?.images ?? 0,
      todayCostUsd: Number(today?.cost_usd ?? 0),
    });
  }
}
