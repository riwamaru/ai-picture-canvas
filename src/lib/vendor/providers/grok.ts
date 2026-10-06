/**
 * xAI（Grok / Imagine API）アダプタ。
 *
 * ★ PoC（../poc/providers/grok.ts）からの移植。差分は import の拡張子と
 *   registry.ts の型をこのファイル内へ持ってきたことだけ。挙動は同一に保つ。
 *   デモでは OpenAI → Gemini でも拒否されたときの 3 番目の回し先として使う（委託者指示・2026-10-06）。
 *
 * 委託者指示・2026-09-30：「Grok の API で一連の PoC を回したい」。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【対応モード】
 *
 *   instruct  … 対応（元画像 1 枚 ＋ 指示文）
 *   reference … 対応（元画像 ＋ 参考画像。ただし合計 5 枚まで。下記の上限に注意）
 *   inpaint   … **非対応**
 *
 * inpaint が非対応である理由：
 *   2026-09-30 時点の xAI ドキュメント（/docs/guides/image-generations）に
 *   マスク画像を渡すパラメータが存在しない。/v1/images/edits の入力は
 *   `prompt` と `image`（最大 5 枚）だけである。
 *   Gemini と同じく「マスクを渡す口が無い」ため、T-02 の判定には使えない。
 *   S-12（テキスト指示だけで除去）なら instruct として測れる。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【実測で確定した事項（2026-09-30・実 API で確認）】
 *
 * 追加当初はドキュメント読解のみで書いていたため、1 枚めのラダーで 2 件の誤りが出た。
 * 以下はすべて実応答で確かめた値である。
 *
 *   ① 応答の形 … `response_format: "b64_json"` は**効く**。
 *      `data[0]` は `{ b64_json, mime_type }` を返す（URL ではない）。
 *      URL で返る経路（`response_format` を送らない場合）も残してあるが、
 *      その host は config の allowedImageHosts に無いと取りに行かない。
 *
 *   ② 複数画像 … **`image`（単数）は 1 枚だけ**で、配列を受け付けない。
 *      配列を渡すと 422 で `image: invalid length 1, expected struct ImageUrl with 3 elements`。
 *      2 枚以上は **`images`（複数形）** にオブジェクトの配列で渡す。実測で 200。
 *
 *   ③ 出力サイズ … 指定しない。2656×3984 の入力に対し **832×1248 の JPEG** が返った。
 *      モデルが決める（Gemini と同じ）。返った寸法は returnedImage に記録する。
 *      入力は 2.38MB（base64 で body 3.18MB）でも 200 だった。サイズ上限には当たっていない。
 *
 *   ④ 課金 … `usage.cost_in_usd_ticks` に入る。**1e10 ticks = $1**。
 *      実測：プロンプトのみ $0.04 ／ 入力画像 1 枚の編集 **$0.07** ／ 2 枚 $0.08。
 *      つまり出力 $0.04 ＋ 入力画像ぶんが乗る。
 *      単価表（providers/pricing.ts）はこの実測値に合わせてある。
 * ═══════════════════════════════════════════════════════════════
 */

import { InfraError, InputError, PolicyError } from "./errors";
import { detectImageType } from "./imageType";
import { pickNumber, pickString, pocFetch, type HttpResponse } from "./http";
import { estimateCost } from "./pricing";
import type { MaskSemantics } from "./maskCodec";
import type { EditRequest, EditResult, ImageProvider, ProviderMode, Resolution } from "./types";

/**
 * 実額か見積かの区別。PoC の registry.ts と同じ値。
 * デモには registry.ts を持ち込んでいないので、ここで定義する。
 */
export type ReportedCostBasis = "usage" | "table";
export type EditResultWithCostBasis = EditResult & { readonly costBasis: ReportedCostBasis };

/** xAI の usage.cost_in_usd_ticks の単位。1e10 ticks = $1（2026-09-30 実測）。 */
const USD_TICKS = 1e10;

