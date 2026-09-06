import { createSign } from "node:crypto";

/**
 * Google Drive（共有ドライブ）への確定画像の保存。
 * 機能仕様書 v2.1 F-06 ／ 4.7「Google Drive 連携」の実装。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【なぜ googleapis を入れないのか】
 *
 * 必要なのは files.list / files.create / files.get / files.update の 4 つだけで、
 * そのために数十 MB の依存を Vercel の関数へ積む理由がない。
 * それ以上に、googleapis を通すと「どのホストへ何を送っているか」が
 * ライブラリの内側に隠れる。ここを流れるのは在籍キャストの顔写真であり、
 * 送信先の取り違えは単なるバグではなく個人情報の流出になる。
 * PoC 実装指示書の関所①（隔離）に合わせ、送信先を allowlist で固定する。
 *
 * ★ vendor/providers/http.ts の ALLOWED_HOSTS には足さない。
 *   あちらは PoC からの移植コードで、PoC と一致していることに意味がある。
 *   Drive はデモ側だけの経路なので、allowlist もこちらに置く。
 *
 * 【共有ドライブ限定である理由】
 *
 * サービスアカウントは自身のストレージ容量を持たない（仕様書 4.1.2 / 4.7.1）。
 * マイドライブ配下へ作ろうとすると storageQuotaExceeded で必ず失敗する。
 * 失敗の文言が分かりにくいので、この形の失敗は専用の説明へ翻訳して返す。
 * ═══════════════════════════════════════════════════════════════
 */

// ---------------------------------------------------------------------------
// 送信先の固定
// ---------------------------------------------------------------------------

/** Drive 連携で送信を許可するホスト。ここに無いホストへは送らない。 */
export const DRIVE_ALLOWED_HOSTS: readonly string[] = [
  "oauth2.googleapis.com", // アクセストークンの取得
  "www.googleapis.com", // Drive API v3（メタデータ・アップロードの両方）
];

function assertDriveUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DriveError("config", `URL として解釈できません: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new DriveError("config", `https 以外へは送信しません: ${parsed.protocol}//${parsed.host}`);
  }
  if (!DRIVE_ALLOWED_HOSTS.includes(parsed.host)) {
    throw new DriveError(
      "config",
      `許可されていないホストへの送信は禁止です: ${parsed.host}\n` +
        `許可済み: ${DRIVE_ALLOWED_HOSTS.join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// エラー
// ---------------------------------------------------------------------------

/**
 * Drive 連携の失敗。
 *
 *   config     … 設定・資格情報の誤り。再送しても直らない。人が直す必要がある
 *   notfound   … フォルダ／ファイルが Drive 上に無い（削除された）。作り直しで回復しうる
 *   permission … 権限不足。サービスアカウントが共有ドライブのメンバーでない等
 *   infra      … 一時障害・レート制限。再送で回復しうる（仕様書 4.7.2 の 4 行目）
 */
export type DriveErrorKind = "config" | "notfound" | "permission" | "infra";

export class DriveError extends Error {
  constructor(
    public readonly kind: DriveErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "DriveError";
  }

  /** 再送する価値があるか。config と permission は人が直すまで何度送っても同じ。 */
  get retryable(): boolean {
    return this.kind === "infra" || this.kind === "notfound";
  }
}

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

type Credentials = {
  clientEmail: string;
  privateKey: string;
  rootFolderId: string;
};

/**
 * 環境変数から資格情報を読む。
 *
 * ★ 秘密鍵は環境変数に改行がエスケープされた 1 行で入ることが多い。
 *   そのままでは PEM として読めないので、実際の改行へ戻す。
 *   ここを忘れると "error:1E08010C:DECODER routines::unsupported" という
 *   原因の分かりにくいエラーになる。
 */
function readCredentials(): Credentials | null {
  const clientEmail = process.env.GOOGLE_DRIVE_CLIENT_EMAIL?.trim();
  const rawKey = process.env.GOOGLE_DRIVE_PRIVATE_KEY;
  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim();

  if (!clientEmail || !rawKey || !rootFolderId) return null;

  const privateKey = normalizePrivateKey(rawKey);
  if (!privateKey.includes("BEGIN PRIVATE KEY")) return null;

  return { clientEmail, privateKey, rootFolderId };
}

/** 貼り付け事故に強くする。前後の引用符を外し、エスケープされた改行を戻す。 */
function normalizePrivateKey(raw: string): string {
  return raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .split("\\n")
    .join("\n");
}

export function isDriveConfigured(): boolean {
  return readCredentials() !== null;
}

export type DriveDiagnosis = {
  configured: boolean;
  /** 画面に出してよい範囲の説明。鍵そのものは絶対に含めない。 */
  reason: string;
  /** サービスアカウントのアドレス。共有ドライブへ招待する相手なので画面に出す。 */
  clientEmail: string | null;
  rootFolderId: string | null;
};

/**
 * 「設定したのに認識されない」を切り分けるための診断。
 * ★ 鍵の中身は返さない。返すのは「どの環境変数が欠けているか」だけ。
 */
export function diagnoseDrive(): DriveDiagnosis {
  const clientEmail = process.env.GOOGLE_DRIVE_CLIENT_EMAIL?.trim() ?? "";
  const rawKey = process.env.GOOGLE_DRIVE_PRIVATE_KEY ?? "";
  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim() ?? "";

  const missing: string[] = [];
  if (!clientEmail) missing.push("GOOGLE_DRIVE_CLIENT_EMAIL");
  if (!rawKey) missing.push("GOOGLE_DRIVE_PRIVATE_KEY");
  if (!rootFolderId) missing.push("GOOGLE_DRIVE_ROOT_FOLDER_ID");

  if (missing.length > 0) {
    return {
      configured: false,
      reason: `未設定の環境変数があります: ${missing.join(" / ")}`,
      clientEmail: clientEmail || null,
      rootFolderId: rootFolderId || null,
    };
  }

  if (!normalizePrivateKey(rawKey).includes("BEGIN PRIVATE KEY")) {
    return {
      configured: false,
      reason:
        "GOOGLE_DRIVE_PRIVATE_KEY が秘密鍵の形式ではありません。" +
        "サービスアカウントの JSON 鍵のうち private_key の値（BEGIN PRIVATE KEY で始まる文字列）を貼ってください。",
      clientEmail,
      rootFolderId,
    };
  }

  if (!clientEmail.endsWith(".iam.gserviceaccount.com")) {
    return {
      configured: false,
      reason:
        "GOOGLE_DRIVE_CLIENT_EMAIL がサービスアカウントのアドレスではないようです" +
        "（…@….iam.gserviceaccount.com の形式）。",
      clientEmail,
      rootFolderId,
    };
  }

  return { configured: true, reason: "設定済みです。", clientEmail, rootFolderId };
}

// ---------------------------------------------------------------------------
// 認証（サービスアカウント JWT → アクセストークン）
// ---------------------------------------------------------------------------

/**
 * 保存に必要な権限。
 *
 * drive.file（自分が作ったファイルだけ）では、環境変数で指定された
 * ルートフォルダ（人が Drive 上で作ったもの）を親にできないため使えない。
 */
const SCOPE = "https://www.googleapis.com/auth/drive";

/** アクセストークンの使い回し。Vercel の同一インスタンス内でだけ効く。 */
let cachedToken: { value: string; expiresAt: number } | null = null;

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function accessToken(credentials: Credentials): Promise<string> {
  // 期限の 60 秒前には取り直す（処理中に切れないように）
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) {
    return cachedToken.value;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: credentials.clientEmail,
      scope: SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );

  let signature: string;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    signature = base64url(signer.sign(credentials.privateKey));
  } catch (cause) {
    throw new DriveError(
      "config",
      `秘密鍵で署名できませんでした。GOOGLE_DRIVE_PRIVATE_KEY の形式を確認してください: ${describe(cause)}`,
    );
  }

  const url = "https://oauth2.googleapis.com/token";
  assertDriveUrl(url);

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
  }).catch((cause) => {
    throw new DriveError("infra", `トークンの取得に失敗しました: ${describe(cause)}`);
  });

  const text = await response.text();
  if (!response.ok) {
    // invalid_grant はほぼ「鍵が失効している」「時計がずれている」「アドレスが違う」
    throw new DriveError(
      response.status === 400 || response.status === 401 ? "config" : "infra",
      `トークンを取得できませんでした（HTTP ${response.status}）: ${truncate(text)}`,
      response.status,
    );
  }

  const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new DriveError("config", `応答にトークンが含まれていません: ${truncate(text)}`);
  }

  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

// ---------------------------------------------------------------------------
// Drive API の呼び出し
// ---------------------------------------------------------------------------

/** 共有ドライブを扱うために全リクエストへ付ける必須パラメータ。 */
const SHARED_DRIVE_PARAMS = "supportsAllDrives=true&includeItemsFromAllDrives=true";

async function driveFetch(
  credentials: Credentials,
  url: string,
  init: RequestInit,
): Promise<{ status: number; text: string; json: unknown }> {
  assertDriveUrl(url);
  const token = await accessToken(credentials);

  const response = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  }).catch((cause) => {
    throw new DriveError("infra", `Drive への通信に失敗しました: ${describe(cause)}`);
  });

  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 本文が JSON でないことがある（空応答など）。原文は text に残る */
  }

  if (!response.ok) throw classifyDriveResponse(response.status, text, json);
  return { status: response.status, text, json };
}

/**
 * Drive の失敗を分類する。
 *
 * ★ storageQuotaExceeded は特別扱いする。
 *   これは「容量が足りない」ではなく、ほぼ確実に
 *   「マイドライブへ保存しようとしている」＝設定の誤りだからである。
 *   そのまま出すと容量を買い足す方向へ誤解させる。
 */
function classifyDriveResponse(status: number, text: string, json: unknown): DriveError {
  const reason = errorReason(json);
  const message = errorMessage(json) ?? truncate(text);

  if (reason === "storageQuotaExceeded") {
    return new DriveError(
      "config",
      "保存先がマイドライブになっている可能性があります。" +
        "サービスアカウントは自身のストレージ容量を持たないため、共有ドライブ以外へは保存できません" +
        "（機能仕様書 4.1.2 / 4.7.1）。GOOGLE_DRIVE_ROOT_FOLDER_ID に共有ドライブ内のフォルダ ID を設定してください。" +
        `／Drive の応答: ${message}`,
      status,
    );
  }

  if (status === 404) {
    return new DriveError("notfound", `Drive 上に見つかりません: ${message}`, status);
  }

  if (status === 401) {
    return new DriveError("config", `認証されませんでした: ${message}`, status);
  }

  if (status === 403) {
    // 403 は「レート制限」と「権限不足」の両方に使われる。混ぜると再送の判断を誤る。
    if (reason === "userRateLimitExceeded" || reason === "rateLimitExceeded") {
      return new DriveError("infra", `Drive のレート制限です: ${message}`, status);
    }
    return new DriveError(
      "permission",
      "共有ドライブへの権限がありません。" +
        "サービスアカウントを共有ドライブのメンバー（コンテンツ管理者以上）に追加してください。" +
        `／Drive の応答: ${message}`,
      status,
    );
  }

  if (status === 429 || status >= 500) {
    return new DriveError("infra", `Drive が一時的に応答できません: ${message}`, status);
  }

  return new DriveError(
    "infra",
    `Drive の呼び出しに失敗しました（HTTP ${status}）: ${message}`,
    status,
  );
}

function errorReason(json: unknown): string | null {
  const errors = (json as { error?: { errors?: { reason?: string }[] } })?.error?.errors;
  return errors?.[0]?.reason ?? null;
}

function errorMessage(json: unknown): string | null {
  const message = (json as { error?: { message?: string } })?.error?.message;
  return typeof message === "string" ? message : null;
}

// ---------------------------------------------------------------------------
// フォルダ名とキー
// ---------------------------------------------------------------------------

/**
 * Drive のフォルダ名に使えない文字を落とす。
 *
 * Drive 自体はスラッシュ以外をほぼ許すが、
 * 後で人が OS 上へダウンロードすることを考えて Windows の禁止文字も落とす。
 */
export function sanitizeFolderName(value: string): string {
  return value
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

/**
 * キャスト名から入店年月（YYYYMM）を切り出す。
 *
 * 確定 UI のキャスト新規登録は「キャスト名_YYYYMM」という表示名を作る
 * （AppShell の登録ダイアログ）。仕様書 4.8 の表示名規則と同じ形なので、
 * 既に年月が付いている名前はそのまま素直に分解できる。
 */
export function splitCastName(castName: string): { name: string; joinedYm: string } {
  const matched = /^(.*)_(\d{6})$/.exec(castName.trim());
  if (matched) return { name: matched[1]!.trim(), joinedYm: matched[2]! };
  return { name: castName.trim(), joinedYm: "" };
}

export type FolderTarget = {
  storeName: string;
  castName: string;
  joinedYm: string;
  /** 台帳の一意キー。表示名が変わっても変わらないよう、正規化した値から作る。 */
  folderKey: string;
  /** Drive 上に作るキャストフォルダの名前（仕様書 4.7.1 の形式）。 */
  folderName: string;
  storeFolderName: string;
};

/**
 * 保存先の名前を組み立てる（仕様書 4.7.1：「店舗名／キャスト名_入店年月（YYYYMM）」）。
 *
 * ★ 入店年月が無い場合は年月を付けない。
 *   仮の年月を埋めると、後から本物が入ったときに別フォルダへ分かれてしまう。
 */
export function resolveFolderTarget(input: {
  storeName: string | null;
  castName: string | null;
}): FolderTarget {
  const storeName = sanitizeFolderName(input.storeName?.trim() || "店舗未設定");
  const split = splitCastName(input.castName?.trim() || "キャスト未設定");
  const castName = sanitizeFolderName(split.name || "キャスト未設定");
  const joinedYm = split.joinedYm;

  const folderName = joinedYm ? `${castName}_${joinedYm}` : castName;

  return {
    storeName,
    castName,
    joinedYm,
    // 大文字小文字・前後空白の違いで別フォルダを作らないよう正規化してからキーにする
    folderKey: [storeName, castName, joinedYm].map((value) => value.toLowerCase()).join(" "),
    folderName,
    storeFolderName: storeName,
  };
}

// ---------------------------------------------------------------------------
// フォルダの解決（作成・重複の後始末）
// ---------------------------------------------------------------------------

type DriveFile = { id: string; name: string; createdTime?: string; trashed?: boolean };

/** 親フォルダ直下から、同名のフォルダを作成の古い順に探す。 */
export async function findFolders(
  credentials: Credentials,
  parentId: string,
  name: string,
): Promise<DriveFile[]> {
  // クォートのエスケープ。名前に ' が入ると検索式が壊れる
  const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const q = [
    `name = '${escaped}'`,
    `'${parentId}' in parents`,
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
  ].join(" and ");

  const url =
    `https://www.googleapis.com/drive/v3/files?${SHARED_DRIVE_PARAMS}&corpora=allDrives` +
    `&orderBy=createdTime&fields=${encodeURIComponent("files(id,name,createdTime)")}` +
    `&q=${encodeURIComponent(q)}`;

  const { json } = await driveFetch(credentials, url, { method: "GET" });
  return ((json as { files?: DriveFile[] })?.files ?? []).slice();
}

async function createFolder(
  credentials: Credentials,
  parentId: string,
  name: string,
): Promise<string> {
  const url = `https://www.googleapis.com/drive/v3/files?${SHARED_DRIVE_PARAMS}&fields=id`;
  const { json } = await driveFetch(credentials, url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  const id = (json as { id?: string })?.id;
  if (!id) throw new DriveError("infra", "フォルダを作成しましたが ID を受け取れませんでした。");
  return id;
}

/** 重複して作られたフォルダをゴミ箱へ入れる（先勝ち・後発を削除／仕様書 4.7.2）。 */
async function trashFolder(credentials: Credentials, folderId: string): Promise<void> {
  const url = `https://www.googleapis.com/drive/v3/files/${folderId}?${SHARED_DRIVE_PARAMS}`;
  await driveFetch(credentials, url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trashed: true }),
  });
}

