import sharp from "sharp";
import type { MaskCodec } from "./vendor/providers/maskCodec";

/**
 * マスク画像の処理。
 *
 * PoC 側の runner/image/mask.ts（sharpMaskCodec）と runner/studio.ts（normalizeMask）を
 * デモ用に移した。意味づけは変えていない：
 *   - 白 = 再生成したい領域 / 黒 = 保持したい領域
 *   - OpenAI へは alpha = 0 の領域が編集対象の RGBA PNG として送る
 */

const BINARIZE_THRESHOLD = 128;

/**
 * ブラウザの canvas から来たマスクを、元画像と同じ寸法の 2 値グレースケールへ整える。
 *
 * 画面上の canvas は表示サイズなので原寸へ拡大し直す必要がある。
 * 中間の灰色を残すとマスクの判定が曖昧になるので閾値で 2 値へ寄せる。
 */
export async function normalizeMask(
  maskPng: Buffer,
  baseImage: Buffer,
): Promise<{ mask: Buffer; paintedRatio: number }> {
  const base = await sharp(baseImage).rotate().metadata();
  const width = base.autoOrient?.width ?? base.width ?? 0;
  const height = base.autoOrient?.height ?? base.height ?? 0;
  if (width === 0 || height === 0) {
    throw new Error("元画像の寸法を読めませんでした。別の画像で試してください。");
  }

  const mask = await sharp(maskPng)
    .ensureAlpha()
    // 塗った部分だけを白にする。透明部分は黒（＝保持）。
    .extractChannel("alpha")
    .resize({ width, height, kernel: "nearest" })
    .threshold(96)
    .png({ compressionLevel: 9, colours: 2 })
    .toBuffer();

  // 塗られた面積の割合。0 なら「マスクを描いたつもりで描けていない」ので弾く。
  const { data } = await sharp(mask).raw().toBuffer({ resolveWithObject: true });
  let painted = 0;
  for (const value of data) {
    if (value >= BINARIZE_THRESHOLD) painted += 1;
  }

  return { mask, paintedRatio: painted / (width * height) };
}

/**
 * providers/maskCodec.ts の MaskCodec の実装。
 * PoC 側と同じく「白（再生成したい領域）を透明に、黒（保持したい領域）を不透明に」する。
 */
export const sharpMaskCodec: MaskCodec = {
  async toAlphaMask(grayscaleMaskPng: Uint8Array): Promise<Uint8Array> {
    const image = sharp(Buffer.from(grayscaleMaskPng));
    const { data, info } = await image
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const total = info.width * info.height;
    const rgba = Buffer.alloc(total * 4);

    for (let i = 0; i < total; i += 1) {
      const value = data[i]!;
      const isWhite = value >= BINARIZE_THRESHOLD;
      const offset = i * 4;
      // RGB にはマスクの階調をそのまま置く（API は alpha のみを見る）
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = isWhite ? 0 : 255;
    }

    const png = await sharp(rgba, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    return new Uint8Array(png);
  },

  async probeSize(image: Uint8Array): Promise<{ width: number; height: number }> {
    const meta = await sharp(Buffer.from(image)).metadata();
    return { width: meta.width ?? 0, height: meta.height ?? 0 };
  },
};

/**
 * アップロード画像を OpenAI へ送れる形に整える。
 *
 * - EXIF の回転を焼き込む（.rotate()）。これをしないとマスクと向きがずれる。
 * - 長辺 2048 に収める。巨大な写真をそのまま送ると 50MB 制限に当たるうえ、
 *   入力画像のトークン課金が無駄に増える。
 */
export async function prepareSource(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
