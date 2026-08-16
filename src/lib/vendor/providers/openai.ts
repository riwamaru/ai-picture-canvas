/**
 * OpenAI アダプタ（POST /v1/images/edits）。
 *
 * ★ 本実装へ移設する層。ファイル入出力・ログ・評価処理を書かない（指示書 4 章）。
 * ★ 再試行・フォールバックを実装しない（指示書 4 章）。1 回呼んで失敗したらそのまま返す。
 */

import { InfraError, InputError, PolicyError } from "./errors";
import { detectImageType } from "./imageType";
import { pocFetch, pickNumber, pickString, type HttpResponse } from "./http";
import { NO_MASK_CODEC, type MaskCodec, type MaskSemantics } from "./maskCodec";
import { costFromTokenUsage, estimateCost, type OpenAIQuality } from "./pricing";
import type { EditRequest, EditResult, ImageProvider, ProviderMode, Resolution } from "./types";

export type OpenAIResolutionSetting = {
  /** API の size パラメータ（例 "1024x1536"）。 */
  size: string;
  /** API の quality パラメータ。単価計算にも使う。 */
  quality: OpenAIQuality;
};

export type OpenAIConfig = {
  endpoint: string;
  modelId: string;
  modelVersionHint: string;
  supportedModes: readonly ProviderMode[];
  resolution: Record<Resolution, OpenAIResolutionSetting>;
  maskSemantics: MaskSemantics;
};

/** 送信できる入力画像の上限（公式ドキュメント：画像とマスクの合計 50MB 未満）。 */
const MAX_TOTAL_INPUT_BYTES = 50 * 1024 * 1024;

export class OpenAIProvider implements ImageProvider {
  readonly name = "openai";

  constructor(
    private readonly config: OpenAIConfig,
    private readonly apiKey: string,
    private readonly maskCodec: MaskCodec = NO_MASK_CODEC,
  ) {}

  supports(mode: ProviderMode): boolean {
    return this.config.supportedModes.includes(mode);
  }

  async edit(req: EditRequest, signal: AbortSignal): Promise<EditResult> {
    if (!this.supports(req.mode)) {
      throw new InputError(
        "mode_unsupported",
        "mode",
        `${this.name} は mode=${req.mode} に対応していません`,
      );
    }
    if (req.mode === "inpaint" && !req.maskImage) {
      // 機能仕様書 4.5.1 の入力系。再試行せず、ユーザーへ修正を促す分類。
      throw new InputError("mask_required", "maskImage", "inpaint にはマスク画像が必要です");
    }

    const setting = this.config.resolution[req.resolution];
    const form = new FormData();
    form.append("model", this.config.modelId);
    form.append("prompt", req.prompt);
    form.append("size", setting.size);
    form.append("quality", setting.quality);
    form.append("n", "1");

    // 元画像。reference モードでは参考画像も image[] として連ねる
    // （公式ドキュメントの複数入力画像の指定方法に合わせる）。
    let totalBytes = req.baseImage.byteLength;
    form.append("image[]", ...imagePart(req.baseImage, "base"));
    for (const [index, reference] of (req.referenceImages ?? []).entries()) {
      totalBytes += reference.byteLength;
      form.append("image[]", ...imagePart(reference, `reference-${index + 1}`));
    }

    if (req.maskImage) {
      const mask = await this.prepareMask(req.maskImage);
      totalBytes += mask.byteLength;
      // マスクは PNG（alpha を持たせるため）。念のため実体を検査して送る。
      form.append("mask", ...imagePart(mask, "mask"));
    }

    if (totalBytes >= MAX_TOTAL_INPUT_BYTES) {
      throw new InputError(
        "input_too_large",
        "baseImage",
        `入力画像の合計サイズが上限を超えています（${totalBytes} bytes / 上限 ${MAX_TOTAL_INPUT_BYTES} bytes）`,
      );
    }

    const startedAt = performance.now();
    const response = await pocFetch(
      this.config.endpoint,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
      },
      signal,
      this.name,
    );
    const latencyMs = Math.round(performance.now() - startedAt);

    if (!response.ok) throw this.classify(response);

    const image = this.extractImage(response);

