import {
  MAKEUP_STRENGTHS,
  PROCESS_KIND,
  type CategoryId,
  type MakeupStrength,
} from "./vendor/prompts/categories";
import { TEMPLATE_VERSION } from "./vendor/prompts/templates";
import { DEMO_TEMPLATES } from "./vendor/prompts/templates.demo";

/**
 * 画面に出す選択肢。
 *
 * ★ 確定 UI（index.html）に出ていた選択肢と 1 対 1 で対応させる。
 *   PoC 側のテンプレート（背景「スタジオ（グレー背景）」など）は
 *   確定 UI の一覧に無いため、ここには載せない。
 *   載せると、確定済みの画面に無い選択肢が増えることになる。
 *
 * ★ テンプレート以外の指示文が API へ届く経路は無い（自由テキストを除く。
 *   自由テキストは確定 UI にある項目のため受け付けるが、全文を記録する）。
 */

export type CatalogTemplate = {
  id: string;
  labelJa: string;
  /** 何が起きるかの説明。API へ送る指示文と等価な日本語。 */
  noteJa: string;
};

export type CatalogCategory = {
  id: CategoryId;
  /** カードの見出し（確定 UI の文言）。 */
  titleJa: string;
  /** カード左肩の 1 文字（メ・背・衣・髪・ポ・雰・除）。 */
  letterJa: string;
  /** 処理種別（機能仕様書 4.2.1）。バッジの色分けに使う。 */
  processKind: "A" | "B" | "C";
  processLabelJa: string;
  /** メイクは必須カテゴリ（機能仕様書 2.2.1）。無効にできない。 */
  required: boolean;
  /** 参考画像欄を出すか（種別 B のみ）。 */
  acceptsReferences: boolean;
  requiresMask: boolean;
  /** テンプレート選択の見出し。除去カードだけ「除去対象の種類」になる。 */
  selectLabelJa: string;
  /** 自由テキスト欄の見出しと例文。 */
  freeTextLabelJa: string;
  freeTextPlaceholder: string;
  templates: CatalogTemplate[];
};

export type Catalog = {
  templateVersion: string;
  makeupStrengths: { id: MakeupStrength; labelJa: string }[];
  categories: CatalogCategory[];
};

/** 確定 UI のカード見出し・バッジ・例文。 */
const DISPLAY: Record<
  CategoryId,
  {
    titleJa: string;
    letterJa: string;
    selectLabelJa: string;
    freeTextLabelJa: string;
    freeTextPlaceholder: string;
  }
> = {
  makeup: {
    titleJa: "メイク設定",
    letterJa: "メ",
    selectLabelJa: "テンプレートから選択",
    freeTextLabelJa: "自由テキスト指示",
    freeTextPlaceholder: "例: リップの赤みを少し強め、艶感を出す",
  },
  background: {
    titleJa: "背景設定",
    letterJa: "背",
    selectLabelJa: "テンプレートから選択",
    freeTextLabelJa: "自由テキスト指示",
    freeTextPlaceholder: "例: 大理石の柱と柔らかな間接照明",
  },
  costume: {
    titleJa: "衣装設定",
    letterJa: "衣",
    selectLabelJa: "テンプレートから選択",
    freeTextLabelJa: "自由テキスト指示",
    freeTextPlaceholder: "例: 黒のシルクVネックロングドレス",
  },
  hair: {
    titleJa: "髪型設定",
    letterJa: "髪",
    selectLabelJa: "テンプレートから選択",
    freeTextLabelJa: "自由テキスト指示",
    freeTextPlaceholder: "例: 前髪シースルーできれい目のまとめ髪",
  },
  pose: {
    titleJa: "ポーズ指定",
    letterJa: "ポ",
    selectLabelJa: "テンプレートから選択",
    freeTextLabelJa: "自由テキスト指示",
    freeTextPlaceholder: "例: 手をあごに少し添えるポーズ",
  },
  mood: {
    titleJa: "全体の雰囲気・ライティング",
    letterJa: "雰",
    selectLabelJa: "テンプレートから選択",
    freeTextLabelJa: "自由テキスト指示",
    freeTextPlaceholder: "例: 左側からの暖色系サイドライティング",
  },
  tattoo_removal: {
    titleJa: "タトゥー・不要物除去",
    letterJa: "除",
    selectLabelJa: "除去対象の種類",
    freeTextLabelJa: "補足メモ",
    freeTextPlaceholder: "例: 右肩の蝶のタトゥー、デコルテのワンポイント",
  },
};

const PROCESS_LABEL: Record<"A" | "B" | "C", string> = {
  A: "種別A 指示ベース編集",
  B: "種別B 参照画像ベース",
  C: "種別C マスク局所修復",
};

/** 確定 UI のカード並び順。 */
const CARD_ORDER: readonly CategoryId[] = [
  "makeup",
  "background",
  "costume",
  "hair",
  "pose",
  "mood",
  "tattoo_removal",
];

export function buildCatalog(): Catalog {
  return {
    templateVersion: TEMPLATE_VERSION,
    makeupStrengths: MAKEUP_STRENGTHS.map((id) => ({
      id,
      labelJa: { weak: "弱", medium: "中", strong: "強" }[id],
    })),
    categories: CARD_ORDER.map((id) => {
      const kind = PROCESS_KIND[id];
      const display = DISPLAY[id];
      return {
        id,
        titleJa: display.titleJa,
        letterJa: display.letterJa,
        processKind: kind,
        processLabelJa: PROCESS_LABEL[kind],
        required: id === "makeup",
        // 確定 UI ではタトゥー除去カードにだけ参考画像欄が無い（機能仕様書 2.3.2）。
        acceptsReferences: kind !== "C",
        requiresMask: kind === "C",
        selectLabelJa: display.selectLabelJa,
        freeTextLabelJa: display.freeTextLabelJa,
        freeTextPlaceholder: display.freeTextPlaceholder,
        templates: DEMO_TEMPLATES.filter((t) => t.categoryId === id).map((t) => ({
          id: t.id,
          labelJa: t.labelJa,
          noteJa: t.noteJa,
        })),
      };
    }),
  };
}

export type { CategoryId, MakeupStrength };