/**
 * 名前でフォルダを引き当て、無ければ作る。重複が生まれていたら先勝ちで畳む。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【同時作成をどう防ぐか】
 *
 * 仕様書 4.7.2 は「キャスト単位の排他ロック配下で行い、ロック取得後に
 * 再度 DB を確認してから作成する」としている。
 * ただし DB のロックは 1 トランザクションの中でしか保てず、
 * Drive への HTTP 呼び出しをまたいで持ち続けることはできない
 * （Supabase の PostgREST 経由ではトランザクションを跨げない）。
 *
 * そこで、排他は 3 段構えにしてある：
 *   ① drive_folders.folder_key の一意制約で「台帳の行を作れた側」を 1 つに絞る
 *   ② それでも同時に走った場合に備え、作成の直前に Drive を名前で検索する
 *   ③ 作成の直後にもう一度検索し、複数できていたら
 *      作成時刻の最も古いものを残して後発をゴミ箱へ入れる（＝先勝ち）
 *
 * ③ まで置いているのは、①②をすり抜ける窓が原理的に残るため。
 * 仕様書の「重複作成を検知した場合は先勝ちとし、後発分は削除する」は
 * まさにこの窓のための規定だと解釈している。
 * ═══════════════════════════════════════════════════════════════
 */
export async function findOrCreateFolder(
  credentials: Credentials,
  parentId: string,
  name: string,
): Promise<{ folderId: string; created: boolean }> {
  const existing = await findFolders(credentials, parentId, name);
  if (existing.length > 0) return { folderId: oldest(existing).id, created: false };

  const created = await createFolder(credentials, parentId, name);

  // 作成直後にもう一度見て、同時作成が起きていないか確かめる
  const after = await findFolders(credentials, parentId, name).catch(() => [] as DriveFile[]);
  if (after.length > 1) {
    const keep = oldest(after);
    for (const duplicate of after) {
      if (duplicate.id === keep.id) continue;
      // 後始末に失敗しても保存自体は続行する。孤児は日次の点検で拾える
      await trashFolder(credentials, duplicate.id).catch(() => undefined);
    }
    return { folderId: keep.id, created: keep.id === created };
  }

  return { folderId: created, created: true };
}

