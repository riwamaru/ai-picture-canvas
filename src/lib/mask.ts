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

/**
 * ═══════════════════════════════════════════════════════════════
 * ここから下は semantic masking（言葉と目印で範囲を伝える方式）のための処理。
 *
 * 【なぜ必要か】
 * Gemini にはマスク画像を入力できるモデルが存在しない
 * （マスク編集対応だった imagen-3.0-capability-001 は 2026-06-30 に停止済み。
 *   2026-08-28 時点でモデル一覧を確認したが、inpaint/mask 対応は 1 つも無い）。
 *
 * そこで塗ったマスクから
 *   ① 位置の説明（「右上あたり・画像の 3.2%」）
 *   ② 範囲を描き込んだ目印つき画像
 * を作り、両方を Gemini へ渡す。
 *
 * ★ これは inpaint とは別物である。
 *   OpenAI のマスク編集は「マスク外は変更しない」ことが仕組みで担保されるが、
 *   semantic masking にその保証は無い。画面と記録では別方式として扱う。
 * ═══════════════════════════════════════════════════════════════
 */

export type MaskRegion = {
  /** 塗られた範囲の外接矩形（元画像に対する 0〜1 の比率）。 */
  bbox: { left: number; top: number; right: number; bottom: number };
  /** 塗られた面積が画像に占める割合（%）。 */
  coveragePct: number;
  /** 指示文へ埋める英語の位置表現。 */
  regionEn: string;
  /** 画面・記録用の日本語。 */
  regionJa: string;
};

/** 9 分割で位置を言い表す。中央寄りは "center" にまとめる。 */
function describePosition(cx: number, cy: number): { en: string; ja: string } {
  const col = cx < 0.34 ? 0 : cx < 0.67 ? 1 : 2;
  const row = cy < 0.34 ? 0 : cy < 0.67 ? 1 : 2;
  const enV = ["upper", "middle", "lower"][row]!;
  const enH = ["left", "center", "right"][col]!;
  const jaV = ["上", "中央", "下"][row]!;
  const jaH = ["左", "中央", "右"][col]!;

  if (row === 1 && col === 1) return { en: "the center of the image", ja: "画像の中央" };
  if (col === 1) return { en: `the ${enV} center of the image`, ja: `画像の${jaV}中央` };
  if (row === 1) return { en: `the ${enH} side of the image`, ja: `画像の${jaH}側` };
  return { en: `the ${enV}-${enH} area of the image`, ja: `画像の${jaV}${jaH}あたり` };
}

/** 2 値マスク（白＝対象）から、位置と面積を読み取る。 */
export async function analyzeMask(maskPng: Buffer): Promise<MaskRegion> {
  const { data, info } = await sharp(maskPng).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let painted = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[y * width + x]! < 128) continue;
      painted += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) {
    // 塗られていない。呼び出し側が先に弾いている想定だが、落ちないようにしておく。
    return {
      bbox: { left: 0, top: 0, right: 0, bottom: 0 },
      coveragePct: 0,
      regionEn: "the image",
      regionJa: "画像全体",
    };
  }

  const bbox = {
    left: minX / width,
    top: minY / height,
    right: (maxX + 1) / width,
    bottom: (maxY + 1) / height,
  };
  const position = describePosition((bbox.left + bbox.right) / 2, (bbox.top + bbox.bottom) / 2);
  const coveragePct = (painted / (width * height)) * 100;

  return {
    bbox,
    coveragePct,
    regionEn: position.en,
    regionJa: `${position.ja}（塗った範囲は画像の ${coveragePct.toFixed(1)}%）`,
  };
}

/**
 * 元画像の上に、塗った範囲の輪郭を描き込んだ「目印つき画像」を作る。
 *
 * 言葉だけで位置を伝えるより精度が上がる。Gemini には
 * 元画像とこの目印つき画像の 2 枚を渡し、
 * 「2 枚目で囲まれた部分を 1 枚目から消せ／目印そのものは描くな」と指示する。
 */
export async function renderMaskGuide(baseImage: Buffer, maskPng: Buffer): Promise<Buffer> {
  const base = sharp(baseImage).rotate();
  const meta = await base.metadata();
  const width = meta.autoOrient?.width ?? meta.width ?? 0;
  const height = meta.autoOrient?.height ?? meta.height ?? 0;
  if (!width || !height) throw new Error("元画像の寸法を読めませんでした。");

  const mask = await sharp(maskPng)
    .greyscale()
    .resize({ width, height, kernel: "nearest" })
    .raw()
    .toBuffer();

  // 輪郭だけを残す：塗られた画素のうち、隣に塗られていない画素があるもの
  const overlay = Buffer.alloc(width * height * 4);
  const on = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x]! >= 128;

  // 線が細すぎると縮小時に消えるので、画像の大きさに応じて太らせる
  const thickness = Math.max(2, Math.round(Math.min(width, height) / 220));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!on(x, y)) continue;
      const isEdge = !on(x - 1, y) || !on(x + 1, y) || !on(x, y - 1) || !on(x, y + 1);
      if (!isEdge) continue;
      for (let dy = -thickness; dy <= thickness; dy += 1) {
        for (let dx = -thickness; dx <= thickness; dx += 1) {
          const px = x + dx;
          const py = y + dy;
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          const o = (py * width + px) * 4;
          overlay[o] = 255;
          overlay[o + 1] = 0;
          overlay[o + 2] = 255; // マゼンタ。肌や衣装と混同されにくい
          overlay[o + 3] = 255;
        }
      }
    }
  }

  return base
    .composite([{ input: overlay, raw: { width, height, channels: 4 }, blend: "over" }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}