export type GrokConfig = {
  endpoint: string;
  modelsEndpoint: string;
  modelId: string;
  modelVersionHint: string;
  supportedModes: readonly ProviderMode[];
  maskSemantics: MaskSemantics;
  /** 記録・見積のための公称画素数。API へは送らない（上記 ③）。 */
  resolution: Record<Resolution, { pixels: number }>;
  /**
   * 1 リクエストに渡せる入力画像の総数（元画像＋参考画像）。
   * 2026-09-30 のドキュメント記載は 5。
   */
  maxInputImages: number;
  /**
   * 生成画像を URL で返された場合にダウンロードを許す host。
   * 空なら URL 応答はエラーにする（応答に現れた任意の host を取りに行かない）。
   */
  allowedImageHosts: readonly string[];
  unsupportedModeNote?: string;
};

export class GrokProvider implements ImageProvider {
  readonly name = "grok";

  constructor(
    private readonly config: GrokConfig,
    private readonly apiKey: string,
  ) {}

  supports(mode: ProviderMode): boolean {
    return this.config.supportedModes.includes(mode);
  }

  async edit(req: EditRequest, signal: AbortSignal): Promise<EditResultWithCostBasis> {
    if (!this.supports(req.mode)) {
      throw new InputError(
        "mode_unsupported",
        "mode",
        this.config.unsupportedModeNote ?? `${this.name} は mode=${req.mode} に対応していません`,
      );
    }
    if (req.mode === "inpaint" || req.maskImage) {
      // supports() で弾かれる想定だが、設定を書き換えられた場合の保険。
      // マスクを渡す口が無いまま inpaint として記録すると、T-02 の判定を汚す。
      throw new InputError(
        "mask_unsupported",
        "maskImage",
        `${this.name} はマスク画像を受け取れません（/v1/images/edits にマスクのパラメータが無い）`,
      );
    }

    const images = [req.baseImage, ...(req.referenceImages ?? [])];
    if (images.length > this.config.maxInputImages) {
      // ★ PoC の参考画像上限（カテゴリ 2 枚・合計 6 枚）は元画像を含めると 7 枚になり、
      //   この API の上限 5 枚を超える。黙って切り捨てると
      //   「参考画像 6 枚で測った」という誤った記録になるため落とす。
      throw new InputError(
        "too_many_input_images",
        "referenceImages",
        `入力画像が ${images.length} 枚で上限 ${this.config.maxInputImages} 枚を超えます` +
          `（元画像 1 枚 ＋ 参考画像 ${images.length - 1} 枚）。\n` +
          `        ${this.name} は 1 リクエストに ${this.config.maxInputImages} 枚までしか渡せません。\n` +
          `        参考画像は ${this.config.maxInputImages - 1} 枚以内にしてシナリオを見直してください。`,
      );
    }

    const payload = images.map((bytes) => ({
      type: "image_url",
      url: `data:${detectImageType(bytes).mime};base64,${Buffer.from(bytes).toString("base64")}`,
    }));

    // ★ 1 枚は image（単数）・2 枚以上は images（複数形）。実測で確かめた形である（上記 ②）。
    //   image に配列を渡すと 422 で落ちる（単数は配列を受け付けない）。
    const body = {
      model: this.config.modelId,
      prompt: req.prompt,
      ...(payload.length === 1 ? { image: payload[0] } : { images: payload }),
      // base64 で受け取る。URL 応答でも動くよう extractImage が両方を見る
      response_format: "b64_json",
      n: 1,
    };

    const startedAt = performance.now();
    const response = await pocFetch(
      this.config.endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      signal,
      this.name,
    );
    const latencyMs = Math.round(performance.now() - startedAt);

    if (!response.ok) throw this.classify(response);

    const image = await this.extractImage(response, signal);
    const cost = this.costOf(response, req);

    return {
      image,
      providerName: this.name,
      modelName: this.config.modelId,
      modelVersion: pickString(response.json, "model") ?? this.config.modelVersionHint,
      estimatedCostUsd: cost.usd,
      latencyMs,
      costBasis: cost.basis,
    };
  }

