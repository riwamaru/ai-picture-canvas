-- ============================================================================
-- Google Drive への確定画像の保存（機能仕様書 v2.1 F-06 / 4.7）
--
-- ★ 保存先は共有ドライブに限定する。
--   サービスアカウントは自身のストレージ容量を持たないため、
--   マイドライブ配下へは書き込めない（仕様書 4.1.2 / 4.7.1）。
--   容量 0 のアカウントで作成を試みると storageQuotaExceeded で必ず失敗する。
--
-- ★ フォルダは「名前」ではなく「ID」で解決する（仕様書 4.7.1）。
--   キャストの改名でフォルダ名が変わっても、ID が同じなら過去画像との紐付けが切れない。
--   よってこのテーブルが保持する一次情報は folder_id であり、folder_name は表示用の控えである。
--
-- ★ Drive への保存失敗は、利用者の操作をブロックしない（仕様書 4.7.2 の 4 行目）。
--   確定画像は Supabase Storage に残したまま「Drive 未同期」として記録し、
--   バッチまたは手動で再送する。したがって job_images 側に同期状態を持たせる。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 設定（オン・オフ）
--
--   資格情報（サービスアカウントの鍵）と保存先ルートは環境変数で持つ。
--   Slack Webhook と同じ扱い：鍵はサーバー環境変数、使う・使わないは DB。
--   鍵を DB へ置くと、管理画面の実装を 1 つ誤っただけで画面へ露出しうる。
-- ---------------------------------------------------------------------------

alter table public.demo_limits
  add column drive_enabled boolean not null default false;

comment on column public.demo_limits.drive_enabled is
  'Google Drive への保存を使うか。既定は false。'
  'サービスアカウントの鍵と共有ドライブの用意が済むまで、経路ごと閉じておくための札。';

-- ---------------------------------------------------------------------------
-- 2. 保存先フォルダの台帳
--
--   仕様書 4.7.1：フォルダ名は「店舗名／キャスト名_入店年月（YYYYMM）」。
--   店舗フォルダとキャストフォルダの 2 階層になるので、両方の ID を持つ。
-- ---------------------------------------------------------------------------

create table public.drive_folders (
  id              uuid primary key default gen_random_uuid(),

  -- 一意キー。店舗名・キャスト名・入店年月を正規化して連結したもの。
  -- 表示名（folder_name）は改名で変わりうるので、キーには使えない。
  folder_key      text not null unique,

  store_name      text not null,
  cast_name       text not null,
  -- 'YYYYMM'。デモでは入店年月が未入力のこともあるため空文字を許す。
  joined_ym       text not null default '',

  -- Drive 上の ID。★ これが保存先解決の一次情報。
  store_folder_id text,
  folder_id       text,

  -- 表示用の控え。ここが実際の Drive 上の名前とずれても、保存先は folder_id で決まる。
  folder_name     text not null,

  -- 「DB に ID があるが Drive 上で削除されている」場合の作り直しの記録（仕様書 4.7.2 の 3 行目）。
  -- 過去画像は復旧できないため、いつ作り直したかを必ず残す。
  recreated_at    timestamptz,
  recreate_count  int not null default 0,

  -- 最後に Drive 側の存在を確認できた時刻
  verified_at     timestamptz,
  created_at      timestamptz not null default now()
);

comment on table public.drive_folders is
  '確定画像の保存先フォルダの台帳。フォルダ名ではなく folder_id で保存先を解決する（仕様書 4.7.1）。';

-- ---------------------------------------------------------------------------
-- 3. フォルダ作成の試行ログ（孤児フォルダの検出用）
--
--   仕様書 4.7.2 の 2 行目：
--     「Drive 作成後に DB 保存が失敗した場合、作成済みフォルダ ID を孤児として
--       検知できるよう、作成試行を事前にログへ記録する」
--
--   Drive への作成と DB への保存は別のシステムなので、
--   両者をまたぐトランザクションは張れない。間で落ちると
--   「Drive にはあるが DB は知らないフォルダ」が残る。
--   これを見つけられるように、Drive を叩く前に行を作り、
--   DB への保存まで終わったら settled=true にする。
--   created_folder_id が入っていて settled=false のものが孤児候補である。
-- ---------------------------------------------------------------------------

create table public.drive_folder_attempts (
  id                uuid primary key default gen_random_uuid(),
  folder_key        text not null,
  folder_name       text not null,
  parent_folder_id  text not null,
  created_folder_id text,
  settled           boolean not null default false,
  note              text,
  created_at        timestamptz not null default now(),
  settled_at        timestamptz
);

create index drive_folder_attempts_orphan_idx
  on public.drive_folder_attempts (created_at desc)
  where settled = false;

comment on table public.drive_folder_attempts is
  'フォルダ作成の試行ログ。created_folder_id があり settled=false の行が孤児候補（仕様書 4.7.2）。';

-- ---------------------------------------------------------------------------
-- 4. 1 枚ごとの同期状態
--
--   none    … 保存していない（既定）
--   pending … 保存処理中
--   synced  … Drive に保存済み
--   failed  … 失敗。Supabase Storage には残っている＝「Drive 未同期」（仕様書 4.7.2）
-- ---------------------------------------------------------------------------

alter table public.job_images
  add column drive_status text not null default 'none'
    check (drive_status in ('none', 'pending', 'synced', 'failed')),
  add column drive_file_id text,
  add column drive_view_url text,
  add column drive_folder_id text,
  add column drive_synced_at timestamptz,
  add column drive_attempts int not null default 0,
  add column drive_last_attempt_at timestamptz,
  add column drive_error text;

comment on column public.job_images.drive_status is
  'Drive への同期状態。failed は「Supabase Storage には残っているが Drive へ送れていない」状態を指し、'
  '利用者の操作はブロックしない（仕様書 4.7.2 の 4 行目）。バッチまたは手動で再送する。';

-- 再送バッチが拾う対象を引くための索引
create index job_images_drive_pending_idx
  on public.job_images (drive_last_attempt_at)
  where drive_status = 'failed';

-- ---------------------------------------------------------------------------
-- 5. RLS
--
--   drive_folders / drive_folder_attempts はポリシーを 1 つも作らない
--   ＝ authenticated からは読めない。読み書きするのは service_role だけ。
--
--   ★ job_images には既に「自分のジョブの画像だけ読める」ポリシーがあり、
--     追加した列もその範囲で読める。閲覧 URL は Drive 側の権限で守られるため、
--     フォルダを共有されていない利用者が開いても Drive がはじく。
-- ---------------------------------------------------------------------------

alter table public.drive_folders         enable row level security;
alter table public.drive_folder_attempts enable row level security;

-- ---------------------------------------------------------------------------
-- 6. Slack の記録に Drive の事故を足す
--
--   仕様書 4.7.2：フォルダを作り直したときは「その事実を管理者へ通知する」。
--   既存の slack_deliveries は kind を 'job' / 'limit' に限っていたので広げる。
-- ---------------------------------------------------------------------------

alter table public.slack_deliveries
  drop constraint if exists slack_deliveries_kind_check;

alter table public.slack_deliveries
  add constraint slack_deliveries_kind_check
  check (kind in ('job', 'limit', 'drive'));
