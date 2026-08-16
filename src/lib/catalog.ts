import {
  CATEGORY_IDS,
  CATEGORY_LABEL_JA,
  MAKEUP_STRENGTHS,
  MAKEUP_STRENGTH_LABEL_JA,
  PROCESS_KIND,
  type CategoryId,
  type MakeupStrength,
} from "./vendor/prompts/categories";
import { TEMPLATES, TEMPLATE_VERSION } from "./vendor/prompts/templates";

/**
 * 画面に出す選択肢。
 *
 * ★ 自由入力の指示欄は作らない（PoC 実装指示書 2 章 禁止事項②
 *   「安全性判定の限界を探る入力をしない」）。
 *   選べるのは Object.freeze された TEMPLATES の中身だけである。
 *   任意の画像は受け付けるが、任意のテキストは受け付けない。
 */

/** メイクは必須カテゴリ（機能仕様書 2.2.1）。画面でも常に有効。 */
export const REQUIRED_CATEGORY: CategoryId = "makeup";

/** 画面で選べるカテゴリ（メイクを除く）。 */
export const OPTIONAL_CATEGORIES: readonly CategoryId[] = CATEGORY_IDS.filter(
  (id) => id !== "makeup",
);

export type CatalogTemplate = {
  id: string;
  categoryId: CategoryId;
  /** 選択肢名。 */
  labelJa: string;
  /** 何が起きるかの説明（API へ送る指示文と等価な日本語）。 */
  noteJa: string;
};

export type Catalog = {
  templateVersion: string;
  makeupStrengths: { id: MakeupStrength; labelJa: string }[];
  categories: {
    id: CategoryId;
    labelJa: string;
    processKind: "A" | "B" | "C";
    requiresMask: boolean;
    templates: CatalogTemplate[];
  }[];
};

export function buildCatalog(): Catalog {
  return {
    templateVersion: TEMPLATE_VERSION,
    makeupStrengths: MAKEUP_STRENGTHS.map((id) => ({
      id,
      labelJa: MAKEUP_STRENGTH_LABEL_JA[id],
    })),
    categories: OPTIONAL_CATEGORIES.map((id) => ({
      id,
      labelJa: CATEGORY_LABEL_JA[id],
      processKind: PROCESS_KIND[id],
      requiresMask: PROCESS_KIND[id] === "C",
      templates: TEMPLATES.filter((t) => t.categoryId === id).map((t) => ({
        id: t.id,
        categoryId: t.categoryId,
        labelJa: t.labelJa,
        noteJa: t.noteJa,
      })),
    })),
  };
}

export { CATEGORY_LABEL_JA, MAKEUP_STRENGTH_LABEL_JA };
export type { CategoryId, MakeupStrength };
