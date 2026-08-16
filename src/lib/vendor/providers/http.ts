/**
 * HTTP 送信の共通処理。
 *
 * VEXUM 4 つの関所 ①隔離：
 *   送信先ホストを allowlist で固定する。設定ミスやコピペ事故で
 *   意図しないエンドポイントへ画像が送られる経路を塞ぐ。
 *   画像は在籍キャストの顔写真になり得るため、送信先の取り違えは
 *   単なるバグではなく個人情報の流出になる。
 *
 * ★ この層にファイル入出力・ログ出力を書いてはならない（指示書 4 章）。
 *   進捗表示は呼び出し側（runner）の責務。
 */

import { InfraError } from "./errors";

/**
 * 送信を許可するホスト。
 * ここに無いホストへは、たとえ config で指定されていても送信しない。
 */
export const ALLOWED_HOSTS: readonly string[] = [
  "api.openai.com",
  "generativelanguage.googleapis.com",
];

export class DisallowedHostError extends Error {
  constructor(
    public readonly host: string,
    public readonly url: string,
  ) {
    super(
      `[GUARD] 許可されていないホストへの送信は禁止です: ${host}\n` +
        `        URL: ${url}\n` +
        `        許可済み: ${ALLOWED_HOSTS.join(", ")}\n` +
        `        送信先を追加する場合は providers/http.ts の ALLOWED_HOSTS を明示的に変更してください。`,
    );
    this.name = "DisallowedHostError";
  }
}

/** URL のホストが allowlist に含まれることを確認する。 */
export function assertAllowedUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DisallowedHostError("(URL として解釈できません)", url);
  }
  if (parsed.protocol !== "https:") {
    // 画像と API キーを平文で流さない
    throw new DisallowedHostError(`${parsed.protocol}//${parsed.host}`, url);
  }
  if (!ALLOWED_HOSTS.includes(parsed.host)) {
    throw new DisallowedHostError(parsed.host, url);
  }
  return parsed;
}

/**
 * HTTP 応答。エラー時も本文を保持する。
 *
 * 指示書 4 章「分類不能なものは InfraError とし、原文を保持すること。
 * この分類表が第 2 段階の拒否率計測の土台になる」
 * 原文を捨てると、未知のエラーコードを後から分類できなくなる。
 */
export type HttpResponse = {
  ok: boolean;
  status: number;
  /** 応答本文の原文。エラー分類とエラー原文の記録に使う。 */
  rawBody: string;
  /** rawBody を JSON として解釈できた場合の値。できなければ null。 */
  json: unknown | null;
  headers: Record<string, string>;
};

/**
 * allowlist 検査つきの fetch。
 *
 * - リトライしない（指示書 4 章）。呼び出し側が 1 回で諦めて記録する
 * - AbortSignal はそのまま fetch へ渡す。タイムアウトの合成は呼び出し側の責務
 * - 通信そのものが失敗した場合（DNS・接続断・abort）は InfraError を投げる
 * - HTTP ステータスがエラーでも throw しない。分類はアダプタが行う
 */
export async function pocFetch(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  providerName: string,
): Promise<HttpResponse> {
  assertAllowedUrl(url);

  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (cause) {
    // abort とネットワーク障害を区別する。abort は上位で「中断」として扱いたい。
    if (signal.aborted) {
      throw new InfraError(
        "aborted",
        providerName,
        `呼び出しが中断されました（タイムアウトまたは SIGINT）: ${describe(cause)}`,
      );
    }
    throw new InfraError("network", providerName, `通信に失敗しました: ${describe(cause)}`);
  }

  const rawBody = await response.text();
  const json = tryParseJson(rawBody);

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    // 資格情報が混ざるヘッダは記録しない
    if (key.toLowerCase() === "set-cookie" || key.toLowerCase() === "authorization") return;
    headers[key] = value;
  });

  return { ok: response.ok, status: response.status, rawBody, json, headers };
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}

/** JSON として読めなければ null。原文（rawBody）は別に保持しているので情報は失わない。 */
function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 応答本文から文字列を安全に取り出す。
 * プロバイダのエラー応答は形が揺れるため、あちこちで同じ null 検査を書かないための補助。
 */
export function pickString(source: unknown, ...path: string[]): string | null {
  let current: unknown = source;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : null;
}

/** 応答本文から数値を安全に取り出す。 */
export function pickNumber(source: unknown, ...path: string[]): number | null {
  let current: unknown = source;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

/** エラー原文を記録用に切り詰める（results.jsonl を読めなくしないため）。全文は errors.jsonl へ。 */
export function truncateForRecord(text: string, max = 500): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…（全文は errors.jsonl を参照。総 ${text.length} 文字）`;
}
