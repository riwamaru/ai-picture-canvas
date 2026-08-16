/**
 * 加工カテゴリと処理種別の対応。
 *
 * 機能仕様書 2.2（加工カテゴリと 6 枚生成の関係）と 4.2.1（処理種別の定義）に対応する。
 * ★ 本実装へ移設する層。依存を持たない。
 */

/** 機能仕様書 STEP 2 の 7 カテゴリ。 */
export const CATEGORY_IDS = [
  "makeup",
  "background",
  "costume",
  "hair",
  "pose",
  "mood",
  "tattoo_removal",
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

/**
 * 処理種別（機能仕様書 4.2.1）。
 * - A … 指示ベース編集（元画像＋テキスト指示）
 * - B … 参照画像ベース編集（元画像＋複数の参考画像）
 * - C … マスク指定の局所修復（元画像＋マスク画像）
 */
export type ProcessKind = "A" | "B" | "C";

export const PROCESS_KIND: Record<CategoryId, ProcessKind> = {
  makeup: "A",
  mood: "A",
  background: "B",
  costume: "B",
  hair: "B",
  pose: "B",
  tattoo_removal: "C",
};

/** 画面表示・記録用の日本語名。機能仕様書のカード名と一致させる。 */
export const CATEGORY_LABEL_JA: Record<CategoryId, string> = {
  makeup: "メイク",
  background: "背景",
  costume: "衣装",
  hair: "髪型",
  pose: "ポーズ",
  mood: "雰囲気",
  tattoo_removal: "タトゥー除去",
};

/**
 * メイクは必須カテゴリ（機能仕様書 2.2.1）。
 * 弱・中・強の 3 段階それぞれについて 2 枚、合計 6 枚を生成する。
 */
export const REQUIRED_CATEGORY: CategoryId = "makeup";

/** メイク強度。6 枚の差異を作る 2 軸のうちの 1 つ。 */
export const MAKEUP_STRENGTHS = ["weak", "medium", "strong"] as const;
export type MakeupStrength = (typeof MAKEUP_STRENGTHS)[number];

export const MAKEUP_STRENGTH_LABEL_JA: Record<MakeupStrength, string> = {
  weak: "弱",
  medium: "中",
  strong: "強",
};

/**
 * カテゴリが参考画像を持てるか。
 * 機能仕様書 2.3.2：「各カード上部に参考画像アップロードエリア（タトゥー除去カードを除く）」
 * タトゥー除去はマスク描画 UI を持つため参考画像欄を持たない。
 */
export function acceptsReferenceImages(category: CategoryId): boolean {
  return PROCESS_KIND[category] === "B";
}

/**
 * 参考画像の上限（機能仕様書 4.2.5）。
 * 「カテゴリごとの参考画像の上限枚数を定める。初期値は各カテゴリ 2 枚、セッション合計 6 枚とし、
 *   PoC の精度検証結果に応じて調整する」
 */
export const REFERENCE_LIMIT = {
  perCategory: 2,
  perSession: 6,
} as const;

export function isCategoryId(value: string): value is CategoryId {
  return (CATEGORY_IDS as readonly string[]).includes(value);
}
