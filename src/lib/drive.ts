import { getVercelOidcToken } from "@vercel/functions/oidc";

/**
 * Google Drive（共有ドライブ）への確定画像の保存。
 * 機能仕様書 v2.1 F-06 ／ 4.7「Google Drive 連携」の実装。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【認証：秘密鍵を持たない】
 *
 * サービスアカウントの JSON 鍵は使わない。使えない、が正確なところで、
 * この組織には iam.disableServiceAccountKeyCreation が効いており、
 * 鍵の作成そのものが禁止されている（Google が新しい組織へ既定で適用するもの）。
 *
 * 代わりに Workload Identity 連携を使う。流れは 3 段：
 *
 *   ① Vercel が実行のたびに OIDC トークンを発行する
 *      ★ 本番の関数実行時は環境変数ではなく、リクエストヘッダ
 *        x-vercel-oidc-token で届く。環境変数 VERCEL_OIDC_TOKEN に入るのは
 *        `vercel env pull` で取ったローカル用だけ。環境変数だけを見ていると
 *        本番で「来ていない」と誤判定する（実際にそうなった）。
 *        取り出しは Vercel 公式の getVercelOidcToken() に任せる。
 *   ② Google の STS がそれを検証し、連携用の一時トークンへ交換する
 *   ③ そのトークンでサービスアカウントになりすまし、1 時間有効の
 *      アクセストークンを受け取る
 *
 * 失効しない秘密がどこにも無い。漏れて困る値を Vercel に置かずに済む。
 *
 * ★ Drive 側の権限の持ち方は鍵方式と変わらない。
 *   サービスアカウントを共有ドライブのメンバーに入れる必要は同じである。
 *   変わるのは「そのサービスアカウントとして名乗る方法」だけ。
 *
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
  "sts.googleapis.com", // ① Vercel の OIDC トークン → 連携トークン
  "iamcredentials.googleapis.com", // ② サービスアカウントのなりすまし
  "www.googleapis.com", // ③ Drive API v3（メタデータ・アップロードの両方）
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
  /** //iam.googleapis.com/projects/…/workloadIdentityPools/…/providers/… */
  audience: string;
  /** なりすます相手（…@….iam.gserviceaccount.com）。共有ドライブのメンバーに入れる。 */
  serviceAccount: string;
  /** 共有ドライブ内の保存先ルートフォルダ。 */
  rootFolderId: string;
};

function readCredentials(): Credentials | null {
  const audience = process.env.GOOGLE_DRIVE_WIF_AUDIENCE?.trim();
  const serviceAccount = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT?.trim();
  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim();

  if (!audience || !serviceAccount || !rootFolderId) return null;
  if (!isAudience(audience)) return null;
  if (!serviceAccount.endsWith(".iam.gserviceaccount.com")) return null;

  return { audience, serviceAccount, rootFolderId };
}

function isAudience(value: string): boolean {
  return (
    value.startsWith("//iam.googleapis.com/projects/") &&
    value.includes("/workloadIdentityPools/") &&
    value.includes("/providers/")
  );
}

export function isDriveConfigured(): boolean {
  return readCredentials() !== null;
}

export type DriveDiagnosis = {
  configured: boolean;
  /** 画面に出してよい範囲の説明。 */
  reason: string;
  /** 共有ドライブへ招待する相手。画面に出す（招待の忘れが一番多い失敗のため）。 */
  serviceAccount: string | null;
  rootFolderId: string | null;
  /** Vercel の OIDC トークンが来ているか。連携方式ではこれが無いと何もできない。 */
  oidcPresent: boolean;
};

/**
 * 「設定したのに認識されない」を切り分けるための診断。
 * ★ トークンや監査値は返さない。返すのは「どの設定が欠けているか」だけ。
 */
/**
 * Vercel の OIDC トークンを取り出す。無ければ null（例外にしない）。
 *
 * ★ process.env.VERCEL_OIDC_TOKEN を直接読んではならない。
 *   本番ではヘッダで届くため、環境変数は空である。
 */