function oldest(files: DriveFile[]): DriveFile {
  return files.reduce((a, b) => ((a.createdTime ?? "") <= (b.createdTime ?? "") ? a : b));
}

/** フォルダが今も Drive 上にあるか確かめる。 */
export async function folderExists(folderId: string): Promise<boolean> {
  const credentials = requireCredentials();
  const url =
    `https://www.googleapis.com/drive/v3/files/${folderId}?${SHARED_DRIVE_PARAMS}` +
    `&fields=${encodeURIComponent("id,trashed")}`;
  try {
    const { json } = await driveFetch(credentials, url, { method: "GET" });
    return (json as { trashed?: boolean })?.trashed !== true;
  } catch (error) {
    if (error instanceof DriveError && error.kind === "notfound") return false;
    throw error;
  }
}

export type RootInspection = {
  ok: boolean;
  folderName: string | null;
  /** 共有ドライブの ID。マイドライブ配下だと返らない。 */
  driveId: string | null;
  message: string;
};

/**
 * 保存先ルートが「共有ドライブの中のフォルダ」であることを、実際に問い合わせて確かめる。
 *
 * ★ これを設定画面から叩けるようにしてある理由。
 *   マイドライブのフォルダ ID を設定してしまうと、保存の瞬間まで誰も気づけず、
 *   しかも出るエラーが storageQuotaExceeded（容量不足）なので原因を誤解しやすい。
 *   driveId が返るかどうかで、保存を試す前に判別できる。
 */
