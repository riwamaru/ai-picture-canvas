import type { OpenAIConfig } from "./vendor/providers/openai";
import type { GoogleConfig } from "./vendor/providers/google";

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
  modelVersionHint: "unverified-2026-07-30",
  supportedModes: ["instruct", "reference", "inpaint"],
  resolution: {
    "1k": { size: "1024x1536", quality: "medium" },
    "2k": { size: "2048x2048", quality: "high" },
  },
  maskSemantics: "alpha_zero_is_edited",
};

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

export type ProviderName = "openai" | "google";

/** 画面・記録に出す表示名。 */
export const PROVIDER_LABEL: Record<ProviderName, string> = {
  openai: "OpenAI gpt-image-2",
  google: "Google gemini-3-pro-image",
};

/** デモで使う解像度。ここを "2k" にしてはならない（上のコメントの理由）。 */
export const DEMO_RESOLUTION = "1k" as const;

/**
 * 1 回の呼び出しのタイムアウト（ミリ秒）。
 * PoC の PER_CALL_TIMEOUT_MS と揃えてある。Vercel の関数上限（300 秒）より内側に置く。
 *
 * ★ フォールバックすると 1 スロットで最大 2 回呼ぶ。
 *   2 回ぶんが関数上限に収まるよう、PoC の 180 秒より短くしてある。
 */
export const PER_CALL_TIMEOUT_MS = 110_000;

/** アップロード画像の上限。Storage バケット側の 15MB とも揃えてある。 */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
