import sharp from "sharp";

/**
 * 生成結果の無地の余白を切り落とす（委託者指示・2026-09-30「上下左右の余白をなくす」）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【なぜ必要か】
 * 画像モデルは出力の縦横比を自分で決める。Gemini に渡せるのは imageSize（1K / 2K）だけで、
 * 元画像と比が合わないときは**足りない側に無地の帯を足して**返してくる。
 * 生成結果はそのまま Storage へ保存しているため、この帯がキャストの掲載画像に残る。
 *
 * プロンプト側でも毎回禁じている（prompts/templates.ts の NO_MARGIN_INSTRUCTION）が、
 * 出力の縦横比はモデルの都合で決まるため、言っても付いてくることがある。
 * そこで保存の前に機械的に切り落とす。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【切りすぎないための歯止め】
 *
 * ★ これがこの関数のいちばん大事な部分である。
 *
 * 単純に「周囲の同色を削る」とすると、**無地の背景ごと削ってしまう**。
 * 背景テンプレートには「スタジオ（グレー背景）」のように一面が無地のものがあり、
 * その場合は人物のすぐ外側まで削られて、指定した背景が消えた別の構図になる。
 *
 * そこで「1 辺あたり MAX_TRIM_RATIO を超えて削ることになるなら、何もしない」とした。
 * モデルが足す帯は比を合わせるためのもので、ふつう数％〜十数％に収まる。
 * それを超える削りは「無地の背景を削っている」と判断して見送る。
 *
 * ★ 判断を誤ったときに失うものが非対称であることを踏まえた設計である。
 *   帯が残る → 見て分かる・作り直せる。
 *   背景を削る → 指定と違う画像が、気づかれずに確定・Drive 保存まで進む。
 * ═══════════════════════════════════════════════════════════════
 */

/** 1 辺から削ってよい最大の割合。これを超える削りは背景と判断して見送る。 */
const MAX_TRIM_RATIO = 0.15;

/**
 * 無地と見なす色の許容差（0〜255）。
 * モデルが足す帯は白・黒・グレーのべた塗りなので小さくてよい。
 * 大きくすると、ぼかした背景のグラデーションまで無地と見なして削り始める。
 */
const TRIM_THRESHOLD = 10;

/** 削った量が全辺これ未満なら「余白は無かった」として元画像をそのまま使う。 */
const MIN_TRIM_PX = 2;

export type TrimResult = {
  /** 切り落としたあとの画像（切っていなければ入力と同じ内容）。 */
  image: Buffer;
  /** 実際に削った画素数。削っていなければ null。 */
  trimmed: { left: number; top: number; right: number; bottom: number } | null;
  /** 見送った場合の理由（記録・ログ用）。 */
  skipped: "no_border" | "too_much" | "failed" | null;
};

/**
 * 画像の上下左右にある無地の帯を切り落とす。
 *
 * ★ 失敗しても例外を投げない。余白を消すのは仕上げであって、
 *   ここで落ちて生成結果そのものを失わせるほうが損である。
 */
export async function trimUniformBorders(input: Buffer): Promise<TrimResult> {
  try {
    const source = sharp(input);
    const { width, height } = await source.metadata();
    if (!width || !height) return { image: input, trimmed: null, skipped: "failed" };

    // trim は「四隅の色と似た画素」を全周から削る。結果の info に削った位置が入る。
    const { data, info } = await sharp(input)
      .trim({ threshold: TRIM_THRESHOLD })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });

    // trimOffsetLeft / trimOffsetTop は「元画像のどこから切り出したか」（0 以下の値で入る）
    const left = Math.abs(info.trimOffsetLeft ?? 0);
    const top = Math.abs(info.trimOffsetTop ?? 0);
    const right = width - info.width - left;
    const bottom = height - info.height - top;

    if (left + top + right + bottom < MIN_TRIM_PX) {
      return { image: input, trimmed: null, skipped: "no_border" };
    }

    // ★ 歯止め。1 辺でも上限を超えていたら、無地の背景を削っていると見て見送る。
    const overLimit =
      left > width * MAX_TRIM_RATIO ||
      right > width * MAX_TRIM_RATIO ||
      top > height * MAX_TRIM_RATIO ||
      bottom > height * MAX_TRIM_RATIO;
    if (overLimit) {
      return { image: input, trimmed: null, skipped: "too_much" };
    }

    return { image: Buffer.from(data), trimmed: { left, top, right, bottom }, skipped: null };
  } catch {
    // 一面が無地の画像などで trim は例外を投げる。そのまま返す
    return { image: input, trimmed: null, skipped: "failed" };
  }
}

