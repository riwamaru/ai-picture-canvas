/**
 * エラーの 3 分類。
 *
 * ★ 本ファイルの定義は PoC 実装指示書 4 章（＝作業指示書 3.9）と同一である。
 *   機能仕様書 4.5.1 の「障害系 / ポリシー系 / 入力系」に対応する。
 *
 * 分類する目的は 2 つ：
 *   ① 第 2 段階の拒否率計測（T-04）— policy を infra と混ぜると拒否率が測れない
 *   ② 本実装でのユーザー向けメッセージの出し分け（機能仕様書 4.5.2）
 *
 * PoC では再試行・フォールバックを実装しないため、分類は「記録のため」だけに使う。
 */

/** 5xx / timeout / rate limit / 一時的なサービス障害。分類不能なものもここへ落とす。 */
export class InfraError extends Error {
  constructor(
    public code: string,
    public provider: string,
    msg: string,
  ) {
    super(msg);
    this.name = "InfraError";
  }
}

/** モデレーション拒否 / 安全性判定。文言を変えて再投入してはならない（禁止事項③）。 */
export class PolicyError extends Error {
  constructor(
    public code: string,
    public provider: string,
    public category: string | null,
    msg: string,
  ) {
    super(msg);
    this.name = "PolicyError";
  }
}

/** 形式 / サイズ / マスク未指定。プロバイダへ送る前に検出できるものを含む。 */
export class InputError extends Error {
  constructor(
    public code: string,
    public field: string,
    msg: string,
  ) {
    super(msg);
    this.name = "InputError";
  }
}

/** results.jsonl の errorKind に記録する値。 */
export type ErrorKind = "infra" | "policy" | "input";

/**
 * 例外を errorKind へ分類する。
 * 未知の例外は infra として扱う（指示書 4 章「分類不能なものは InfraError とし、原文を保持する」）。
 */
export function classifyError(error: unknown): {
  kind: ErrorKind;
  code: string;
  detail: string;
  category: string | null;
} {
  if (error instanceof PolicyError) {
    return { kind: "policy", code: error.code, detail: error.message, category: error.category };
  }
  if (error instanceof InputError) {
    return { kind: "input", code: error.code, detail: error.message, category: null };
  }
  if (error instanceof InfraError) {
    return { kind: "infra", code: error.code, detail: error.message, category: null };
  }
  // 想定外の例外。握り潰さず、原文を保持したまま infra として記録する。
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { kind: "infra", code: "unclassified", detail, category: null };
}
