/**
 * Google アダプタ（generateContent）。
 *
 * ★ 本実装へ移設する層。ファイル入出力・ログ・評価処理を書かない（指示書 4 章）。
 * ★ 再試行・フォールバックを実装しない（指示書 4 章）。
 *
 * 【重要：inpaint に対応しない】
 * 2026-06-30 に imagen-3.0-capability-001 が停止し、Gemini API に
 * マスク画像を入力できるモデルは存在しない（会話による semantic masking のみ）。
 * よって supports("inpaint") は false を返し、ランナー側が「対応なし」として記録する。
 * この結果、T-02（マスク編集の成立性）は OpenAI 単独でしか判定できない。
 *
 * 【なぜ generateContent を既定にするか】
 * ① imageConfig.imageSize が "1K" / "2K" にそのまま対応し Resolution 型と噛み合う
 * ② 拒否の表面（promptFeedback.blockReason / candidates[].finishReason）が文書化されている
 *    これは T-04 の拒否率計測に不可欠で、拒否を「原因不明の失敗」にしてしまうと計測できない
 */

import { InfraError, InputError, PolicyError } from "./errors";
import { detectImageType } from "./imageType";
import { pocFetch, pickString, type HttpResponse } from "./http";
import type { MaskSemantics } from "./maskCodec";
import { estimateCost } from "./pricing";
import type { EditRequest, EditResult, ImageProvider, ProviderMode, Resolution } from "./types";

export type GoogleResolutionSetting = {
  /** API の imageConfig.imageSize。大文字の "1K" / "2K"（小文字は受け付けられない）。 */
  imageSize: string;
  /** 単価按分と記録のための想定画素数。 */
  pixels: number;
};

export type GoogleConfig = {
  /** {modelId} を含むテンプレート。 */
  endpointTemplate: string;
  modelId: string;
  modelVersionHint: string;
  supportedModes: readonly ProviderMode[];
  resolution: Record<Resolution, GoogleResolutionSetting>;
  maskSemantics: MaskSemantics;
  /** supports() が false を返す理由。記録と診断表示に使う。 */
  unsupportedModeNote?: string;
};

export class GoogleProvider implements ImageProvider {
  readonly name = "google";

  constructor(
    private readonly config: GoogleConfig,
    private readonly apiKey: string,
  ) {}

  supports(mode: ProviderMode): boolean {
    return this.config.supportedModes.includes(mode);
  }

  /** supports() が false のときの理由（ランナーが「対応なし」の記録に添える）。 */
  unsupportedReason(mode: ProviderMode): string | null {
    if (this.supports(mode)) return null;
    return this.config.unsupportedModeNote ?? `${this.name} は mode=${mode} に対応していません`;
  }

