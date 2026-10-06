import type { SupabaseClient } from "@supabase/supabase-js";
import { analyzeMask, renderMaskGuide, sharpMaskCodec, type MaskRegion } from "./mask";
import { buildSemanticRemovalPrompt } from "./removal";
import {
  DEMO_RESOLUTION,
  FUNCTION_BUDGET_MS,
  GOOGLE_CONFIG,
  GROK_CONFIG,
  OPENAI_CONFIG,
  PROVIDER_ENV_KEY,
  callTimeoutMs,
  isProviderName,
  type ProviderName,
} from "./models";
import { OpenAIProvider, pixelsOf } from "./vendor/providers/openai";
import { GoogleProvider } from "./vendor/providers/google";
import { GrokProvider } from "./vendor/providers/grok";
import { classifyError } from "./vendor/providers/errors";
import { estimateCost } from "./vendor/providers/pricing";
import type { ImageProvider, Resolution } from "./vendor/providers/types";
import { buildPrompt, type CategoryInput } from "./vendor/prompts/build";
import { trimForStorage } from "./framing";
import type { CategoryId, MakeupStrength } from "./vendor/prompts/categories";
import type { VariantIndex, VariantStrategy } from "./vendor/prompts/variants";
import { notifyJobFinished, type SlackSettings } from "./slack";

/**
 * 生成の実体。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【2 つのモード】
 *
 *  normal  … 通常加工。メイク強度 弱・中・強 × 各 2 枚 ＝ 6 枚。
 *            OpenAI で試し、失敗したら Google、それでも失敗したら Grok へ回す。
 *
 *  removal … タトゥー・不要物除去。マスク必須・1 枚。
 *            OpenAI はマスク画像そのものを使う（inpaint）。
 *            Google・Grok はマスク画像を入力できないので、目印つき画像と文章で
 *            範囲を伝える（semantic_mask）。
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
 *
 * 【3 番目の回し先：Grok（委託者指示・2026-10-06）】
 *
 * OpenAI → Gemini の両方で拒否された写真を、Grok（xAI grok-imagine-image-2.0）へ回す。
 * 送るのは同一プロンプトであり、上記と同じ理由で禁止事項③には当たらない。
 * 順番は demo_limits の primary_provider → fallback_provider → second_fallback_provider。
 * second_fallback_provider を null にすれば従来どおり 2 段で止まる。
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

/**
 * 通常加工で実際に生成する強度。
 *
 * ★ 委託者指示（2026-09-16）：生成するのは「弱」と「中」の 2 段階 × 各 2 枚 ＝ 4 枚。
 *   「強」のプロンプトは使わない。画面では「中」を「強」と表示する。
 *
 *   プロンプトは一切変えていない。変わったのは「どの段階を作るか」と「画面の呼び名」だけ。
 *   DB の makeup_strength には実際に使った段階（weak / medium）をそのまま残す。
 *   表示名で記録を上書きすると、後から PoC の測定と突き合わせられなくなる。
 *   呼び名の対応は画面側（AppShell の strengthLabel）にだけ置く。
 */
export const GENERATED_STRENGTHS: readonly MakeupStrength[] = ["weak", "medium"];

