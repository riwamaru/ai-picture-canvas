-- ============================================================================
-- 確定処理（機能仕様書 v2.1 STEP 5 / F-06）を最後まで実装する
--
--   ① 選んだ 1 枚を高解像度で再生成し「確定画像」とする   ← 0007 では未実装だった
--   ② 確定画像を共有ドライブへ保存する
--   ③ 履歴へ Drive ファイル ID・閲覧 URL・使用モデル・推定コスト・処理時間を記録する
--
-- あわせて、0007 で妥協した排他ロックを仕様書 4.7.2 の形へ直す。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. フォルダ作成の排他ロック（仕様書 4.7.2 の 1 行目）
--
--   仕様書：「フォルダ作成はキャスト単位の排他ロック（DB のアドバイザリロックまたは
--             行ロック）配下で行い、ロック取得後に再度 DB を確認してから作成する」
--
--   ★ なぜロックを「テーブルの行」として持つのか
--
--   pg_advisory_xact_lock はトランザクションの終わりで必ず解放される。
--   ところが排他したい区間は「DB を確認する → Drive へ HTTP で作成する → DB へ書く」で、
--   真ん中に外部への HTTP 呼び出しが挟まる。PostgREST 経由ではトランザクションを
--   跨げないため、Postgres のロックだけでは区間全体を覆えない。
--
--   そこで 2 段にする：
--     - 区間全体の排他は、この drive_locks の行（リース）で持つ
--     - その行の「取得判定そのもの」を pg_advisory_xact_lock で直列化する
--       （検査と書き込みの間に別の処理が割り込むのを防ぐ）
--
--   ★ 有効期限（リース）が必須である理由
--   Vercel の関数は途中で落ちうる。解放されないロックが残ると、その店舗・キャストは
--   二度と保存できなくなる。期限切れのロックは奪えるようにしてある。
-- ---------------------------------------------------------------------------

create table public.drive_locks (
  lock_key    text primary key,
  -- 誰が持っているか。解放は持ち主だけが行える（他人のロックを消させない）。
  owner       uuid not null,
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null
);

comment on table public.drive_locks is
  'Drive フォルダ作成の排他ロック（仕様書 4.7.2）。外部 HTTP を挟む区間を覆うため、'
  'Postgres のロックではなくリース行として持つ。取得判定は pg_advisory_xact_lock で直列化する。';

alter table public.drive_locks enable row level security;
-- ポリシーを 1 つも作らない ＝ service_role だけが読み書きする

create or replace function public.acquire_drive_folder_lock(
  p_key         text,
  p_owner       uuid,
  p_ttl_seconds int default 180
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.drive_locks;
begin
  -- ★ ここが仕様書のいうアドバイザリロック。
  --   キーごとに取るので、別のキャストのフォルダ作成は互いに待たない。
  --   トランザクション末尾（この関数の終わり）で自動的に解放される。
  perform pg_advisory_xact_lock(hashtextextended(p_key, 0));

  select * into v_row from public.drive_locks where lock_key = p_key for update;

  -- 生きているロックを他人が持っているなら取れない
  if found and v_row.expires_at > now() and v_row.owner <> p_owner then
    return jsonb_build_object(
      'acquired', false,
      'expires_at', v_row.expires_at,
      'wait_seconds', ceil(extract(epoch from (v_row.expires_at - now())))
    );
  end if;

  -- 空き・期限切れ・自分のものなら取る（期限は取り直すたびに延びる）
  insert into public.drive_locks (lock_key, owner, acquired_at, expires_at)
  values (p_key, p_owner, now(), now() + make_interval(secs => p_ttl_seconds))
  on conflict (lock_key) do update
     set owner       = excluded.owner,
         acquired_at = excluded.acquired_at,
         expires_at  = excluded.expires_at;

  return jsonb_build_object('acquired', true, 'stolen', found and v_row.expires_at <= now());
end;
$$;

comment on function public.acquire_drive_folder_lock is
  'キャスト単位のフォルダ作成ロックを取る（仕様書 4.7.2）。取れなければ acquired=false を返す（例外は投げない）。';

create or replace function public.release_drive_folder_lock(p_key text, p_owner uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted int;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_key, 0));
  delete from public.drive_locks where lock_key = p_key and owner = p_owner;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