    // 実トークン数が返ってきていればそれを使う（表からの見積より正確で、A-4 の一次情報になる）。
    const actual = costFromTokenUsage(this.name, this.config.modelId, {
      textInputTokens:
        pickNumber(response.json, "usage", "input_tokens_details", "text_tokens") ?? 0,
      imageInputTokens:
        pickNumber(response.json, "usage", "input_tokens_details", "image_tokens") ?? 0,
      imageOutputTokens: pickNumber(response.json, "usage", "output_tokens") ?? 0,
    });

    const estimatedCostUsd =
      actual ??
      estimateCost({
        provider: this.name,
        modelId: this.config.modelId,
        mode: req.mode,
        resolution: req.resolution,
        outputPixels: pixelsOf(setting.size),
        quality: setting.quality,
        referenceCount: req.referenceImages?.length ?? 0,
      });

    return {
      image,
      providerName: this.name,
      modelName: this.config.modelId,
      modelVersion: this.config.modelVersionHint,
      estimatedCostUsd,
      latencyMs,
    };
  }

  /**
   * マスクを API が期待する形式へ変換する。
   *
   * 【未解決事項】公式ドキュメントは alpha チャンネルが編集対象を示すと述べ、
   * 二次情報は「白い領域が再生成される」と述べている。どちらが実際の挙動かは
   * キー入手後の実測（npm run calibrate）でしか確定できない。
   * そのため config/models.json の maskSemantics で切り替えられるようにしてある。
   */
  private async prepareMask(grayscaleMaskPng: Uint8Array): Promise<Uint8Array> {
    switch (this.config.maskSemantics) {
      case "alpha_zero_is_edited":
        return this.maskCodec.toAlphaMask(grayscaleMaskPng);
      case "white_is_edited":
        // 指示書の形式（白=再生成）のまま送る
        return grayscaleMaskPng;
      case "unsupported":
        throw new InputError(
          "mask_unsupported",
          "maskImage",
          `${this.name} の設定が maskSemantics=unsupported です。config/models.json を確認してください`,
        );
    }
  }

  private extractImage(response: HttpResponse): Uint8Array {
    const b64 = pickString(response.json, "data", "0", "b64_json");
    if (b64) return Uint8Array.from(Buffer.from(b64, "base64"));

    // b64_json が無い応答（url 返却など）は救済せず、原文を保持して失敗として記録する。
    // 黙って空画像を返すと「成功したのに画像が無い」記録ができてしまう。
    throw new InfraError(
      "no_image_in_response",
      this.name,
      `応答に画像が含まれていません: ${response.rawBody.slice(0, 500)}`,
    );
  }

  /**
   * OpenAI のエラー応答を 3 分類へ落とす。
   *
   * 分類不能なものは InfraError とし、原文を保持する（指示書 4 章）。
   * 実際に観測したコードは docs/provider-error-map.md へ追記していく。
   */
  private classify(response: HttpResponse): Error {
    const code = pickString(response.json, "error", "code") ?? "";
    const type = pickString(response.json, "error", "type") ?? "";
    const message = pickString(response.json, "error", "message") ?? response.rawBody.slice(0, 500);

    // --- 入力系を先に見る（具体的な code は汎用的な type より強い） ---
    //
    // ★ OpenAI は入力不備でも type=image_generation_user_error を返す。
    //   type だけでポリシー判定すると、単なる画像形式の誤りが
    //   「拒否された」と記録される。そうなると禁止事項③のガード
    //   （文言を変えた再投入の禁止）が誤作動しかねないうえ、
    //   T-04 の拒否率が実態より高く出る。
    //   実際に invalid_image_file が policy として記録された（2026-08-13）。
    if (isInputCode(code)) {
      return new InputError(code, guessField(message), message);
    }

    // --- ポリシー系（モデレーション拒否・安全性判定） ---
    if (isPolicyCode(code) || isPolicyCode(type) || mentionsPolicy(message)) {
      const category =
        pickString(response.json, "error", "moderation_details", "moderation_stage") ??
        firstModerationCategory(response.json);
      return new PolicyError(code || type || "moderation_blocked", this.name, category, message);
    }

    // --- 障害系（レート制限・サーバー障害） ---
    if (response.status === 429) {
      return new InfraError("rate_limit", this.name, message);
    }
    if (response.status >= 500) {
      return new InfraError(`http_${response.status}`, this.name, message);
    }

    // --- 入力系（形式・サイズ・パラメータ） ---
    if (response.status === 400 || response.status === 413 || response.status === 415) {
      if (isInputCode(code) || isInputCode(type) || mentionsInput(message)) {
        return new InputError(
          code || type || `http_${response.status}`,
          guessField(message),
          message,
        );
      }
    }

    // --- 認証・権限は障害系として扱う（PoC では再試行しないので記録だけ残す） ---
    if (response.status === 401 || response.status === 403) {
      return new InfraError(`http_${response.status}`, this.name, message);
    }

    // 分類不能。原文を保持したまま infra とする。
    return new InfraError(
      code || type || `http_${response.status}`,
      this.name,
      `分類不能なエラー応答: ${message}`,
    );
  }
}