  /**
   * 実コストを出す。応答に usage があればそれを使い、無ければ単価表の見積を使う。
   *
   * ★ 見積は入力画像も 1 枚ぶん数える（過大評価側。上記 ④）。
   *
   * ★ どちらだったかを basis として返す。金額だけを返すと呼び出し側は
   *   「表の見積と一致するか」で推測するしかなく、Grok では単価表を実測値どおりに
   *   合わせてあるため実額 $0.07 が見積 $0.07 と一致し、実測が必ず見積扱いになる。
   *   （registry.ts の EditResultWithCostBasis の説明を参照）
   */
  private costOf(
    response: HttpResponse,
    req: EditRequest,
  ): { usd: number; basis: ReportedCostBasis } {
    // ★ 実測（2026-09-30）：xAI は usage.cost_in_usd_ticks で実額を返す。1e10 ticks = $1。
    //   例）入力画像 1 枚の編集 = 700000000 ticks = $0.07
    const ticks = pickNumber(response.json, "usage", "cost_in_usd_ticks");
    if (ticks !== null && ticks > 0) {
      return { usd: Math.round((ticks / USD_TICKS) * 1_000_000) / 1_000_000, basis: "usage" };
    }
    // 念のため素直な形も見る（将来フィールド名が変わった場合の保険）
    const billed =
      pickNumber(response.json, "usage", "total_cost_usd") ??
      pickNumber(response.json, "usage", "cost_usd");
    if (billed !== null && billed > 0) return { usd: billed, basis: "usage" };

    return {
      usd: estimateCost({
        provider: this.name,
        modelId: this.config.modelId,
        mode: req.mode,
        resolution: req.resolution,
        outputPixels: this.config.resolution[req.resolution].pixels,
        // Grok は 1 枚単価方式なので quality は単価に影響しない
        quality: "medium",
        referenceCount: req.referenceImages?.length ?? 0,
      }),
      basis: "table",
    };
  }

  /**
   * 応答から画像のバイト列を取り出す。
   *
   * b64_json が入っていればそれを使う。URL しか無い場合は、
   * host が config の allowedImageHosts に載っているときだけ取りに行く。
   */
  private async extractImage(response: HttpResponse, signal: AbortSignal): Promise<Uint8Array> {
    const b64 =
      pickString(response.json, "data", "0", "b64_json") ??
      pickString(response.json, "b64_json") ??
      null;
    if (b64) {
      const bytes = Buffer.from(b64, "base64");
      if (bytes.byteLength === 0) {
        throw new InfraError("empty_image", this.name, "b64_json が空でした");
      }
      return new Uint8Array(bytes);
    }

    const url = pickString(response.json, "data", "0", "url") ?? pickString(response.json, "url");
    if (!url) {
      throw new InfraError(
        "no_image_in_response",
        this.name,
        `応答に画像が含まれていません: ${response.rawBody.slice(0, 500)}`,
      );
    }

    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      throw new InfraError("bad_image_url", this.name, `画像の URL を解釈できません: ${url}`);
    }
    if (!this.config.allowedImageHosts.includes(host)) {
      // ★ 関所①隔離。応答に現れた host を無条件に取りに行かない。
      //   人が host を確認して config へ書き足す、という一手間を挟む。
      throw new InfraError(
        "image_host_not_allowed",
        this.name,
        `生成画像が URL で返りましたが、その host は許可されていません: ${host}\n` +
          `        許可済み: ${this.config.allowedImageHosts.join(", ") || "(なし)"}\n` +
          `        host を確認のうえ src/lib/models.ts の GROK_CONFIG.allowedImageHosts に追記してください。\n` +
          `        （応答に現れた任意の host へ取りに行かない方針のため、自動では追加しません）`,
      );
    }