-- ★ ブラウザから直接呼べてはならない。呼べると保存先の作成を止められる。
revoke execute on function public.acquire_drive_folder_lock(text, uuid, int) from public, anon, authenticated;
revoke execute on function public.release_drive_folder_lock(text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. 確定画像（仕様書 STEP 5 ①）
--
--   ★ ドラフト（job_images）とは別のテーブルにする。
--     解像度もモデルも料金も別で、6 枚の比較対象でもない。
--     job_images に混ぜると「6 枚」を数えるあらゆる集計が狂う。
--
--   ★ job_id に unique を張る ＝ 1 セッションにつき確定画像は 1 枚。
--     仕様書 STEP 5「選択された 1 枚のみを高解像度で再生成し確定画像とする」。
-- ---------------------------------------------------------------------------

create table public.final_images (
  id                      uuid primary key default gen_random_uuid(),
  job_id                  uuid not null unique references public.jobs(id) on delete cascade,

  -- どのドラフトを選んだか（6 枚のうちどれが選ばれやすいかを後から数えられる）
  source_slot             int not null,

  status                  public.job_status not null default 'queued',
  -- '1k' / '2k'。何で作ったのかを必ず残す。
  -- ここを見ずに「確定画像＝高解像度」と決めつけると、設定を落としたときに気づけない。
  resolution              text not null check (resolution in ('1k', '2k')),

  provider                text check (provider in ('openai', 'google')),
  edit_method             text check (edit_method in ('inpaint', 'semantic_mask', 'instruct')),
  prompt_hash             text,
  attempted_provider      text check (attempted_provider in ('openai', 'google')),
  attempted_error_kind    text check (attempted_error_kind in ('policy', 'input', 'infra')),
  attempted_error_message text,

  result_path             text,

  -- 予約時の見積と、精算後の実額。両方残すと見積の精度を後から検証できる（区分 A-4）。
  reserved_cost_usd       numeric(12,6) not null default 0,
  actual_cost_usd         numeric(12,6),
  latency_ms              int,

  error_kind              text check (error_kind in ('policy', 'input', 'infra')),
  error_message           text,

  -- Drive への同期状態（仕様書 4.7.2）
  drive_status            text not null default 'none'
    check (drive_status in ('none', 'pending', 'synced', 'failed')),
  drive_file_id           text,
  drive_view_url          text,
  drive_folder_id         text,
  drive_synced_at         timestamptz,
  drive_attempts          int not null default 0,
  drive_last_attempt_at   timestamptz,
  drive_error             text,

  created_at              timestamptz not null default now(),
  started_at              timestamptz,
  finished_at             timestamptz
);

comment on table public.final_images is
  '確定画像（仕様書 STEP 5）。選んだ 1 枚を高解像度で再生成したもの。Drive へ入るのはこれだけ。';

create index final_images_drive_pending_idx
  on public.final_images (drive_last_attempt_at)
  where drive_status = 'failed';

alter table public.final_images enable row level security;

create policy "自分のジョブの確定画像だけ読める"
  on public.final_images for select
  to authenticated
  using (exists (
    select 1 from public.jobs j
     where j.id = final_images.job_id
       and j.user_id = (select auth.uid())
  ));

-- ---------------------------------------------------------------------------
-- 3. ドラフト側の Drive 列を落とす
--
--   0007 では確定処理が無かったため、ドラフト 6 枚を直接 Drive へ送っていた。
--   仕様書 STEP 5 は「確定した 1 枚」だけを Drive へ入れる設計なので、
--   確定処理を入れた今、ドラフト側の経路は残さない。
--   （残すと「Drive にドラフトと確定が混在する」ことになり、
--     どれが確定画像か Drive を見ただけでは分からなくなる）
--
--   ★ これらの列に値が入っていないことを確認してから落としている
--     （drive_enabled は一度も true にしていないため、全行 'none'）。
-- ---------------------------------------------------------------------------

alter table public.job_images
  drop column drive_status,
  drop column drive_file_id,
  drop column drive_view_url,
  drop column drive_folder_id,
  drop column drive_synced_at,
  drop column drive_attempts,
  drop column drive_last_attempt_at,
  drop column drive_error;

-- ---------------------------------------------------------------------------
-- 4. 確定画像の解像度（設定で切り替えられる）
--
--   ★ 既定は '2k'。仕様書 STEP 5 / 5.4 の「2 段階生成」に従う。
--
--   ★ ただし 2K は高い。gpt-image-2 の quality:high は 1024×1024 で $0.211、
--     2048×2048 はその 4 倍の画素数なので 1 枚 **約 $0.85** になる。
--     日次予算の既定が $10 なので、確定 11 回で 1 日ぶんを使い切る。
--     測定目的で回すときは '1k' へ落とせるようにしてある。
-- ---------------------------------------------------------------------------

alter table public.demo_limits
  add column final_resolution text not null default '2k'
    check (final_resolution in ('1k', '2k'));

comment on column public.demo_limits.final_resolution is
  '確定画像の解像度。既定は 2k（仕様書 STEP 5）。2k は 1 枚あたり約 $0.85 かかるため、'
  '予算を節約したい場合は 1k へ落とせる。何で作ったかは final_images.resolution に必ず残る。';