// ---- 分類の判定語。docs/provider-error-map.md と対応させる ----

const POLICY_CODES = [
  "moderation_blocked",
  "content_policy_violation",
  "content_filter",
  "safety_violation",
  "image_generation_user_error",
];

const INPUT_CODES = [
  "invalid_image",
  // ★ 実観測（2026-08-13）。JPEG を image/png と偽って送っていたことが原因。
  //   type は image_generation_user_error で返るため、code を優先して判定する。
  "invalid_image_file",
  "invalid_image_format",
  "invalid_image_size",
  "image_too_large",
  "invalid_request_error",
  "unsupported_mimetype",
  "invalid_mask",
  "invalid_size",
  "invalid_quality",
];

function isPolicyCode(value: string): boolean {
  const v = value.toLowerCase();
  return POLICY_CODES.some((c) => v === c || v.includes(c));
}

function isInputCode(value: string): boolean {
  const v = value.toLowerCase();
  return INPUT_CODES.some((c) => v === c || v.includes(c));
}

function mentionsPolicy(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("safety system") ||
    m.includes("content policy") ||
    m.includes("moderation") ||
    m.includes("rejected as a result of our safety")
  );
}

function mentionsInput(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("invalid") ||
    m.includes("must be") ||
    m.includes("unsupported") ||
    m.includes("too large") ||
    m.includes("dimensions")
  );
}

/**
 * エラーメッセージから、ユーザーが直すべき入力項目を推定する。
 *
 * 判定順に意味がある。「size」という語はファイル容量（入力画像の問題）と
 * 出力解像度（パラメータの問題）の両方で使われるため、
 * 容量を示す語を先に見ないと "Maximum combined size is 50MB" を
 * 解像度の問題と誤判定してしまう。
 */
function guessField(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("mask")) return "maskImage";
  // 容量の問題（入力画像を小さくする必要がある）
  if (
    m.includes("too large") ||
    m.includes("file size") ||
    m.includes("combined size") ||
    m.includes("mb") ||
    m.includes("bytes")
  ) {
    return "baseImage";
  }
  // 出力解像度パラメータの問題
  if (m.includes("size") || m.includes("dimension") || m.includes("quality")) return "resolution";
  if (m.includes("prompt")) return "prompt";
  return "baseImage";
}

function firstModerationCategory(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const error = (json as Record<string, unknown>)["error"];
  if (typeof error !== "object" || error === null) return null;
  const details = (error as Record<string, unknown>)["moderation_details"];
  if (typeof details !== "object" || details === null) return null;
  const categories = (details as Record<string, unknown>)["categories"];
  if (Array.isArray(categories)) {
    const first = categories.find((c) => typeof c === "string");
    return typeof first === "string" ? first : null;
  }
  if (typeof categories === "object" && categories !== null) {
    // { violence: true, sexual: false } 形式
    const hit = Object.entries(categories as Record<string, unknown>).find(
      ([, flagged]) => flagged === true,
    );
    return hit ? hit[0] : null;
  }
  return null;
}

// ---- 補助 ----

function toBlob(bytes: Uint8Array, contentType: string): Blob {
  // Uint8Array をそのまま渡すと型が合わないため ArrayBuffer 部分を切り出す
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy], { type: contentType });
}

/** 実形式に合わせて multipart のパートを作る。 */
function imagePart(bytes: Uint8Array, baseName: string): [Blob, string] {
  const { mime, ext } = detectImageType(bytes);
  return [toBlob(bytes, mime), `${baseName}.${ext}`];
}

/** "1024x1536" → 1572864。単価の按分に使う。 */
export function pixelsOf(size: string): number {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) throw new Error(`size の形式が不正です: ${size}`);
  return Number(match[1]) * Number(match[2]);
}