    const downloaded = await fetch(url, { signal });
    if (!downloaded.ok) {
      throw new InfraError(
        `image_download_${downloaded.status}`,
        this.name,
        `生成画像のダウンロードに失敗しました（HTTP ${downloaded.status}）: ${url}`,
      );
    }
    return new Uint8Array(await downloaded.arrayBuffer());
  }

  /**
   * エラー応答を分類する。
   *
   * xAI は OpenAI 互換の `{ error: { message, type, code } }` 形か、
   * `{ error: "..." , code: n }` の素直な形のどちらかを返す（ドキュメントの例が混在）。
   * どちらでも読めるようにし、分類できないものは原文を保持して InfraError にする
   * （指示書 4 章「分類不能なものは InfraError とし、原文を保持すること」）。
   */
  private classify(response: HttpResponse): Error {
    const message =
      pickString(response.json, "error", "message") ??
      pickString(response.json, "error") ??
      pickString(response.json, "message") ??
      response.rawBody.slice(0, 500);
    const code =
      pickString(response.json, "error", "code") ??
      pickString(response.json, "error", "type") ??
      "";
    const lower = `${code} ${message}`.toLowerCase();

    // --- ポリシー系（拒否。文言を変えて再投入してはならない：禁止事項③） ---
    if (
      response.status === 400 &&
      /content.?polic|safety|moderat|not allowed|violat|rejected|nsfw|sexual|prohibit/.test(lower)
    ) {
      return new PolicyError(code || "content_policy", this.name, null, message);
    }
    // ★ 422 をモデレーション拒否として扱ってはならない（2026-09-30 実測で判明）。
    //   xAI は **リクエストの JSON が不正なとき** 422 を返す：
    //     "Failed to deserialize the JSON body into the target type: image: invalid type: ..."
    //   これを policy に数えると拒否率が過大に出る（provider-error-map.md の警告どおり）。
    //   本文がポリシーに言及していなければ入力の問題として扱う。
    if (response.status === 422) {
      if (/content.?polic|safety|moderat|violat|nsfw|sexual|prohibit/.test(lower)) {
        return new PolicyError(code || "unprocessable", this.name, null, message);
      }
      return new InputError(code || "unprocessable", guessField(message), message);
    }

    // --- 障害系 ---
    if (response.status === 429) {
      // 「待てば直るレート制限」と「残高切れ・割当 0」は対処が違う。混ぜない。
      if (/credit|balance|quota|billing|insufficient/.test(lower)) {
        return new InfraError(
          "quota_not_enabled",
          this.name,
          `${message}\n` +
            `        ★ 待っても解消しません。xAI コンソールで残高・課金設定を確認してください。`,
        );
      }
      return new InfraError("rate_limit", this.name, message);
    }
    if (response.status >= 500) {
      return new InfraError(`http_${response.status}`, this.name, message);
    }
    if (response.status === 401 || response.status === 403) {
      return new InfraError(`http_${response.status}`, this.name, message);
    }

    // --- 入力系 ---
    if (response.status === 400) {
      return new InputError(code || "invalid_request", guessField(message), message);
    }
    if (response.status === 404) {
      return new InputError(
        "model_not_found",
        "modelId",
        `${message}\n` +
          `        src/lib/models.ts の GROK_CONFIG.modelId を確認してください。`,
      );
    }

    return new InfraError(
      code || `http_${response.status}`,
      this.name,
      `分類不能なエラー応答: ${message}`,
    );
  }
}

/** エラー文からどの入力が悪かったかを推測する（記録の手がかり。確定ではない）。 */
function guessField(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("prompt")) return "prompt";
  if (lower.includes("image")) return "baseImage";
  if (lower.includes("model")) return "modelId";
  return "(不明)";
}
