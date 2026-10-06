import type { OpenAIConfig } from "./vendor/providers/openai";
import type { GoogleConfig } from "./vendor/providers/google";
import type { GrokConfig } from "./vendor/providers/grok";

/**
 * モデル設定。PoC の config/models.json と同じ値を持つ。
 *
 * ★ PoC 側で maskSemantics などが実測で確定したら、こちらも同じ値へ揃えること。
 *   値が食い違うと「ローカルでは通るのにデモでは通らない」が起きる。
 *
 * ★ デモは 1k 固定。2k（quality: high）は 1 枚 $0.2 を超えるため、
 *   任意の人が押せるボタンに割り当てるべきではない。
 */
export const OPENAI_CONFIG: OpenAIConfig = {
  endpoint: "https://api.openai.com/v1/images/edits",
  modelId: "gpt-image-2",
  // 2026-10-06 に実 API で確認した（models list に gpt-image-2 が実在し、
  // /v1/images/edits が下記 size をそのまま返す）。スナップショットは gpt-image-2-2026-04-21。
  modelVersionHint: "verified-2026-10-06/gpt-image-2-2026-04-21",
  supportedModes: ["instruct", "reference", "inpaint"],
  /**
   * ★ 1k と 2k は必ず同じ縦横比にする（2026-10-06 修正）。
   *
   * 【なぜ】
   * 確定処理は「選ばれた 1 枚を解像度だけ上げて作り直す」（仕様書 5.4 の 2 段階生成）。
   * ドラフトは 1k・確定は 2k で呼ぶため、ここの比が違うと
   * **承認された構図とは別の構図が確定画像になる**。
   * 以前は 1k=1024x1536（2:3 縦）に対して 2k=2048x2048（1:1 正方）だったため、
   * 2:3 で選んだ構図が 1:1 の枠へ入れ直されていた。
   * モデルは足りない側に無地の帯を足すので、委託者から報告された「余白」の出どころになりうる
   * （framing.ts の切り落としは帯を消すだけで、構図の違いは戻せない）。
   *
   * 2k は 1k を縦横そのまま 2 倍した 2048x3072 にしてある。比が一致し、
   * 「同じ構図を高解像度で」という仕様の言葉どおりになる。
   *
   * 【size に使える値（2026-10-06 実測）】
   * 公式ドキュメントの規則どおり：16 の倍数・長辺 3840px 以内・比は 1:3〜3:1・
   * 総画素数 655,360〜8,294,400。2048x3072 は 6,291,456 画素で範囲内。
   * 1024x1536 / 1536x1024 / 2048x2048 / 2048x3072 / 1632x2448 / 1376x2064 /
   * 2560x1440 / 3840x2160 / 2160x3840 / auto がいずれも通り、要求した size が
   * そのまま返ることを確認した（委託者の案 1365x2048 は 1365 が 16 の倍数でないため通らない）。
   *
   * 【費用】正方から縦長へ変えても高くならない。むしろ安い。
   * 出力トークン数は画素数に比例しない（実測・gray 64x64 を編集）：
   *   quality=low    2048x2048 397 tok / 2048x3072 365 tok
   *   quality=medium 2048x2048 3,568 tok / 2048x3072 3,184 tok
   * 画素数は 1.5 倍なのにトークンは約 1 割少ない。
   * ★ pricing.ts の見積は「画素数に比例」と仮定しているため過大に出る（README に記載）。
   */
  resolution: {
    "1k": { size: "1024x1536", quality: "medium" },
    "2k": { size: "2048x3072", quality: "high" },
  },
  maskSemantics: "alpha_zero_is_edited",
};

/**
 * 1k と 2k の縦横比が一致していることを、読み込んだ時点で確かめる。
 *
 * ★ 起動時に落とすのは意図的である。
 *   比が食い違っても画像は「生成できてしまう」ので、動かしているかぎり誰も気づかない。
 *   気づかないまま確定画像が Drive へ入り、そのまま掲載に使われるのが最悪の結果である
 *   （framing.ts の「判断を誤ったときに失うものが非対称」と同じ考え方）。
 *   設定を書き換えたその場で落ちるほうが安い。
 */
function assertSameAspect(config: OpenAIConfig): void {
  const parse = (size: string): [number, number] => {
    const m = /^(\d+)x(\d+)$/.exec(size);
    if (!m) throw new Error(`[models] size の形式が不正です: ${size}`);
    return [Number(m[1]), Number(m[2])];
  };
  const [w1, h1] = parse(config.resolution["1k"].size);
  const [w2, h2] = parse(config.resolution["2k"].size);
  // 整数のまま比べる（浮動小数の丸めを持ち込まない）
  if (w1 * h2 !== w2 * h1) {
    throw new Error(
      `[models] OPENAI_CONFIG の 1k と 2k の縦横比が違います: ` +
        `1k=${config.resolution["1k"].size} 2k=${config.resolution["2k"].size}\n` +
        `        確定処理はドラフトを解像度だけ上げて作り直すため（仕様書 5.4）、` +
        `比が違うと承認された構図と別の構図が確定画像になります。`,
    );
  }
}
assertSameAspect(OPENAI_CONFIG);