  async edit(req: EditRequest, signal: AbortSignal): Promise<EditResult> {
    if (!this.supports(req.mode)) {
      throw new InputError(
        "mode_unsupported",
        "mode",
        this.unsupportedReason(req.mode) ?? `mode=${req.mode} 非対応`,
      );
    }

    const setting = this.config.resolution[req.resolution];
    const url = this.config.endpointTemplate.replace("{modelId}", this.config.modelId);

    // 元画像 → 参考画像 → 指示文の順で並べる。
    // 画像を先に置くのは「これらを編集せよ」という関係を明示するため。
    const parts: unknown[] = [
      {
        inline_data: {
          // ★ 実体に合わせる。常に image/png と宣言していたため
          //   JPEG 素材で拒否されていた（2026-08-13）。
          mime_type: detectImageType(req.baseImage).mime,
          data: toBase64(req.baseImage),
        },
      },
    ];
    for (const reference of req.referenceImages ?? []) {
      parts.push({
        inline_data: {
          mime_type: detectImageType(reference).mime,
          data: toBase64(reference),
        },
      });
    }
    parts.push({ text: req.prompt });

    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: { imageSize: setting.imageSize },
      },
    };

    const startedAt = performance.now();
    const response = await pocFetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // キーは URL クエリではなくヘッダで送る（URL はログ・履歴に残りやすい）
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(body),
      },
      signal,
      this.name,
    );
    const latencyMs = Math.round(performance.now() - startedAt);

    if (!response.ok) throw this.classify(response);

    // HTTP 200 でも拒否されている場合がある（blockReason / finishReason）。
    // ここを見落とすと「成功したが画像が無い」記録になり、拒否率が測れなくなる。
    const refusal = this.detectRefusal(response);
    if (refusal) throw refusal;

    const image = this.extractImage(response);

    return {
      image,
      providerName: this.name,
      modelName: this.config.modelId,
      modelVersion: pickString(response.json, "modelVersion") ?? this.config.modelVersionHint,
      estimatedCostUsd: estimateCost({
        provider: this.name,
        modelId: this.config.modelId,
        mode: req.mode,
        resolution: req.resolution,
        outputPixels: setting.pixels,
        // Google は解像度別の 1 枚単価方式なので quality は単価に影響しない
        quality: "medium",
        referenceCount: req.referenceImages?.length ?? 0,
      }),
      latencyMs,
    };
  }

  /**
   * HTTP 200 で返る拒否を検出する。
   *
   * - promptFeedback.blockReason … 入力段で弾かれた
   * - candidates[0].finishReason … 生成中に安全性判定で止まった
   *   （IMAGE_SAFETY / PROHIBITED_CONTENT / SAFETY / BLOCKLIST など）
   */
  private detectRefusal(response: HttpResponse): PolicyError | null {
    const blockReason = pickString(response.json, "promptFeedback", "blockReason");
    if (blockReason) {
      return new PolicyError(
        `block_${blockReason.toLowerCase()}`,
        this.name,
        blockReason,
        `入力が安全性判定で拒否されました: blockReason=${blockReason}`,
      );
    }

    const finishReason = pickString(response.json, "candidates", "0", "finishReason");
    if (finishReason && REFUSAL_FINISH_REASONS.includes(finishReason.toUpperCase())) {
      return new PolicyError(
        `finish_${finishReason.toLowerCase()}`,
        this.name,
        finishReason,
        `生成が安全性判定で中断されました: finishReason=${finishReason}`,
      );
    }
    return null;
  }

  private extractImage(response: HttpResponse): Uint8Array {
    const parts = pickParts(response.json);
    for (const part of parts) {
      if (typeof part !== "object" || part === null) continue;
      const record = part as Record<string, unknown>;
      // REST は camelCase（inlineData）で返すが、snake_case の可能性も許容する
      const inline = (record["inlineData"] ?? record["inline_data"]) as
        Record<string, unknown> | undefined;
      const data = inline?.["data"];
      if (typeof data === "string" && data.length > 0) {
        return Uint8Array.from(Buffer.from(data, "base64"));
      }
    }
    // ── 画像が無い理由を finishReason から特定する ──
    //
    // ★ HTTP 200 なのに画像が無いケースは 1 種類ではない。
    //   2026-08-16 に IMAGE_OTHER を実測した。
    //
    //     finishReason: "IMAGE_OTHER"
    //     finishMessage: "Unable to show the generated image. The model could not
    //                     generate the image based on the prompt provided.
    //                     You will not be charged for this request."
    //
    //   これを一律 no_image_in_response（応答が壊れている）として記録すると、
    //   「モデルが生成しなかった」ことと「応答の形式が想定外」ことが混ざり、
    //   T-04 で区別できなくなる。finishReason を code に残す。
    //
    // ★ 安全性判定による中断は detectRefusal が先に PolicyError として扱う。
    //   ここへ来るのは、それ以外の理由で画像が無かった場合である。
    const finishReason = pickString(response.json, "candidates", "0", "finishReason");
    const finishMessage = pickString(response.json, "candidates", "0", "finishMessage");

    // 正常終了を示す値は「画像が無い理由」ではない（応答の形式異常として扱う）
    if (finishReason && !NORMAL_FINISH_REASONS.includes(finishReason.toUpperCase())) {
      throw new InfraError(
        `finish_${finishReason.toLowerCase()}`,
        this.name,
        `画像が生成されませんでした: finishReason=${finishReason}` +
          (finishMessage ? `\n        ${finishMessage}` : "") +
          `\n        応答全文: ${response.rawBody.slice(0, 500)}`,
      );
    }

    // finishReason も無い＝応答の形式が想定外。救済せず原文を保持して失敗とする。
    // 黙って空画像を返すと「成功したのに画像が無い」記録ができてしまう。
    throw new InfraError(
      "no_image_in_response",
      this.name,
      `応答に画像が含まれていません: ${response.rawBody.slice(0, 500)}`,
    );
  }

  private classify(response: HttpResponse): Error {
    const status = pickString(response.json, "error", "status") ?? "";
    const message = pickString(response.json, "error", "message") ?? response.rawBody.slice(0, 500);

    // --- ポリシー系 ---
    if (
      status === "PERMISSION_DENIED" &&
      (message.toLowerCase().includes("safety") || message.toLowerCase().includes("policy"))
    ) {
      return new PolicyError(status.toLowerCase(), this.name, null, message);
    }
    if (mentionsPolicy(message)) {
      return new PolicyError(status.toLowerCase() || "policy", this.name, null, message);
    }

    // --- 障害系 ---
    if (response.status === 429 || status === "RESOURCE_EXHAUSTED") {
      // ★ 429 には性質の違う 2 つが混ざる。区別しないと対処が分からない。
      //
      //   ① 本当のレート制限        → 待てば解消する
      //   ② そのモデルの割当が 0 件  → **待っても永久に解消しない**
      //                                （無料枠では使えないモデル。課金の有効化が必要）
      //
      // 実際に ② を「rate_limit」と記録し、待てば直ると誤解しかけた（2026-08-13）。
      if (mentionsZeroQuota(message)) {
        return new InfraError(
          "quota_not_enabled",
          this.name,
          `${message}\n` +
            `        ★ 待っても解消しません。このモデルは無料枠の割当が 0 件です。\n` +
            `        Google AI Studio / Google Cloud で課金を有効にしてください。`,
        );
      }
      return new InfraError("rate_limit", this.name, message);
    }
    if (response.status >= 500 || status === "UNAVAILABLE" || status === "INTERNAL") {
      return new InfraError(`http_${response.status}`, this.name, message);
    }

    // --- 入力系 ---
    if (response.status === 400 && status === "INVALID_ARGUMENT") {
      return new InputError("invalid_argument", guessField(message), message);
    }

    if (response.status === 401 || response.status === 403) {
      return new InfraError(`http_${response.status}`, this.name, message);
    }

    return new InfraError(
      status.toLowerCase() || `http_${response.status}`,
      this.name,
      `分類不能なエラー応答: ${message}`,
    );
  }
}