export async function inspectRootFolder(): Promise<RootInspection> {
  const credentials = requireCredentials();
  const url =
    `https://www.googleapis.com/drive/v3/files/${credentials.rootFolderId}?${SHARED_DRIVE_PARAMS}` +
    `&fields=${encodeURIComponent("id,name,mimeType,driveId,trashed")}`;

  const { json } = await driveFetch(credentials, url, { method: "GET" });
  const file = json as {
    name?: string;
    mimeType?: string;
    driveId?: string;
    trashed?: boolean;
  };

  if (file.mimeType !== "application/vnd.google-apps.folder") {
    return {
      ok: false,
      folderName: file.name ?? null,
      driveId: file.driveId ?? null,
      message: "GOOGLE_DRIVE_ROOT_FOLDER_ID がフォルダではありません。",
    };
  }

  if (file.trashed) {
    return {
      ok: false,
      folderName: file.name ?? null,
      driveId: file.driveId ?? null,
      message: "指定されたフォルダはゴミ箱に入っています。",
    };
  }

  if (!file.driveId) {
    return {
      ok: false,
      folderName: file.name ?? null,
      driveId: null,
      message:
        "指定されたフォルダは共有ドライブの中にありません（マイドライブ配下と思われます）。" +
        "サービスアカウントは自身のストレージ容量を持たないため、ここへは保存できません" +
        "（機能仕様書 4.1.2 / 4.7.1）。共有ドライブを作り、その中のフォルダ ID を設定してください。",
    };
  }

  return {
    ok: true,
    folderName: file.name ?? null,
    driveId: file.driveId,
    message: `共有ドライブ内のフォルダ「${file.name}」に接続できました。`,
  };
}

