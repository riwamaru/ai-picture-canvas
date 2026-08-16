/**
 * 画像編集プロバイダの共通インターフェース。
 *
 * ★ 本ファイルの定義は PoC 実装指示書 4 章（＝作業指示書 3.7.1）と同一である。
 *   本実装へそのまま移設するため、PoC 都合で型を変更してはならない。
 *   計画用の describeProvider などは registry.ts 側に「追加」で置き、
 *   ここの定義自体には手を入れない。
 */

/**
 * 処理モード。機能仕様書 4.2.1 の処理種別に対応する。
 * - instruct  … 種別 A：指示ベース編集（メイク強度・雰囲気）
 * - reference … 種別 B：参照画像ベース編集（背景・衣装・髪型・ポーズ）
 * - inpaint   … 種別 C：マスク指定の局所修復（タトゥー除去）
 */
export type ProviderMode = "instruct" | "reference" | "inpaint";

/** 出力解像度。実際のサイズ値へのマッピングは config/models.json が持つ。 */
export type Resolution = "1k" | "2k";

export type EditRequest = {
  mode: ProviderMode;
  baseImage: Uint8Array;
  referenceImages?: Uint8Array[];
  /** 白=再生成 / 黒=保持 のグレースケール PNG。元画像と同一解像度。 */
  maskImage?: Uint8Array;
  prompt: string;
  resolution: Resolution;
  /**
   * バリエーションの作り分けヒント。
   * 現時点で OpenAI / Google のいずれも seed 指定に対応しないため、
   * アダプタはこれを無視してよい（無視した事実は呼び出し側が記録する）。
   */
  variantSeedHint?: string;
};

export type EditResult = {
  image: Uint8Array;
  providerName: string;
  modelName: string;
  modelVersion: string;
  estimatedCostUsd: number;
  latencyMs: number;
};

export interface ImageProvider {
  readonly name: string;
  supports(mode: ProviderMode): boolean;
  edit(req: EditRequest, signal: AbortSignal): Promise<EditResult>;
}
