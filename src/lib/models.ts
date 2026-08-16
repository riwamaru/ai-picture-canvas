import type { OpenAIConfig } from "./vendor/providers/openai";

/**
 * モデル設定。PoC の config/models.json の openai セクションと同じ値を持つ。
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
  modelVersionHint: "unverified-2026-07-30",
  supportedModes: ["instruct", "reference", "inpaint"],
  resolution: {
    "1k": { size: "1024x1536", quality: "medium" },
    "2k": { size: "2048x2048", quality: "high" },
  },
  maskSemantics: "alpha_zero_is_edited",
};

/** デモで使う解像度。ここを "2k" にしてはならない（上のコメントの理由）。 */
export const DEMO_RESOLUTION = "1k" as const;

/**
 * 1 回の呼び出しのタイムアウト（ミリ秒）。
 * PoC の PER_CALL_TIMEOUT_MS と揃えてある。Vercel の関数上限（300 秒）より内側に置く。
 */
export const PER_CALL_TIMEOUT_MS = 170_000;

/** アップロード画像の上限。Storage バケット側の 15MB とも揃えてある。 */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