/**
 * 正常終了を示す finishReason。
 *
 * これらが付いていて画像が無い場合は「モデルが生成しなかった」ではなく
 * 「応答の形式が想定外」である。区別しないと原因を追えない。
 */
const NORMAL_FINISH_REASONS = ["STOP", "MAX_TOKENS", "FINISH_REASON_UNSPECIFIED"];

/** 安全性判定による中断を示す finishReason。 */
const REFUSAL_FINISH_REASONS = [
  "IMAGE_SAFETY",
  "PROHIBITED_CONTENT",
  "SAFETY",
  "BLOCKLIST",
  "SPII",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
];

function pickParts(json: unknown): unknown[] {
  if (typeof json !== "object" || json === null) return [];
  const candidates = (json as Record<string, unknown>)["candidates"];
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const first = candidates[0];
  if (typeof first !== "object" || first === null) return [];
  const content = (first as Record<string, unknown>)["content"];
  if (typeof content !== "object" || content === null) return [];
  const parts = (content as Record<string, unknown>)["parts"];
  return Array.isArray(parts) ? parts : [];
}

/**
 * 「そのモデルの割当が 0 件」を示す文面か。
 *
 * 無料枠では使えないモデルを呼ぶと 429 で
 *   Quota exceeded for metric: ...free_tier_requests, limit: 0
 * が返る。待っても解消しないので、レート制限と区別する。
 */
function mentionsZeroQuota(message: string): boolean {
  const m = message.toLowerCase();
  const zeroLimit = /limit:\s*0\b/.test(m);
  const freeTier = m.includes("free_tier") || m.includes("free tier");
  const billing = m.includes("plan and billing") || m.includes("billing details");
  return zeroLimit || (freeTier && billing);
}

function mentionsPolicy(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("safety") ||
    m.includes("blocked") ||
    m.includes("prohibited") ||
    m.includes("content policy")
  );
}

function guessField(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("imagesize") || m.includes("image_size")) return "resolution";
  if (m.includes("inline") || m.includes("mime")) return "baseImage";
  if (m.includes("token") || m.includes("prompt")) return "prompt";
  return "baseImage";
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
