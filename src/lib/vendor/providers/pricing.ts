/**
 * 単価表。
 *
 * PoC 実装指示書 4 章：
 *   「estimatedCostUsd は各社の公開価格表をアダプタ内に持ち、入力枚数・解像度から算出する。
 *     単価表は 1 箇所にまとめ、更新しやすくしておくこと」
 *
 * ★ 単価に関する数値をこのファイルの外に書いてはならない。
 *   複数箇所に散ると、値上げ・モデル交代のたびに片方だけ直して不整合が起きる。
 *
 * 【この表の性質】
 * 機能仕様書 5 章が明記するとおり、コスト試算は「実測前の概算」である（区分 A-4）。
 * 本表は公開価格表にもとづく見積であり、確定値ではない。
 *
 * 実際の課金はトークン量で決まり、トークン量は画像サイズ・品質・プロンプト長で動く。
 * したがって：
 *   - dry-run の計画表では estimateCost()（表からの見積）を使う
 *   - 実行後は costFromTokenUsage()（API 応答の実トークン数）を優先する
 * どちらを使ったかは costBasis として記録し、A-4 の更新時に見積の精度を検証できるようにする。
 */

import type { ProviderMode, Resolution } from "./types";

/** 単価表の出典と参照日。値を更新したら必ずここも更新する。 */
export const PRICING_PROVENANCE = {
  asOf: "2026-07-30",
  sources: [
    "https://developers.openai.com/api/docs/guides/image-generation",
    "https://ai.google.dev/gemini-api/docs/pricing",
  ],
  note:
    "公開価格表にもとづく概算。機能仕様書 5 章（区分 A-4）のとおり実測前の値である。" +
    "実測値が出たら本表と機能仕様書 5 章の両方を更新すること。",
} as const;

/** OpenAI の品質段階。config/models.json の resolution マッピングが選ぶ。 */
export type OpenAIQuality = "low" | "medium" | "high";

/** 単価表に載っていないモデルを課金経路へ通さないための例外。 */
export class UnknownModelPricingError extends Error {
  constructor(
    public readonly provider: string,
    public readonly modelId: string,
  ) {
    super(
      `[PRICING] 単価が未登録のモデルです: provider=${provider} model=${modelId}\n` +
        `          providers/pricing.ts の PRICE_TABLE へ追記してください。\n` +
        `          コスト不明のまま API を呼ぶと支出の上限管理（F-18 / 指示書 3.4）が機能しません。`,
    );
    this.name = "UnknownModelPricingError";
  }
}

/**
 * トークン単価（USD / 1,000,000 トークン）。
 * 実測トークン数から実コストを算出するために使う。
 */
type TokenRates = {
  textInputPerMillion: number;
  imageInputPerMillion: number;
  imageOutputPerMillion: number;
};

/**
 * 1 枚あたりの概算単価（USD）。dry-run の見積に使う。
 * OpenAI は品質別、Google は解像度別に価格が決まる。
 */
type PerImageEstimate =
  | { kind: "openai-quality"; anchorPixels: number; byQuality: Record<OpenAIQuality, number> }
  | { kind: "google-resolution"; byResolution: Record<Resolution, number> };

type ModelPricing = {
  provider: string;
  modelId: string;
  tokenRates: TokenRates | null;
  perImage: PerImageEstimate;
  /** 入力画像 1 枚あたりの概算（参考画像・マスクを含む）。見積用。 */
  inputImageUsdEach: number;
};

/**
 * ★ 単価表本体。ここが唯一の情報源。
 *
 * OpenAI（gpt-image-2）：
 *   トークン課金。画像出力 $30 / 1M・画像入力 $8 / 1M・テキスト入力 $5 / 1M。
 *   1 枚あたりの概算は 1024×1024 を基準点とし、画素数比で按分する
 *   （出力トークン数は画素数にほぼ比例する）。
 *
 * Google（gemini-3-pro-image）：
 *   解像度ごとに 1 枚あたりの価格が決まる方式。1K と 2K は同額。
 */
const PRICE_TABLE: readonly ModelPricing[] = [
  {
    provider: "openai",
    modelId: "gpt-image-2",
    tokenRates: {
      textInputPerMillion: 5.0,
      imageInputPerMillion: 8.0,
      imageOutputPerMillion: 30.0,
    },
    perImage: {
      kind: "openai-quality",
      anchorPixels: 1024 * 1024,
      byQuality: { low: 0.006, medium: 0.053, high: 0.211 },
    },
    inputImageUsdEach: 0.003,
  },
  {
    provider: "google",
    modelId: "gemini-3-pro-image",
    // 1 枚単価方式のためトークン単価は用いない
    tokenRates: null,
    perImage: {
      kind: "google-resolution",
      byResolution: { "1k": 0.134, "2k": 0.134 },
    },
    inputImageUsdEach: 0.002,
  },
];

/**
 * 文章を返すモデル（画像を作らない）の単価表。
 * メイクの見本の解析（models.ts の MAKEUP_ANALYSIS_MODEL）が使う。
 *
 * gemini-3.8-flash：入力（文字・画像）$0.75 / 1M、出力 $3.75 / 1M
 *   （2026-12-31 まで。2027-01-01 から $1.50 / $7.50 に上がると価格表に予告あり。参照日 2026-09-21）
 */
