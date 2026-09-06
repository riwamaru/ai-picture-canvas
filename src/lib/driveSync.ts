import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DriveError,
  findOrCreateFolder,
  requireCredentials,
  resolveFolderTarget,
  uploadImage,
  type Credentials,
  type FolderTarget,
} from "./drive";
import { notifyDriveIncident } from "./slack";

/**
 * Drive への保存を、DB の台帳と突き合わせて実行する層。
 * drive.ts が「Drive を叩く」担当、こちらが「何をどこへ入れるかを決めて記録する」担当。
 *
 * ★ Drive へ入るのは確定画像（final_images）だけである。
 *   ドラフト 6 枚は Supabase Storage に留める（仕様書 STEP 5）。
 *   両方入れると、Drive を見ただけではどれが確定画像か分からなくなる。
 */

export type SyncOutcome =
  | {
      ok: true;
      status: "synced" | "already";
      fileId: string;
      viewUrl: string;
      folderPath: string;
    }
  | {
      ok: false;
      status: "disabled" | "failed";
      /** 利用者へ見せる文言。 */
      message: string;
      /** 再送で直る見込みがあるか。設定・権限の誤りなら false。 */
      retryable: boolean;
    };

// ---------------------------------------------------------------------------
// フォルダの解決
// ---------------------------------------------------------------------------

type LedgerRow = {
  id: string;
  folder_key: string;
  folder_id: string | null;
  store_folder_id: string | null;
  folder_name: string;
};

/** ロックの有効期限（秒）。関数が落ちてもこの時間で自然に解放される。 */
const LOCK_TTL_SECONDS = 180;

/** ロックが取れるまで待つ回数と間隔。 */
const LOCK_ATTEMPTS = 12;
const LOCK_WAIT_MS = 500;

/**
 * 「店舗名／キャスト名_入店年月」を Drive 上に用意し、その ID を返す（仕様書 4.7.1）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【排他（仕様書 4.7.2 の 1 行目）】
 *
 * 仕様書：「フォルダ作成はキャスト単位の排他ロック配下で行い、
 *           ロック取得後に再度 DB を確認してから作成する」
 *
 * 排他したい区間は「DB を確認 → Drive へ HTTP で作成 → DB へ書く」で、
 * 真ん中に外部への HTTP 呼び出しが挟まる。Postgres のロックは
 * トランザクションの終わりで必ず解放されるため、この区間全体は覆えない
 * （PostgREST 経由ではトランザクションを跨げない）。
 *
 * そこで drive_locks のリース行で区間を覆い、その取得判定そのものを
 * acquire_drive_folder_lock の中の pg_advisory_xact_lock で直列化している。
 * 詳細はマイグレーション 0008 のコメントに書いた。
 *
 * ★ ロックを取ったあと、必ずもう一度 DB を見る。
 *   待っている間に別の処理が作り終えている場合があるため。
 * ═══════════════════════════════════════════════════════════════
 */