/**
 * 画像の縦横比（幅 ÷ 高さ）を読む。読めなければ null。
 *
 * ★ 例外を投げない。比を確かめるのは見張りであって、
 *   見張りが落ちて生成結果を失わせるほうが損である（trimUniformBorders と同じ方針）。
 */
export async function readAspectRatio(input: Uint8Array): Promise<number | null> {
  try {
    const { width, height } = await sharp(Buffer.from(input)).metadata();
    if (!width || !height) return null;
    return width / height;
  } catch {
    return null;
  }
}

/**
 * 承認された 1 枚と確定画像の縦横比がずれていないかを見る（2026-10-06 追加）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【なぜ要るか】
 * 確定処理はドラフトを引き伸ばすのではなく、解像度を上げて作り直す（仕様書 5.4）。
 * そのため「承認された構図」と「確定画像の構図」が一致している保証は、
 * 設定（OPENAI_CONFIG の 1k / 2k が同じ比であること）と
 * モデルの挙動の両方に依存する。
 * 実際に 1k=2:3 に対して 2k=1:1 という設定のまま動いていた期間があり、
 * 2:3 で選ばれた構図が 1:1 の枠へ入れ直されていた（気づかれないまま Drive へ入る）。
 *
 * 【しきい値を緩めてある理由】
 * ドラフトも確定画像も trimForStorage() を通るため、削られた量の差だけで比はわずかに動く。
 * また Google は出力の比を自分で決める（渡せるのは imageSize だけ）。
 * 厳しくすると正常な確定でも鳴り続け、見張りとして役に立たなくなる。
 * 2:3（0.667）と 1:1（1.0）の食い違いは 50% なので、この値でも確実に捕まる。
 * ═══════════════════════════════════════════════════════════════
 */
export const ASPECT_TOLERANCE = 0.05;

export type AspectCheck = {
  /** 承認された 1 枚の縦横比。読めなければ null。 */
  approved: number | null;
  /** 確定画像の縦横比。読めなければ null。 */
  final: number | null;
  /** |差| ÷ 承認側。どちらかが読めなければ null。 */
  relativeDiff: number | null;
  /** しきい値を超えたか。読めなかった場合は false（分からないことを異常にはしない）。 */
  mismatch: boolean;
};

export function compareAspect(approved: number | null, final: number | null): AspectCheck {
  if (approved === null || final === null || approved === 0) {
    return { approved, final, relativeDiff: null, mismatch: false };
  }
  const relativeDiff = Math.abs(final - approved) / approved;
  return { approved, final, relativeDiff, mismatch: relativeDiff > ASPECT_TOLERANCE };
}

/** ログ・通知に出す形（例: "2:3 相当 0.667 → 1.000（+50.0%）"）。 */
export function describeAspect(check: AspectCheck): string {
  const fmt = (v: number | null) => (v === null ? "不明" : v.toFixed(3));
  const diff =
    check.relativeDiff === null ? "" : `（差 ${(check.relativeDiff * 100).toFixed(1)}%）`;
  return `承認 ${fmt(check.approved)} → 確定 ${fmt(check.final)}${diff}`;
}

/**
 * 保存の直前に呼ぶ版。何をしたかを 1 行だけログへ出し、画像を返す。
 *
 * @param label ログに出す識別子（例: "slot-0" / "final" / "edit-2"）
 */
export async function trimForStorage(input: Uint8Array, label: string): Promise<Buffer> {
  const buffer = Buffer.from(input);
  const result = await trimUniformBorders(buffer);
  if (result.trimmed) {
    const { left, top, right, bottom } = result.trimmed;
    console.info(`[framing] ${label} の無地の余白を切りました: 左${left} 上${top} 右${right} 下${bottom}px`);
  } else if (result.skipped === "too_much") {
    console.info(`[framing] ${label} は削る範囲が広すぎたため切っていません（無地の背景と判断）。`);
  }
  return ensurePng(result.image, label);
}

/**
 * 保存は常に PNG（パスも .png・contentType も image/png）なので、中身も PNG に揃える。
 *
 * ★ Grok は JPEG で返す（2026-09-30 実測）。帯を切らなかった場合は元のバイト列が
 *   そのまま返るため、ここで揃えないと「.png という名前の JPEG」が Storage と Drive に入る。
 * ★ 失敗しても例外を投げない（trimUniformBorders と同じ方針）。
 */
async function ensurePng(image: Buffer, label: string): Promise<Buffer> {
  const isPng =
    image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (isPng) return image;
  try {
    return await sharp(image).png({ compressionLevel: 9 }).toBuffer();
  } catch (error) {
    console.error(`[framing] ${label} を PNG へ変換できませんでした:`, error);
    return image;
  }
}