/** キャストの改名（仕様書 4.7.1：名前だけ変え、ID は変えない）。 */
export async function renameFolder(folderId: string, newName: string): Promise<void> {
  const credentials = requireCredentials();
  const url = `https://www.googleapis.com/drive/v3/files/${folderId}?${SHARED_DRIVE_PARAMS}`;
  await driveFetch(credentials, url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: sanitizeFolderName(newName) }),
  });
}

// ---------------------------------------------------------------------------
// アップロード
// ---------------------------------------------------------------------------

export type UploadedFile = { fileId: string; viewUrl: string; name: string };

/**
 * 画像 1 枚を指定フォルダへ入れる。
 *
 * multipart/related を手で組む。画像は数 MB なので、
 * 再開可能アップロード（resumable）は使わない。
 */
export async function uploadImage(input: {
  folderId: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}): Promise<UploadedFile> {
  const credentials = requireCredentials();
  const boundary = `aicanvas-${Math.random().toString(36).slice(2)}-${Date.now()}`;

  const metadata = JSON.stringify({ name: input.filename, parents: [input.folderId] });

  const head = Buffer.from(
    `--${boundary}\r\n` +
      "content-type: application/json; charset=UTF-8\r\n\r\n" +
      `${metadata}\r\n` +
      `--${boundary}\r\n` +
      `content-type: ${input.contentType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([head, Buffer.from(input.bytes), tail]);

  const url =
    `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&${SHARED_DRIVE_PARAMS}` +
    `&fields=${encodeURIComponent("id,name,webViewLink")}`;

  const { json } = await driveFetch(credentials, url, {
    method: "POST",
    headers: {
      "content-type": `multipart/related; boundary=${boundary}`,
      "content-length": String(body.length),
    },
    body: new Uint8Array(body),
  });

  const file = json as { id?: string; name?: string; webViewLink?: string };
  if (!file?.id) {
    throw new DriveError("infra", "アップロードしましたが、ファイル ID を受け取れませんでした。");
  }

  return {
    fileId: file.id,
    viewUrl: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
    name: file.name ?? input.filename,
  };
}

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

export function requireCredentials(): Credentials {
  const credentials = readCredentials();
  if (!credentials) throw new DriveError("config", diagnoseDrive().reason);
  return credentials;
}

export type { Credentials };

function describe(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}

function truncate(text: string, max = 400): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