async function readOidcToken(): Promise<string | null> {
  try {
    const token = await getVercelOidcToken();
    return token?.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

/** 環境変数だけで判定できる範囲の診断（同期）。 */
function diagnoseConfig(): Omit<DriveDiagnosis, "oidcPresent"> {
  const audience = process.env.GOOGLE_DRIVE_WIF_AUDIENCE?.trim() ?? "";
  const serviceAccount = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT?.trim() ?? "";
  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim() ?? "";

  const base = { serviceAccount: serviceAccount || null, rootFolderId: rootFolderId || null };

  const missing: string[] = [];
  if (!audience) missing.push("GOOGLE_DRIVE_WIF_AUDIENCE");
  if (!serviceAccount) missing.push("GOOGLE_DRIVE_SERVICE_ACCOUNT");
  if (!rootFolderId) missing.push("GOOGLE_DRIVE_ROOT_FOLDER_ID");

  if (missing.length > 0) {
    return { ...base, configured: false, reason: `未設定の環境変数があります: ${missing.join(" / ")}` };
  }

  if (!isAudience(audience)) {
    return {
      ...base,
      configured: false,
      reason:
        "GOOGLE_DRIVE_WIF_AUDIENCE の形式が違います。" +
        "//iam.googleapis.com/projects/<番号>/locations/global/workloadIdentityPools/<プール>/providers/<プロバイダ> " +
        "の形で設定してください（先頭のスラッシュ 2 本も必要です）。",
    };
  }

  if (!serviceAccount.endsWith(".iam.gserviceaccount.com")) {
    return {
      ...base,
      configured: false,
      reason:
        "GOOGLE_DRIVE_SERVICE_ACCOUNT がサービスアカウントのアドレスではないようです" +
        "（…@….iam.gserviceaccount.com の形式）。",
    };
  }

  return { ...base, configured: true, reason: "設定済みです。" };
}

export async function diagnoseDrive(): Promise<DriveDiagnosis> {
  const config = diagnoseConfig();
  const oidcPresent = (await readOidcToken()) !== null;

  if (!config.configured) return { ...config, oidcPresent };

  if (!oidcPresent) {
    return {
      ...config,
      oidcPresent,
      configured: false,
      reason:
        "Vercel の OIDC トークンが届いていません。" +
        "Vercel のプロジェクト設定（Settings → Security → OIDC Federation）が有効か確認してください。" +
        "ローカルで試す場合は `npx vercel env pull` でトークンを取得します（数時間で失効します）。",
    };
  }

  return { ...config, oidcPresent };
}

// ---------------------------------------------------------------------------
// 認証（Vercel OIDC → STS → サービスアカウントのなりすまし）
// ---------------------------------------------------------------------------

/** Drive の読み書きに必要な権限。 */
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

/**
 * アクセストークンの使い回し。Vercel の同一インスタンス内でだけ効く。
 *
 * ★ なりすましトークンは 1 時間有効で、元になる Vercel の OIDC トークンが
 *   実行ごとに変わっても影響を受けない。だから素直にキャッシュしてよい。
 */
let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(credentials: Credentials): Promise<string> {
  // 期限の 60 秒前には取り直す（処理中に切れないように）
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) {
    return cachedToken.value;
  }

  const oidcToken = await readOidcToken();
  if (!oidcToken) {
    throw new DriveError(
      "config",
      "Vercel の OIDC トークンが届いていません。" +
        "Vercel のプロジェクト設定（Settings → Security → OIDC Federation）が有効か確認してください" +
        "（ローカルでは `npx vercel env pull` で取得できます。数時間で失効します）。",
    );
  }

  // ── ① Vercel の OIDC トークン → Google の連携トークン ──
  const federated = await exchangeToken(credentials, oidcToken);

  // ── ② 連携トークン → サービスアカウントのアクセストークン ──
  const impersonated = await impersonate(credentials, federated);

  cachedToken = impersonated;
  return impersonated.value;
}

async function exchangeToken(credentials: Credentials, oidcToken: string): Promise<string> {
  const url = "https://sts.googleapis.com/v1/token";
  assertDriveUrl(url);

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: credentials.audience,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      subjectToken: oidcToken,
      subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
    }),
  }).catch((cause) => {
    throw new DriveError("infra", `連携トークンの取得に失敗しました: ${describe(cause)}`);
  });

  const text = await response.text();
  if (!response.ok) {
    // ここで落ちる原因はほぼ設定：プール／プロバイダの設定、発行者 URL、
    // 対象者（audience）、属性条件のいずれかが噛み合っていない。
    throw new DriveError(
      response.status >= 500 ? "infra" : "config",
      `Vercel のトークンを Google 側で交換できませんでした（HTTP ${response.status}）。` +
        "Workload Identity プロバイダの発行者 URL・対象者・属性条件をご確認ください。" +
        `／応答: ${truncate(text)}`,
      response.status,
    );
  }

  const json = JSON.parse(text) as { access_token?: string };
  if (!json.access_token) {
    throw new DriveError("config", `連携トークンが応答に含まれていません: ${truncate(text)}`);
  }
  return json.access_token;
}

async function impersonate(
  credentials: Credentials,
  federatedToken: string,
): Promise<{ value: string; expiresAt: number }> {
  const url =
    "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" +
    `${encodeURIComponent(credentials.serviceAccount)}:generateAccessToken`;
  assertDriveUrl(url);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${federatedToken}`,
    },
    body: JSON.stringify({ scope: [DRIVE_SCOPE], lifetime: "3600s" }),
  }).catch((cause) => {
    throw new DriveError("infra", `アクセストークンの取得に失敗しました: ${describe(cause)}`);
  });

  const text = await response.text();
  if (!response.ok) {
    // 403 はほぼ「なりすましの許可が無い」。プールの主体へ
    // roles/iam.workloadIdentityUser を付け忘れているのが定番。
    throw new DriveError(
      response.status >= 500 ? "infra" : "config",
      response.status === 403
        ? "サービスアカウントになりすます権限がありません。" +
          `${credentials.serviceAccount} に対して、Workload Identity プールの主体へ ` +
          "「Workload Identity ユーザー」（roles/iam.workloadIdentityUser）を付与してください。" +
          `／応答: ${truncate(text)}`
        : `アクセストークンを取得できませんでした（HTTP ${response.status}）: ${truncate(text)}`,
      response.status,
    );
  }

  const json = JSON.parse(text) as { accessToken?: string; expireTime?: string };
  if (!json.accessToken) {
    throw new DriveError("config", `アクセストークンが応答に含まれていません: ${truncate(text)}`);
  }

  const expiresAt = json.expireTime ? Date.parse(json.expireTime) : Date.now() + 3600_000;
  return { value: json.accessToken, expiresAt };
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

/** ファイルをゴミ箱へ入れる（確定画像を置き換えたときの古いほう）。中身はフォルダと同じ PATCH。 */
export async function trashFile(fileId: string): Promise<void> {
  await trashFolder(requireCredentials(), fileId);
}

/** 重複して作られたフォルダをゴミ箱へ入れる（先勝ち・後発を削除／仕様書 4.7.2）。 */
export async function trashFolder(credentials: Credentials, folderId: string): Promise<void> {
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
  if (!credentials) throw new DriveError("config", diagnoseConfig().reason);
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
