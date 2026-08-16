/**
 * プロンプトのハッシュ。
 *
 * 用途（PoC 実装指示書 6.2）：
 *   「promptHash … 同一プロンプトの判別用」
 *   「プロンプトの全文は別ファイル（prompts.jsonl）へ promptHash とともに保存する」
 *
 * さらに禁止事項③（拒否された内容を文言を変えて再投入しない）の検出にも使う。
 * 過去に policy 拒否された条件と同じ組で promptHash が変わっていたら、
 * 文言を変えて再投入しようとしていることになる。
 *
 * ★ 本実装へ移設する層。node:crypto 以外の依存を持たない。
 */

import { createHash } from "node:crypto";

/**
 * 正規化した JSON の SHA-256 の先頭 16 桁。
 *
 * オブジェクトのキー順で値が変わらないよう、キーをソートしてから直列化する。
 * ソートしないと、コードの書き換えでキー順が変わるだけで
 * 「別のプロンプト」と判定され、禁止事項③の検出が誤作動する。
 */
export function promptHash(payload: unknown): string {
  const canonical = canonicalize(payload);
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

/** 全文のハッシュ（衝突を避けたい場面用）。 */
export function fullHash(payload: unknown): string {
  return createHash("sha256").update(canonicalize(payload), "utf8").digest("hex");
}

/** 文字列の SHA-256（判定基準確定書の封印などに使う）。 */
export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * キー順に依存しない直列化。
 * 配列の順序は意味を持つため保持する（参考画像の並び順は結果に影響する）。
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";

  const type = typeof value;
  if (type === "number" || type === "boolean") return String(value);
  if (type === "string") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  if (type === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      // undefined のプロパティは「無い」と同じ扱いにする
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(String(value));
}