export async function ensureCastFolder(
  admin: SupabaseClient,
  target: FolderTarget,
): Promise<{ folderId: string; ledgerId: string }> {
  const credentials = requireCredentials();

  // ── 1. 台帳にあればロックを取らずに済ませる ──
  //
  // Drive 側の存在確認はここではしない。仕様書 4.7.2 は
  // 「保存時に 404 を検知したら作り直す」としており、毎回問い合わせても
  // 保存 1 回あたりの呼び出しが増えるだけで得るものがない。
  const found = await selectLedger(admin, target.folderKey);
  if (found?.folder_id) return { folderId: found.folder_id, ledgerId: found.id };

  // ── 2. ロックを取る ──
  const owner = randomUUID();
  const lockKey = `drive-folder:${target.folderKey}`;
  let acquired = false;

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    const { data, error } = await admin.rpc("acquire_drive_folder_lock", {
      p_key: lockKey,
      p_owner: owner,
      p_ttl_seconds: LOCK_TTL_SECONDS,
    });
    if (error) throw new DriveError("infra", `排他ロックを取得できません: ${error.message}`);

    if ((data as { acquired?: boolean })?.acquired) {
      acquired = true;
      break;
    }

    // 待っている間に、ロックを持っている側が作り終えたかもしれない
    const meanwhile = await selectLedger(admin, target.folderKey);
    if (meanwhile?.folder_id) return { folderId: meanwhile.folder_id, ledgerId: meanwhile.id };

    await sleep(LOCK_WAIT_MS);
  }

  if (!acquired) {
    throw new DriveError(
      "infra",
      "同じ保存先フォルダを別の処理が作成中です。少し待ってからもう一度お試しください。",
    );
  }

  try {
    // ── 3. ★ ロック取得後に再度 DB を確認する（仕様書 4.7.2） ──
    const again = await selectLedger(admin, target.folderKey);
    if (again?.folder_id) return { folderId: again.folder_id, ledgerId: again.id };

    // ── 4. 店舗フォルダ → キャストフォルダの順に用意する ──
    const storeFolderId = await ensureChildFolder(admin, credentials, {
      parentId: credentials.rootFolderId,
      name: target.storeFolderName,
      folderKey: storeKeyOf(target),
    });

    const castFolderId = await ensureChildFolder(admin, credentials, {
      parentId: storeFolderId,
      name: target.folderName,
      folderKey: target.folderKey,
    });

    const { data: saved, error } = await admin
      .from("drive_folders")
      .upsert(
        {
          folder_key: target.folderKey,
          store_name: target.storeName,
          cast_name: target.castName,
          joined_ym: target.joinedYm,
          folder_name: target.folderName,
          store_folder_id: storeFolderId,
          folder_id: castFolderId,
          verified_at: new Date().toISOString(),
        },
        { onConflict: "folder_key" },
      )
      .select("id")
      .maybeSingle();

    if (error || !saved) {
      // Drive には作れたが DB へ書けなかった＝孤児になる。
      // 試行ログは settled=false のまま残るので、日次の点検で拾える（仕様書 4.7.2 の 2 行目）。
      throw new DriveError(
        "infra",
        `フォルダは作成できましたが、台帳へ保存できませんでした: ${error?.message ?? "不明"}`,
      );
    }

    await settleAttempts(admin, [storeKeyOf(target), target.folderKey]);

    return { folderId: castFolderId, ledgerId: saved.id as string };
  } finally {
    // ★ 例外が出ても必ず解放する。解放し損ねても期限切れで奪えるが、
    //   その間そのキャストの保存が止まるので、握り潰さず解放する。
    await admin
      .rpc("release_drive_folder_lock", { p_key: lockKey, p_owner: owner })
      .then(({ error }) => {
        if (error) console.error("[drive] ロックを解放できませんでした:", error.message);
      });
  }
}

