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
 * ═══════════════════════════════════════════════════════════════
 * 【この体験環境での位置づけ】
 *
 * 仕様書 2.1 STEP 5 の確定処理は
 *   ①選んだ 1 枚を高解像度で再生成 → ②Drive へ保存 → ③履歴へ記録
 * の 3 つからなる。ここで実装したのは ② と ③ である。
 *
 * ① は実装していない。実費のかかる生成をもう 1 回走らせることになり、
 * 予約（reserve_generation）と上限の設計に手を入れる必要があるため、
 * 「保存ロジック」の範囲を越える。したがって現状 Drive へ入るのは
 * ドラフトと同じ 1K の画像である。画面にもそう書いてある。
 * ═══════════════════════════════════════════════════════════════
 */

export type DriveSettings = { drive_enabled: boolean };

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

/**
 * 「店舗名／キャスト名_入店年月」を Drive 上に用意し、その ID を返す（仕様書 4.7.1）。
 *
 * ★ 返すのは常に ID である。名前で保存先を決めてはならない。
 *   キャストが改名されるとフォルダ名は変わるが、ID は変わらないため、
 *   過去画像との紐付けが切れない。
 */
export async function ensureCastFolder(
  admin: SupabaseClient,
  target: FolderTarget,
): Promise<{ folderId: string; ledgerId: string }> {
  const credentials = requireCredentials();

  // ── 1. 台帳にあればそれを使う ──
  //
  // ここで Drive 側の存在確認はしない。仕様書 4.7.2 は
  // 「保存時に 404 を検知したら作り直す」としており、毎回問い合わせると
  // 保存 1 回あたりの API 呼び出しが増えるだけで、得るものがない。
  const found = await selectLedger(admin, target.folderKey);
  if (found?.folder_id) return { folderId: found.folder_id, ledgerId: found.id };

  // ── 2. 台帳の行を「先に取る」ことで作成者を 1 人に絞る ──
  //
  // folder_key の一意制約が効くので、同時に来ても行を作れるのは 1 つだけ。
  // 作れなかった側は、作れた側が folder_id を書き込むのを待つ。
  const { data: claimed } = await admin
    .from("drive_folders")
    .upsert(
      {
        folder_key: target.folderKey,
        store_name: target.storeName,
        cast_name: target.castName,
        joined_ym: target.joinedYm,
        folder_name: target.folderName,
      },
      { onConflict: "folder_key", ignoreDuplicates: true },
    )
    .select("id, folder_key, folder_id, store_folder_id, folder_name")
    .maybeSingle();

  if (!claimed) {
    // 別の処理が作成中。書き込まれるまで少しだけ待つ。
    const waited = await waitForFolderId(admin, target.folderKey);
    if (waited) return waited;
    throw new DriveError(
      "infra",
      "同じ保存先フォルダを別の処理が作成中です。少し待ってからもう一度お試しください。",
    );
  }

  // ── 3. 店舗フォルダ → キャストフォルダの順に用意する ──
  const storeFolderId = await ensureChildFolder(admin, credentials, {
    parentId: credentials.rootFolderId,
    name: target.storeFolderName,
    folderKey: `store:${target.storeName.toLowerCase()}`,
  });

  const castFolderId = await ensureChildFolder(admin, credentials, {
    parentId: storeFolderId,
    name: target.folderName,
    folderKey: target.folderKey,
  });

  const { error } = await admin
    .from("drive_folders")
    .update({
      store_folder_id: storeFolderId,
      folder_id: castFolderId,
      verified_at: new Date().toISOString(),
    })
    .eq("id", claimed.id);

  if (error) {
    // Drive には作れたが DB へ書けなかった＝孤児になる。
    // 試行ログは settled=false のまま残るので、日次の点検で拾える（仕様書 4.7.2 の 2 行目）。
    throw new DriveError(
      "infra",
      `フォルダは作成できましたが、台帳へ保存できませんでした: ${error.message}`,
    );
  }

  await settleAttempts(admin, [`store:${target.storeName.toLowerCase()}`, target.folderKey]);

  return { folderId: castFolderId, ledgerId: claimed.id };
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

async function selectLedger(
  admin: SupabaseClient,
  folderKey: string,
): Promise<LedgerRow | null> {
  const { data } = await admin
    .from("drive_folders")
    .select("id, folder_key, folder_id, store_folder_id, folder_name")
    .eq("folder_key", folderKey)
    .maybeSingle();
  return (data as LedgerRow | null) ?? null;
}

/** 別の処理がフォルダを作り終えるのを、上限つきで待つ。 */
async function waitForFolderId(
  admin: SupabaseClient,
  folderKey: string,
): Promise<{ folderId: string; ledgerId: string } | null> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const row = await selectLedger(admin, folderKey);
    if (row?.folder_id) return { folderId: row.folder_id, ledgerId: row.id };
  }
  return null;
}

/**
 * 「DB に ID はあるが Drive 上では削除されている」場合の作り直し（仕様書 4.7.2 の 3 行目）。
 *
 * ★ 過去画像は復旧できない。だから黙って作り直さず、必ず記録し管理者へ知らせる。
 */