const TEXT_PRICE_TABLE: readonly {
  provider: string;
  modelId: string;
  inputPerMillion: number;
  outputPerMillion: number;
}[] = [
  { provider: "google", modelId: "gemini-3.8-flash", inputPerMillion: 0.75, outputPerMillion: 3.75 },
];

/**
 * 文章モデルの実コスト（API 応答の usageMetadata から）。
 *
 * @throws {UnknownModelPricingError} 単価未登録のモデル
 */
export function costFromTextUsage(
  provider: string,
  modelId: string,
  usage: { inputTokens: number; outputTokens: number },
): number {
  const pricing = TEXT_PRICE_TABLE.find((p) => p.provider === provider && p.modelId === modelId);
  if (!pricing) throw new UnknownModelPricingError(provider, modelId);
  return round6(
    (usage.inputTokens * pricing.inputPerMillion + usage.outputTokens * pricing.outputPerMillion) /
      1_000_000,
  );
}

function lookup(provider: string, modelId: string): ModelPricing {
  const found = PRICE_TABLE.find((p) => p.provider === provider && p.modelId === modelId);
  if (!found) throw new UnknownModelPricingError(provider, modelId);
  return found;
}

/** 単価表に登録済みかどうか（doctor の診断に使う。throw しない）。 */
export function hasPricing(provider: string, modelId: string): boolean {
  return PRICE_TABLE.some((p) => p.provider === provider && p.modelId === modelId);
}

/** 単価表に載っているモデルの一覧（doctor の表示用）。 */
export function listPricedModels(): readonly { provider: string; modelId: string }[] {
  return PRICE_TABLE.map(({ provider, modelId }) => ({ provider, modelId }));
}

export type CostEstimateInput = {
  provider: string;
  modelId: string;
  mode: ProviderMode;
  resolution: Resolution;
  /** 出力画素数。config/models.json の解像度マッピングから算出して渡す。 */
  outputPixels: number;
  /** OpenAI の品質段階。Google では無視される。 */
  quality: OpenAIQuality;
  /** 参考画像の枚数（元画像・マスクは別に数える）。 */
  referenceCount: number;
};

/**
 * 1 試行あたりの推定コスト（USD）。dry-run の計画表と上限判定に使う。
 *
 * @throws {UnknownModelPricingError} 単価未登録のモデル
 */
export function estimateCost(input: CostEstimateInput): number {
  const pricing = lookup(input.provider, input.modelId);

  let outputUsd: number;
  if (pricing.perImage.kind === "openai-quality") {
    const anchor = pricing.perImage.byQuality[input.quality];
    // 出力トークン数は画素数にほぼ比例するため、基準点からの画素数比で按分する
    outputUsd = anchor * (input.outputPixels / pricing.perImage.anchorPixels);
  } else {
    outputUsd = pricing.perImage.byResolution[input.resolution];
  }

  // 入力画像の枚数：元画像 1 枚 ＋ 参考画像 ＋ inpaint 時のマスク 1 枚
  const inputImageCount = 1 + input.referenceCount + (input.mode === "inpaint" ? 1 : 0);
  const inputUsd = pricing.inputImageUsdEach * inputImageCount;

  return round6(outputUsd + inputUsd);
}

export type TokenUsage = {
  textInputTokens?: number;
  imageInputTokens?: number;
  imageOutputTokens?: number;
};

/**
 * API 応答の実トークン数から実コストを算出する。
 *
 * 応答に usage が含まれる場合はこちらを優先する。表からの見積より正確であり、
 * A-4（コスト試算の確定）の一次情報になる。
 *
 * @returns トークン単価を持たないモデル、または usage が空の場合は null
 */
export function costFromTokenUsage(
  provider: string,
  modelId: string,
  usage: TokenUsage,
): number | null {
  const pricing = lookup(provider, modelId);
  if (!pricing.tokenRates) return null;

  const { textInputTokens = 0, imageInputTokens = 0, imageOutputTokens = 0 } = usage;
  if (textInputTokens === 0 && imageInputTokens === 0 && imageOutputTokens === 0) return null;

  const rates = pricing.tokenRates;
  const usd =
    (textInputTokens * rates.textInputPerMillion +
      imageInputTokens * rates.imageInputPerMillion +
      imageOutputTokens * rates.imageOutputPerMillion) /
    1_000_000;

  return round6(usd);
}

/**
 * 1 セッション相当の推定コスト（指示書 8.1）。
 * ドラフト 6 枚（低解像度）＋ 確定 1 枚（高解像度）が機能仕様書 5.3 の前提。
 */
export function estimateSessionCost(draftUnitUsd: number, finalUnitUsd: number): number {
  return round6(draftUnitUsd * 6 + finalUnitUsd);
}

/** 金額は 6 桁で丸める（$0.000001 単位。合算時の誤差蓄積を避ける）。 */
function round6(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}
