import { createHash } from "node:crypto";
import type { MaskRegion } from "./mask";
import { requireTemplate } from "./vendor/prompts/templates";
import {
  IDENTITY_GUARD_INSTRUCTION,
  IDENTITY_GUARD_NOTE_JA,
  TEMPLATE_VERSION,
} from "./vendor/prompts/templates";

/**
 * Gemini 向けの除去プロンプト（semantic masking）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【なぜ別に作るのか】
 *
 * OpenAI のマスク編集（inpaint）は、マスク画像そのものを API へ渡し、
 * 「マスク外は変更しない」ことを仕組みで担保する。
 *
 * Gemini にはマスク画像を入力できるモデルが無い（2026-08-28 時点で確認済み）。
 * 渡せるのは画像と文章だけなので、
 *   ① 元画像
 *   ② 除去範囲の輪郭を描き込んだ目印つき画像
 *   ③ 位置と面積を述べた文章
 * の 3 つで範囲を伝える。
 *
 * ★ これは inpaint の代替ではなく、別方式である。
 *   「マスク外は不変」の保証は無い。
 *   T-02 の判定基準（マスク外に変化なしが 8 割以上）は
 *   この方式の結果には**そのまま適用できない**。
 *   画面と記録で edit_method を分けているのはそのため。
 *
 * ★ 自由入力は補足メモだけ（確定 UI の項目）。それ以外の文面は固定。
 * ═══════════════════════════════════════════════════════════════
 */

export type SemanticRemovalPrompt = {
  text: string;
  noteJa: string;
  hash: string;
  templateVersion: string;
};

export function buildSemanticRemovalPrompt(input: {
  /** 除去対象の種類（凍結済みカタログの ID）。 */
  templateId: string;
  /** 確定 UI の「補足メモ」。無ければ null。 */
  freeText?: string | null;
  region: MaskRegion;
}): SemanticRemovalPrompt {
  const template = requireTemplate(input.templateId);
  if (template.categoryId !== "tattoo_removal") {
    throw new Error(`テンプレート ${template.id} は除去用ではありません。`);
  }

  const { region } = input;
  const box = [
    `x ${(region.bbox.left * 100).toFixed(0)}%–${(region.bbox.right * 100).toFixed(0)}%`,
    `y ${(region.bbox.top * 100).toFixed(0)}%–${(region.bbox.bottom * 100).toFixed(0)}%`,
  ].join(", ");

  const lines: string[] = [
    // 何を消すか（凍結済みテンプレートの指示文をそのまま使う）
    `Task — retouch the first image. ${template.instruction}`,

    // どこを消すか。目印つき画像と、座標つきの言葉の両方で伝える。
    `Target area: the second image is the same photograph with the target region outlined in bright magenta. ` +
      `Remove only what is inside that outline. The region is located at ${region.regionEn} ` +
      `(bounding box ${box}, covering about ${region.coveragePct.toFixed(1)}% of the image).`,

    // 目印そのものを描かせない（これを言わないと輪郭が結果に写り込む）
    `Do not draw, keep, or reproduce the magenta outline or any marker in the result. ` +
      `The output must look like an unmarked photograph.`,

    // マスク外を保つ。inpaint と違い仕組みでは守れないので、言葉で強く縛る。
    `Everything outside that region must stay pixel-identical to the first image: ` +
      `the face, hair, makeup, clothing, background, pose, framing, lighting, and color. ` +
      `Do not re-compose, re-crop, re-frame, or re-shoot the scene. Return the same photograph with only that area repaired.`,
  ];

  const notes: string[] = [
    `除去対象: ${template.noteJa}`,
    `範囲: ${region.regionJa}／目印つき画像を併せて渡す`,
    `目印（マゼンタの輪郭）は結果に描かない`,
    `指定範囲の外は元画像のまま保つ（※ inpaint と違い仕組みでの保証は無い）`,
  ];

  if (input.freeText) {
    lines.push(`Additional note from the operator: ${input.freeText}`);
    notes.push(`補足メモ: ${input.freeText}`);
  }

  lines.push(IDENTITY_GUARD_INSTRUCTION);
  notes.push(IDENTITY_GUARD_NOTE_JA);

  const text = lines.join("\n");

  // 記録用のハッシュ。inpaint 版とは別方式なので、方式名を混ぜて衝突させない。
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        method: "semantic_mask",
        templateId: input.templateId,
        freeText: input.freeText ?? null,
        // 位置は丸めて入れる。1 画素の違いでハッシュが変わると比較できない。
        region: {
          left: Math.round(region.bbox.left * 100),
          top: Math.round(region.bbox.top * 100),
          right: Math.round(region.bbox.right * 100),
          bottom: Math.round(region.bbox.bottom * 100),
        },
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 16);

  return { text, noteJa: notes.join("\n"), hash, templateVersion: TEMPLATE_VERSION };
}