async function recreateFolder(
  admin: SupabaseClient,
  target: FolderTarget,
): Promise<string> {
  const credentials = requireCredentials();

  const storeFolderId = await ensureChildFolder(admin, credentials, {
    parentId: credentials.rootFolderId,
    name: target.storeFolderName,
    folderKey: `store:${target.storeName.toLowerCase()}`,
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

  await settleAttempts(admin, [`store:${target.storeName.toLowerCase()}`, target.folderKey]);

  await notifyDriveIncident(admin, {
    title: "保存先フォルダを作り直しました",
    detail:
      `${target.storeName} / ${target.folderName}\n` +
      "Drive 上でフォルダが削除されていたため、同じ名前で作り直しました。" +
      "**以前このフォルダに入っていた画像は復旧できません。** 削除の経緯をご確認ください。",
  });

  return castFolderId;
}

// ---------------------------------------------------------------------------
// 画像 1 枚の保存
// ---------------------------------------------------------------------------

type JobRow = {
  id: string;
  store_name: string | null;
  cast_name: string | null;
  session_title: string | null;
  created_at: string;
};

type ImageRow = {
  slot: number;
  status: string;
  result_path: string | null;
  drive_status: string;
  drive_file_id: string | null;
  drive_view_url: string | null;
  drive_attempts: number;
};

/**
 * 指定スロットの画像を Drive へ入れる。
 *
 * ★ 呼び出す前に「そのジョブが本人のものか」を確認しておくこと。
 *   ここは service_role で動くので RLS が効かない。
 */
export async function syncImageToDrive(
  admin: SupabaseClient,
  input: { jobId: string; slot: number },
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

  const { data: image } = await admin
    .from("job_images")
    .select("slot, status, result_path, drive_status, drive_file_id, drive_view_url, drive_attempts")
    .eq("job_id", input.jobId)
    .eq("slot", input.slot)
    .maybeSingle<ImageRow>();

  if (!job || !image) {
    return { ok: false, status: "failed", message: "対象が見つかりません。", retryable: false };
  }

  if (image.status !== "succeeded" || !image.result_path) {
    return {
      ok: false,
      status: "failed",
      message: "この候補には保存できる画像がありません。",
      retryable: false,
    };
  }

  const target = resolveFolderTarget({ storeName: job.store_name, castName: job.cast_name });
  const folderPath = `${target.storeName} / ${target.folderName}`;

  // 二重アップロードを避ける。同じ画像が Drive に 2 つ並ぶと、
  // どちらが確定画像か分からなくなる。
  if (image.drive_status === "synced" && image.drive_file_id && image.drive_view_url) {
    return {
      ok: true,
      status: "already",
      fileId: image.drive_file_id,
      viewUrl: image.drive_view_url,
      folderPath,
    };
  }

  await admin
    .from("job_images")
    .update({
      drive_status: "pending",
      drive_attempts: image.drive_attempts + 1,
      drive_last_attempt_at: new Date().toISOString(),
      drive_error: null,
    })
    .eq("job_id", input.jobId)
    .eq("slot", input.slot);

  try {
    const { folderId } = await ensureCastFolder(admin, target);

    const { data: file, error: downloadError } = await admin.storage
      .from("results")
      .download(image.result_path);
    if (downloadError || !file) {
      throw new DriveError(
        "infra",
        `保存元の画像を取得できませんでした: ${downloadError?.message ?? "不明"}`,
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());

    const filename = buildFilename(job, input.slot);

    let uploaded;
    try {
      uploaded = await uploadImage({
        folderId,
        filename,
        contentType: "image/png",
        bytes,
      });
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
      .from("job_images")
      .update({
        drive_status: "synced",
        drive_file_id: uploaded.fileId,
        drive_view_url: uploaded.viewUrl,
        drive_folder_id: folderId,
        drive_synced_at: new Date().toISOString(),
        drive_error: null,
      })
      .eq("job_id", input.jobId)
      .eq("slot", input.slot);

    return {
      ok: true,
      status: "synced",
      fileId: uploaded.fileId,
      viewUrl: uploaded.viewUrl,
      folderPath,
    };
  } catch (error) {
    const driveError =
      error instanceof DriveError
        ? error
        : new DriveError("infra", error instanceof Error ? error.message : String(error));

    await admin
      .from("job_images")
      .update({
        // ★ failed は「Supabase Storage には残っているが Drive へ送れていない」状態。
        //   画像そのものは失われていない（仕様書 4.7.2 の 4 行目）。
        drive_status: "failed",
        drive_error: `${driveError.kind}: ${driveError.message}`.slice(0, 2000),
      })
      .eq("job_id", input.jobId)
      .eq("slot", input.slot);

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
        ? "Google Drive へ送れませんでした。画像は保存されており、あとから自動で再送します。"
        : `Google Drive へ保存できません。${driveError.message}`,
      retryable: driveError.retryable,
    };
  }
}

/**
 * 保存するファイル名。
 * 仕様書はファイル名まで定めていないので、Drive 上で人が探せることを優先する。
 */
function buildFilename(job: JobRow, slot: number): string {
  const stamp = new Date(job.created_at)
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 13); // YYYYMMDDHHmm
  const base =
    job.session_title?.trim() ||
    [job.store_name, job.cast_name].filter(Boolean).join("_") ||
    "ai-canvas";
  return `${base}_候補${slot + 1}_${stamp}.png`.replace(/[/\\:*?"<>|]/g, "_");
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
  details: { jobId: string; slot: number; ok: boolean; message: string }[];
};

/** Drive 未同期の画像をまとめて送り直す。 */
export async function resyncPendingImages(
  admin: SupabaseClient,
  limit = 20,
): Promise<ResyncReport> {
  const { data: rows } = await admin
    .from("job_images")
    .select("job_id, slot, drive_attempts")
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

    const outcome = await syncImageToDrive(admin, {
      jobId: row.job_id as string,
      slot: row.slot as number,
    });

    if (outcome.ok) report.synced += 1;
    else report.stillFailed += 1;

    report.details.push({
      jobId: row.job_id as string,
      slot: row.slot as number,
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