/** 通常加工のスロット定義：GENERATED_STRENGTHS × 各 2 枚。並び順は確定 UI と同じ。 */
export function buildSlotSpecs(mode: JobMode): SlotSpec[] {
  // 除去は強度の軸を持たない（マスク領域の中身を作り直すだけ）。1 枚だけ。
  if (mode === "removal") {
    return [{ slot: 0, makeupStrength: "medium", variant: 1 }];
  }
  const slots: SlotSpec[] = [];
  for (const strength of GENERATED_STRENGTHS) {
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
  /** fallback でも失敗したときの回し先。null なら 2 段で止める。 */
  secondFallback: ProviderName | null;
  onPolicy: boolean;
};

/** demo_limits の行から FallbackPolicy を組む。列が無い・値が不正なら既定値に落とす。 */
export function fallbackPolicyFrom(
  limits: {
    fallback_enabled?: boolean | null;
    primary_provider?: unknown;
    fallback_provider?: unknown;
    second_fallback_provider?: unknown;
    fallback_on_policy?: boolean | null;
  } | null,
): FallbackPolicy {
  return {
    enabled: limits?.fallback_enabled ?? true,
    primary: isProviderName(limits?.primary_provider) ? limits.primary_provider : "openai",
    fallback: isProviderName(limits?.fallback_provider) ? limits.fallback_provider : "google",
    // ★ 列そのものが無い（マイグレーション前）なら undefined、明示的に「なし」なら null。
    //   null を既定値で上書きしてはならない（管理者が切ったものが勝手に戻る）。
    secondFallback:
      limits?.second_fallback_provider === null
        ? null
        : isProviderName(limits?.second_fallback_provider)
          ? limits.second_fallback_provider
          : "grok",
    onPolicy: limits?.fallback_on_policy ?? true,
  };
}

/**
 * 試す順番。first を先頭に置き、残りは設定の順（primary → fallback → secondFallback）で
 * 重複なく並べる。フォールバックが無効なら first だけ。
 *
 * ★ 個別修正・確定では first に「入力画像を作ったプロバイダ」を渡す（見た目の連続性のため）。
 */
export function providerOrder(
  policy: FallbackPolicy,
  first: ProviderName = policy.primary,
): ProviderName[] {
  if (!policy.enabled) return [first];
  const order: ProviderName[] = [];
  for (const name of [first, policy.primary, policy.fallback, policy.secondFallback]) {
    if (name && !order.includes(name)) order.push(name);
  }
  return order;
}

export type Attempt = { provider: ProviderName; method: "inpaint" | "semantic_mask" | "instruct" };

/**
 * 除去（マスク）の試行順。
 *
 * OpenAI だけがマスク画像を受け取れる（inpaint）。それ以外は semantic_mask。
 * ★ 後者は前者の代替ではない。「マスク外は不変」の保証が無いので、
 *   どちらで作ったかを edit_method に必ず残す。
 *
 * @param first 先頭に置く試行（確定処理ではドラフトを作った組み合わせ）
 */
export function removalAttempts(
  policy: FallbackPolicy,
  removalFallback: boolean,
  first: Attempt = { provider: "openai", method: "inpaint" },
): Attempt[] {
  const methodOf = (provider: ProviderName): Attempt["method"] =>
    provider === "openai" ? "inpaint" : "semantic_mask";
  if (!(removalFallback && policy.enabled)) return [first];
  // 除去は OpenAI（inpaint）を基準に、残りを設定の順で並べる
  const rest = providerOrder(policy, "openai").filter((name) => name !== first.provider);
  return [first, ...rest.map((provider) => ({ provider, method: methodOf(provider) }))];
}

/** 先に試して失敗したプロバイダ。 */
export type FailedAttempt = { provider: ProviderName; kind: string; detail: string };

/**
 * フォールバックの経緯を DB の列へ落とす。
 *
 * attempted_* は「最初に失敗したプロバイダ」（＝通常は OpenAI）を持つ。
 * 2 段のときと意味を変えないためである（OpenAI の拒否率を数えるのに使っている）。
 * 3 段目まで行ったときの全経緯は attempt_trail に順に残す。
 */
export function attemptColumns(trail: FailedAttempt[]) {
  const first = trail[0];
  return {
    attempted_provider: first?.provider ?? null,
    attempted_error_kind: first?.kind ?? null,
    attempted_error_message: first ? first.detail.slice(0, 2000) : null,
    attempt_trail: trail.map((a) => ({
      provider: a.provider,
      kind: a.kind,
      detail: a.detail.slice(0, 500),
    })),
  };
}

/** 関数の残り時間が足りず、次のプロバイダを呼ばずに打ち切ったときの記録。 */
export const TIME_BUDGET_EXHAUSTED = {
  kind: "infra" as const,
  code: "time_budget_exhausted",
  detail:
    "関数の実行時間（300 秒）の残りが足りないため、次のプロバイダを呼ばずに打ち切りました。",
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
  referenceCount = 0,
): number {
  const mode = requiresMask ? "inpaint" : referenceCount > 0 ? "reference" : "instruct";
  if (provider === "openai") {
    const setting = OPENAI_CONFIG.resolution[resolution];
    return estimateCost({
      provider: "openai",
      modelId: OPENAI_CONFIG.modelId,
      mode,
      resolution,
      outputPixels: pixelsOf(setting.size),
      quality: setting.quality,
      referenceCount,
    });
  }
  if (provider === "grok") {
    return estimateCost({
      provider: "grok",
      modelId: GROK_CONFIG.modelId,
      // Grok はマスクを受け取らない。除去では目印つき画像 1 枚を参考画像として送る
      mode: mode === "inpaint" ? "reference" : mode,
      resolution,
      outputPixels: GROK_CONFIG.resolution[resolution].pixels,
      quality: "medium",
      referenceCount: mode === "inpaint" ? Math.max(1, referenceCount) : referenceCount,
    });
  }
  return estimateCost({
    provider: "google",
    modelId: GOOGLE_CONFIG.modelId,
    mode,
    resolution,
    outputPixels: GOOGLE_CONFIG.resolution[resolution].pixels,
    quality: "medium",
    referenceCount,
  });
}

/**
 * 予約に使う 1 枚あたりの単価。
 *
 * ★ フォールバックすると 1 枚で最大 3 回呼ぶが、拒否は課金されない。
 *   実費は「最後に成功した 1 回ぶん」になる。
 *   ただし予約の時点でどれが成功するか分からないので、
 *   **いちばん高いもの**で押さえておく。実額は settle_generation で差し替える。
 */
export function reservationUnitUsd(
  policy: FallbackPolicy,
  requiresMask: boolean,
  resolution: Resolution = DEMO_RESOLUTION,
  referenceCount = 0,
): number {
  return Math.max(
    ...providerOrder(policy).map((name) =>
      estimateOne(name, requiresMask, resolution, referenceCount),
    ),
  );
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
  if (name === "grok") {
    return keys.grok ? new GrokProvider(GROK_CONFIG, keys.grok) : null;
  }
  return keys.google ? new GoogleProvider(GOOGLE_CONFIG, keys.google) : null;
}

export type ProviderKeys = Record<ProviderName, string | undefined>;

/** 環境変数から API キーを読む。未設定のプロバイダはチェーンから外れる。 */
export function providerKeysFromEnv(): ProviderKeys {
  return {
    openai: process.env[PROVIDER_ENV_KEY.openai],
    google: process.env[PROVIDER_ENV_KEY.google],
    grok: process.env[PROVIDER_ENV_KEY.grok],
  };
}

type ProcessInput = {
  admin: SupabaseClient;
  jobId: string;
  userId: string;
  usageDay: string;
  sourcePng: Buffer;
  maskPng: Buffer | null;
  /**
   * 参考画像（種別 B・仕様書 4.2.5）。カテゴリの並び順で連ねる。
   * 1 枚でもあれば mode を "reference" にして、そのまま API へ送る。
   */
  references: Buffer[];
  selection: Selection;
  slots: SlotSpec[];
  mode: JobMode;
  policy: FallbackPolicy;
  /** 除去モードのときの追加情報（Gemini・Grok へ semantic masking で回すために使う）。 */
  removal: {
    /** 除去対象の種類（凍結済みカタログの ID）。 */
    templateId: string;
    freeText: string | null;
    /** OpenAI が失敗したら Gemini・Grok へ回すか。 */
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
    references,
    selection,
    slots,
    mode,
    policy,
    removal,
    reservedCostUsd,
    slack,
  } = input;

  const keys = providerKeysFromEnv();
  // ★ processJob は after() の中で動く。関数上限（300 秒）は要求の受付から数えるので、
  //   ここを起点にした締め切りは FUNCTION_BUDGET_MS の分だけ余裕を持たせてある。
  const deadline = Date.now() + FUNCTION_BUDGET_MS;

  // ── どのプロバイダを、どの方式で試すか ──
  //
  // 除去（マスク）の扱いが通常加工と違う：
  //   OpenAI        … inpaint。マスク画像そのものを渡すので、マスク外の不変が仕組みで担保される
  //   Google / Grok … マスク画像を渡せない。目印つき画像と文章で範囲を伝える（semantic masking）
  //
  // ★ 後者は前者の代替ではない。「マスク外は不変」の保証が無いので、
  //   どれで作ったかを edit_method に必ず残す。
  const chain: Attempt[] =
    mode === "removal"
      ? removalAttempts(policy, removal?.fallbackEnabled ?? false)
      : providerOrder(policy).map((provider) => ({ provider, method: "instruct" as const }));

  const usable = chain.filter((attempt) => createProvider(attempt.provider, keys) !== null);

  if (usable.length === 0) {
    const missing = chain.map((a) => PROVIDER_ENV_KEY[a.provider]).join(" / ");
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

  // 参考画像があれば reference モード（元画像＋参考画像を連ねて送る）。仕様書 4.2.5。
  const editMode = selection.requiresMask
    ? "inpaint"
    : references.length > 0
      ? "reference"
      : "instruct";
  const referenceBytes = references.map((buffer) => new Uint8Array(buffer));

  // semantic masking で使う材料。除去モードで Gemini・Grok を試すときだけ作る。
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

  // semantic masking はマスク画像を渡せないので、目印つき画像と文章で伝える。
  // 材料が作れなかった場合はその試行を外す（黙って別物を送らない）。
  // ★ ループの途中で飛ばすと「最後の試行」の判定がずれ、行が running のまま残る。先に外す。
  const runnable = usable.filter(
    (attempt) =>
      attempt.method !== "semantic_mask" || (maskGuide !== null && maskRegion !== null && removal !== null),
  );

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

    // 先に試して失敗したプロバイダを順に覚えておく（OpenAI の拒否率を後から数えるため）
    const trail: FailedAttempt[] = [];

    for (let index = 0; index < runnable.length; index += 1) {
      const { provider: name, method } = runnable[index]!;
      const provider = createProvider(name, keys)!;
      const isLast = index === runnable.length - 1;

      const semantic =
        method === "semantic_mask" && maskRegion && removal
          ? buildSemanticRemovalPrompt({
              templateId: removal.templateId,
              freeText: removal.freeText,
              region: maskRegion,
            })
          : null;

      // ★ 関数の残り時間が足りなければ呼ばない。呼んでも途中で関数ごと落ち、
      //   行が running のまま・予約が精算されないまま残る。
      const timeoutMs = callTimeoutMs(deadline);
      if (timeoutMs === null) {
        // こちらの都合で打ち切ったので枚数は返す
        refundImages += 1;
        await admin
          .from("job_images")
          .update({
            status: "failed",
            provider: trail.at(-1)?.provider ?? name,
            edit_method: method,
            ...attemptColumns(trail),
            error_kind: TIME_BUDGET_EXHAUSTED.kind,
            error_message: `${TIME_BUDGET_EXHAUSTED.code}: ${TIME_BUDGET_EXHAUSTED.detail}`,
            finished_at: new Date().toISOString(),
          })
          .eq("job_id", jobId)
          .eq("slot", spec.slot);
        return;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
                referenceImages: referenceBytes.length > 0 ? referenceBytes : undefined,
                prompt: built.text,
                resolution: DEMO_RESOLUTION,
                variantSeedHint: built.variantSeedHint,
              },
          controller.signal,
        );

        const resultPath = `${userId}/${jobId}/slot-${spec.slot}.png`;
        // モデルが比を合わせるために足した無地の帯を切る（委託者指示・2026-09-30）
        const resultPng = await trimForStorage(result.image, `slot-${spec.slot}`);
        await admin.storage.from("results").upload(resultPath, resultPng, {
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
            ...attemptColumns(trail),
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
          trail.push({ provider: name, kind: classified.kind, detail: classified.detail });
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
            ...attemptColumns(trail),
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

    // ここへ来るのは、試せる組み合わせが 1 つも無かったときだけ
    // （OpenAI のキーが無く、除去の目印つき画像も作れなかった）。こちらの都合なので枚数は返す。
    refundImages += 1;
    await admin
      .from("job_images")
      .update({
        status: "failed",
        ...attemptColumns(trail),
        error_kind: "infra",
        error_message: "試せるプロバイダがありません（除去の目印つき画像を作れませんでした）",
        finished_at: new Date().toISOString(),
      })
      .eq("job_id", jobId)
      .eq("slot", spec.slot);
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
