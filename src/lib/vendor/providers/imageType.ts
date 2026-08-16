/**
 * 画像形式の判定。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【なぜ必要か】
 *
 * API へ画像を送るとき、宣言した MIME タイプと実体が食い違うと拒否される。
 * OpenAI は invalid_image_file を返す。
 *
 * 以前は両アダプタが「常に image/png」と宣言していた。素材は JPEG（.JPG）
 * なので、**最初の 1 件目から必ず失敗していた**（2026-08-13 に実測）。
 *
 * 画素は一切触らない（それは runner/image の責務）。
 * 先頭の数バイトを見るだけなので providers 層に置いてよい。
 * ═══════════════════════════════════════════════════════════════
 */

import { InputError } from "./errors";

export type ImageType = { mime: string; ext: string };

/** 先頭バイトから画像形式を判定する。 */
export function detectImageType(bytes: Uint8Array): ImageType {
  const at = (index: number): number => bytes[index] ?? -1;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return { mime: "image/png", ext: "png" };
  }
  // JPEG: FF D8 FF
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return { mime: "image/webp", ext: "webp" };
  }

  // 判定できないものを png と偽って送ると invalid_image_file になる。
  // 入力エラーとして手前で止めるほうが、原因が分かりやすい。
  throw new InputError(
    "unsupported_image_format",
    "baseImage",
    "画像形式を判定できません（PNG / JPEG / WebP のいずれかである必要があります）",
  );
}