function storeKeyOf(target: FolderTarget): string {
  return `store:${target.storeName.toLowerCase()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 1 階層ぶんのフォルダを用意する。
 *
 * ★ Drive を叩く前に試行ログを残す（仕様書 4.7.2 の 2 行目）。
 *   Drive への作成と DB への保存は別のシステムなので、
 *   両者をまたぐトランザクションは張れない。間で落ちると
 *   「Drive にはあるが DB は知らないフォルダ」が残る。
 *   先にログを置いておけば、後から孤児として検出できる。
 */
async function ensureChildFolder(
  admin: SupabaseClient,
  credentials: Credentials,
  input: { parentId: string; name: string; folderKey: string },
): Promise<string> {
  const { data: attempt } = await admin
    .from("drive_folder_attempts")
    .insert({
      folder_key: input.folderKey,
      folder_name: input.name,
      parent_folder_id: input.parentId,
    })
    .select("id")
    .maybeSingle();

  const { folderId, created } = await findOrCreateFolder(credentials, input.parentId, input.name);

  if (attempt?.id) {
    await admin
      .from("drive_folder_attempts")
      .update({
        created_folder_id: folderId,
        note: created ? "新規作成" : "既存のフォルダを使用",
      })
      .eq("id", attempt.id);
  }

  return folderId;
}

/** 台帳への保存まで終わった試行を「決着済み」にする。残ったものが孤児候補。 */
async function settleAttempts(admin: SupabaseClient, folderKeys: string[]): Promise<void> {
  await admin
    .from("drive_folder_attempts")
    .update({ settled: true, settled_at: new Date().toISOString() })
    .in("folder_key", folderKeys)
    .eq("settled", false);
}

async function selectLedger(admin: SupabaseClient, folderKey: string): Promise<LedgerRow | null> {
  const { data } = await admin
    .from("drive_folders")
    .select("id, folder_key, folder_id, store_folder_id, folder_name")
    .eq("folder_key", folderKey)
    .maybeSingle();
  return (data as LedgerRow | null) ?? null;
}

/**
 * 「DB に ID はあるが Drive 上では削除されている」場合の作り直し（仕様書 4.7.2 の 3 行目）。
 *
 * ★ 過去画像は復旧できない。だから黙って作り直さず、必ず記録し管理者へ知らせる。
 */
async function recreateFolder(admin: SupabaseClient, target: FolderTarget): Promise<string> {
  const credentials = requireCredentials();

  const storeFolderId = await ensureChildFolder(admin, credentials, {
    parentId: credentials.rootFolderId,
    name: target.storeFolderName,
    folderKey: storeKeyOf(target),
  });
  const castFolderId = await ensureChildFolder(admin, credentials, {
    parentId: storeFolderId,
    name: target.folderName,
    folderKey: target.folderKey,
  });

  const { data: before } = await admin
    .from("drive_folders")
    .select("recreate_count")
    .eq("folder_key", target.folderKey)
    .maybeSingle();

  await admin
    .from("drive_folders")
    .update({
      store_folder_id: storeFolderId,
      folder_id: castFolderId,
      recreated_at: new Date().toISOString(),
      recreate_count: ((before?.recreate_count as number | undefined) ?? 0) + 1,
      verified_at: new Date().toISOString(),
    })
    .eq("folder_key", target.folderKey);

  await settleAttempts(admin, [storeKeyOf(target), target.folderKey]);

  await notifyDriveIncident(admin, {
    title: "保存先フォルダを作り直しました",
    detail:
      `${target.storeName} / ${target.folderName}\n` +
      "Drive 上でフォルダが削除されていたため、同じ名前で作り直しました。" +
      "*以前このフォルダに入っていた画像は復旧できません。* 削除の経緯をご確認ください。",
  });

  return castFolderId;
}

// ---------------------------------------------------------------------------
// 確定画像の保存
// ---------------------------------------------------------------------------

type JobRow = {
  id: string;
  store_name: string | null;
  cast_name: string | null;
  session_title: string | null;
  created_at: string;
};

type FinalRow = {
  id: string;
  job_id: string;
  source_slot: number;
  status: string;
  resolution: string;
  result_path: string | null;
  drive_status: string;
  drive_file_id: string | null;
  drive_view_url: string | null;
  drive_attempts: number;
};

/**
 * 確定画像を Drive へ入れる（仕様書 STEP 5 ②）。
 *
 * ★ 呼び出す前に「そのジョブが本人のものか」を確認しておくこと。
 *   ここは service_role で動くので RLS が効かない。
 */
export async function syncFinalToDrive(
  admin: SupabaseClient,
  input: { jobId: string },
): Promise<SyncOutcome> {
  const { data: limits } = await admin
    .from("demo_limits")
    .select("drive_enabled")
    .eq("id", true)
    .maybeSingle();

  if (!limits?.drive_enabled) {
    return {
      ok: false,
      status: "disabled",
      message: "Google Drive への保存は、管理者設定でオフになっています。",
      retryable: false,
    };
  }

  const { data: job } = await admin
    .from("jobs")
    .select("id, store_name, cast_name, session_title, created_at")
    .eq("id", input.jobId)
    .maybeSingle<JobRow>();

  const { data: final } = await admin
    .from("final_images")
    .select(
      "id, job_id, source_slot, status, resolution, result_path, drive_status, drive_file_id, drive_view_url, drive_attempts",
    )
    .eq("job_id", input.jobId)
    .maybeSingle<FinalRow>();

  if (!job || !final) {
    return { ok: false, status: "failed", message: "確定画像が見つかりません。", retryable: false };
  }

  if (final.status !== "succeeded" || !final.result_path) {
    return {
      ok: false,
      status: "failed",
      message: "確定画像がまだできていません。",
      retryable: false,
    };
  }

  const target = resolveFolderTarget({ storeName: job.store_name, castName: job.cast_name });
  const folderPath = `${target.storeName} / ${target.folderName}`;

  // 二重アップロードを避ける。同じ画像が Drive に 2 つ並ぶと、
  // どちらが確定画像か分からなくなる。
  if (final.drive_status === "synced" && final.drive_file_id && final.drive_view_url) {
    return {
      ok: true,
      status: "already",
      fileId: final.drive_file_id,
      viewUrl: final.drive_view_url,
      folderPath,
    };
  }

  await admin
    .from("final_images")
    .update({
      drive_status: "pending",
      drive_attempts: final.drive_attempts + 1,
      drive_last_attempt_at: new Date().toISOString(),
      drive_error: null,
    })
    .eq("id", final.id);

  try {
    const { folderId } = await ensureCastFolder(admin, target);

    const { data: file, error: downloadError } = await admin.storage
      .from("results")
      .download(final.result_path);
    if (downloadError || !file) {
      throw new DriveError(
        "infra",
        `保存元の画像を取得できませんでした: ${downloadError?.message ?? "不明"}`,
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const filename = buildFilename(job, final);

    let uploaded;
    try {
      uploaded = await uploadImage({ folderId, filename, contentType: "image/png", bytes });
    } catch (error) {
      // 仕様書 4.7.2 の 3 行目：保存時に 404 を検知したらフォルダを作り直して続行する
      if (!(error instanceof DriveError) || error.kind !== "notfound") throw error;
      const recreated = await recreateFolder(admin, target);
      uploaded = await uploadImage({
        folderId: recreated,
        filename,
        contentType: "image/png",
        bytes,
      });
    }

    await admin
      .from("final_images")
      .update({
        drive_status: "synced",
        drive_file_id: uploaded.fileId,
        drive_view_url: uploaded.viewUrl,
        drive_folder_id: folderId,
        drive_synced_at: new Date().toISOString(),
        drive_error: null,
      })
      .eq("id", final.id);

    return { ok: true, status: "synced", fileId: uploaded.fileId, viewUrl: uploaded.viewUrl, folderPath };
  } catch (error) {
    const driveError =
      error instanceof DriveError
        ? error
        : new DriveError("infra", error instanceof Error ? error.message : String(error));

    await admin
      .from("final_images")
      .update({
        // ★ failed は「Supabase Storage には残っているが Drive へ送れていない」状態。
        //   確定画像そのものは失われていない（仕様書 4.7.2 の 4 行目）。
        drive_status: "failed",
        drive_error: `${driveError.kind}: ${driveError.message}`.slice(0, 2000),
      })
      .eq("id", final.id);

    // 設定・権限の誤りは放っておくと全件失敗し続けるので、その場で知らせる。
    if (!driveError.retryable) {
      await notifyDriveIncident(admin, {
        title: "Drive へ保存できません（設定を確認してください）",
        detail: `${folderPath}\n${driveError.message}`,
      });
    }

    return {
      ok: false,
      status: "failed",
      message: driveError.retryable
        ? "Google Drive へ送れませんでした。確定画像は保存されており、あとから自動で再送します。"
        : `Google Drive へ保存できません。${driveError.message}`,
      retryable: driveError.retryable,
    };
  }
}

/**
 * 保存するファイル名。
 * 仕様書はファイル名まで定めていないので、Drive 上で人が探せることを優先する。
 * 解像度を入れてあるのは、設定を 1k に落としたまま運用してしまったときに
 * Drive 側だけを見ても気づけるようにするため。
 */
function buildFilename(job: JobRow, final: FinalRow): string {
  const stamp = new Date(job.created_at)
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 13); // YYYYMMDDHHmm
  const base =
    job.session_title?.trim() ||
    [job.store_name, job.cast_name].filter(Boolean).join("_") ||
    "ai-canvas";
  return `${base}_確定${final.resolution.toUpperCase()}_${stamp}.png`.replace(/[/\\:*?"<>|]/g, "_");
}

// ---------------------------------------------------------------------------
// 再送（仕様書 4.7.2 の 4 行目：バッチで再送する。手動でも実行できる）
// ---------------------------------------------------------------------------

/** 何回まで自動で送り直すか。ここを超えたら人が見る。 */
export const MAX_AUTO_RESYNC_ATTEMPTS = 5;

export type ResyncReport = {
  picked: number;
  synced: number;
  stillFailed: number;
  skippedExhausted: number;
  details: { jobId: string; ok: boolean; message: string }[];
};

/** Drive 未同期の確定画像をまとめて送り直す。 */
export async function resyncPendingImages(
  admin: SupabaseClient,
  limit = 20,
): Promise<ResyncReport> {
  const { data: rows } = await admin
    .from("final_images")
    .select("job_id, drive_attempts")
    .eq("drive_status", "failed")
    .order("drive_last_attempt_at", { ascending: true, nullsFirst: true })
    .limit(limit);

  const report: ResyncReport = {
    picked: rows?.length ?? 0,
    synced: 0,
    stillFailed: 0,
    skippedExhausted: 0,
    details: [],
  };

  for (const row of rows ?? []) {
    const attempts = (row.drive_attempts as number | null) ?? 0;
    if (attempts >= MAX_AUTO_RESYNC_ATTEMPTS) {
      report.skippedExhausted += 1;
      continue;
    }

    const outcome = await syncFinalToDrive(admin, { jobId: row.job_id as string });
    if (outcome.ok) report.synced += 1;
    else report.stillFailed += 1;

    report.details.push({
      jobId: row.job_id as string,
      ok: outcome.ok,
      message: outcome.ok ? outcome.viewUrl : outcome.message,
    });
  }

  return report;
}

/**
 * 孤児フォルダの候補を挙げる（仕様書 4.7.2 の 2 行目）。
 * Drive 上には作られたのに、台帳へ書けなかったもの。
 */
export async function listOrphanFolders(admin: SupabaseClient, limit = 50) {
  const { data } = await admin
    .from("drive_folder_attempts")
    .select("id, folder_key, folder_name, parent_folder_id, created_folder_id, created_at, note")
    .eq("settled", false)
    .not("created_folder_id", "is", null)
    // 作成直後の行を孤児と誤認しないよう、5 分より古いものだけを見る
    .lt("created_at", new Date(Date.now() - 5 * 60_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(limit);

  return data ?? [];
}