/**
 * Google（Gemini 3 Pro Image）。
 *
 * ★ マスク編集には対応しない。
 *   Gemini API にマスク画像を入力できるモデルは存在せず、
 *   対応していた imagen-3.0-capability-001 は 2026-06-30 に停止済み。
 *   supportedModes に "inpaint" が無いので、渡すと InputError で落ちる。
 */
export const GOOGLE_CONFIG: GoogleConfig = {
  endpointTemplate:
    "https://generativelanguage.googleapis.com/v1beta/models/{modelId}:generateContent",
  modelId: "gemini-3-pro-image",
  modelVersionHint: "unverified-2026-07-30",
  supportedModes: ["instruct", "reference"],
  resolution: {
    "1k": { imageSize: "1K", pixels: 1048576 },
    "2k": { imageSize: "2K", pixels: 4194304 },
  },
  maskSemantics: "unsupported",
  unsupportedModeNote:
    "Gemini API にマスク画像を入力できるモデルは存在しない（会話による semantic masking のみ）。マスク編集対応だった imagen-3.0-capability-001 は 2026-06-30 に停止済み。よってマスク編集は OpenAI 単独でしか行えない。",
};

/**
 * xAI（Grok / grok-imagine-image-2.0）。PoC の config/models.json の grok と同じ値。
 *
 * 委託者指示（2026-10-06）：OpenAI → Gemini の順で拒否されたときの回し先に Grok を加える。
 *
 * ★ マスク編集には対応しない（/v1/images/edits にマスクのパラメータが無い）。
 *   除去では Gemini と同じく「目印つき画像と文章」で範囲を伝える方式になる。
 *
 * ★ 出力サイズを指定できない。
 *   2026-09-30 の実測では 2656×3984 の入力に対し 832×1248 の JPEG が返った。
 *   **確定画像（2K）を Grok で作っても 2K にはならない**。resolution.pixels は
 *   見積と記録のための公称値で、API へは渡らない。
 *
 * ★ 1 リクエストの入力画像は元画像込みで 5 枚まで。超えると InputError で落ちる
 *   （黙って切り捨てない）。
 */
export const GROK_CONFIG: GrokConfig = {
  endpoint: "https://api.x.ai/v1/images/edits",
  modelsEndpoint: "https://api.x.ai/v1/models",
  modelId: "grok-imagine-image-2.0",
  modelVersionHint: "verified-2026-09-30",
  supportedModes: ["instruct", "reference"],
  resolution: {
    "1k": { pixels: 1048576 },
    "2k": { pixels: 4194304 },
  },
  maskSemantics: "unsupported",
  maxInputImages: 5,
  // b64_json で返ることを実測済み。URL 応答の host は人が確認してから足す（関所①隔離）
  allowedImageHosts: [],
  unsupportedModeNote:
    "xAI の /v1/images/edits にマスク画像を渡すパラメータが存在しない（2026-09-30 のドキュメント確認）。",
};

export type ProviderName = "openai" | "google" | "grok";

export const PROVIDER_NAMES: readonly ProviderName[] = ["openai", "google", "grok"];

export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && (PROVIDER_NAMES as readonly string[]).includes(value);
}

/** 画面・記録に出す表示名。 */
export const PROVIDER_LABEL: Record<ProviderName, string> = {
  openai: "OpenAI gpt-image-2",
  google: "Google gemini-3-pro-image",
  grok: "xAI grok-imagine-image-2.0",
};

/** API キーの環境変数名。 */
export const PROVIDER_ENV_KEY: Record<ProviderName, string> = {
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  grok: "XAI_API_KEY",
};

/** デモで使う解像度。ここを "2k" にしてはならない（上のコメントの理由）。 */
export const DEMO_RESOLUTION = "1k" as const;

/**
 * 1 回の呼び出しのタイムアウト（ミリ秒）。
 * PoC の PER_CALL_TIMEOUT_MS と揃えてある。Vercel の関数上限（300 秒）より内側に置く。
 *
 * ★ フォールバックすると 1 スロットで最大 3 回（OpenAI → Gemini → Grok）呼ぶ。
 *   110 秒 × 3 は関数上限を超えるので、実際のタイムアウトは callTimeoutMs() で
 *   「関数の残り時間」に合わせて縮める。
 */
export const PER_CALL_TIMEOUT_MS = 110_000;

/**
 * 1 回の関数実行（Vercel の maxDuration = 300 秒）のうち、生成に使ってよい時間。
 *
 * ★ 残りは DB の更新と精算（settle_generation）に回す。
 *   関数が上限で強制終了されると、行が running のまま残り、予約した枚数・金額も
 *   精算されない。時間切れは「打ち切って記録する」ほうが安全である。
 */
export const FUNCTION_BUDGET_MS = 270_000;

/** これより短い残り時間では、次のプロバイダを呼ばない（呼んでも返ってこない）。 */
export const MIN_CALL_MS = 20_000;

/**
 * 締め切り（Date.now() 基準の時刻）から、この呼び出しに使えるタイムアウトを出す。
 * @returns 呼ぶ時間が残っていなければ null
 */
export function callTimeoutMs(deadline: number): number | null {
  const remaining = deadline - Date.now();
  if (remaining < MIN_CALL_MS) return null;
  return Math.min(PER_CALL_TIMEOUT_MS, remaining);
}

/** アップロード画像の上限。Storage バケット側の 15MB とも揃えてある。 */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
