-- ============================================================================
-- 確定 UI（index.html）に合わせて「1 回の生成 ＝ ドラフト 6 枚」へ作り替える。
--
-- モックの STEP 3 は「メイク強度 弱・中・強 × 各 2 枚 ＝ 6 枚を非同期生成し、
-- できたものからスロットへ順次反映する」設計になっている（機能仕様書 2.2.1）。
-- 1 押し 1 枚だった初版では、この画面を再現できない。
--
-- そこで：
--   jobs        … 1 回の「生成」ボタン押下（＝セッションの 1 試行）
--   job_images  … その中の 1 枚ずつ（＝画面のスロット 6 個）
-- に分ける。上限の予約も 6 枚まとめて取る（途中で予算が尽きて
-- 3 枚だけ出来た、という半端な状態を作らないため）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. ジョブの状態に「待機中」を足す（モックの「キュー待機中」スロットに対応）
-- ---------------------------------------------------------------------------

alter type public.job_status add value if not exists 'queued' before 'running';

-- ---------------------------------------------------------------------------
-- 2. jobs に、モックの STEP 0 / セッション情報を持たせる
-- ---------------------------------------------------------------------------

alter table public.jobs
  add column store_name    text,
  add column cast_name     text,
  add column session_title text,
  add column image_count   int not null default 1,
  -- モックの各カードにある「自由テキスト指示」。カテゴリ名をキーにした JSON。
  -- ★ PoC 側は禁止事項②により自由入力を実装していない。ここは確定 UI に合わせて
  --   受け付けるが、全文を必ず記録して後から監査できるようにする。
  add column free_texts    jsonb not null default '{}'::jsonb,
  add column removal_type  text;

comment on column public.jobs.free_texts is
  '利用者が入力した自由テキスト。PoC（../poc）は禁止事項②により自由入力を持たない。'
  'こちらは確定 UI に合わせて受け付けるため、全文を記録して監査可能にしてある。';

-- 1 枚ごとの列は job_images へ移すので、jobs 側からは外す
alter table public.jobs
  drop column result_path,
  drop column latency_ms,
  drop column actual_cost_usd,
  drop column error_kind,
  drop column error_message,
  drop column makeup_strength,
  drop column prompt_hash;

-- ---------------------------------------------------------------------------
-- 3. スロット（1 枚ずつ）
-- ---------------------------------------------------------------------------

create table public.job_images (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references public.jobs(id) on delete cascade,
  -- 画面のスロット番号（0〜5）。並び順を DB 側で固定する。
  slot             int not null,
  makeup_strength  text not null,
  variant          int  not null check (variant in (1, 2)),
  variant_strategy text not null,
  prompt_hash      text not null,
  status           public.job_status not null default 'queued',
  result_path      text,
  actual_cost_usd  numeric(12,6),
  latency_ms       int,
  error_kind       text check (error_kind in ('policy', 'input', 'infra')),
  error_message    text,
  started_at       timestamptz,
  finished_at      timestamptz,
  unique (job_id, slot)
);

create index job_images_job_idx on public.job_images (job_id, slot);

alter table public.job_images enable row level security;

create policy "自分のジョブの画像だけ読める"
  on public.job_images for select
  to authenticated
  using (exists (
    select 1 from public.jobs j
     where j.id = job_images.job_id
       and j.user_id = (select auth.uid())
  ));

-- ---------------------------------------------------------------------------
-- 4. 上限の既定値を「1 回 6 枚」前提へ直す
--
--   1 枚あたり約 $0.083 なので、1 回の生成で約 $0.50 かかる。
--   1 枚前提の既定値（日次 $5・1 人 10 枚）のままだと、1 人が 2 回も押せない。
-- ---------------------------------------------------------------------------

alter table public.demo_limits
  add column images_per_job   int  not null default 6,
  -- 同一条件 2 枚の作り分け方（機能仕様書 4.2.4・区分 A-2 は未確定）。
  --   identical   … 案 1：同一プロンプトを 2 回
  --   micro_delta … 案 2：表情・向き・照明に軽微な差分
  -- 確定 UI が「パターン A / パターン B」と見せる以上、既定は案 2 とする。
  -- ここを切り替えれば、そのまま T-03 の比較に使える。
  add column variant_strategy text not null default 'micro_delta'
    check (variant_strategy in ('identical', 'micro_delta'));

update public.demo_limits
   set daily_budget_usd = 10.0000,
       daily_max_images = 120,
       default_user_max_images = 24;

update public.allowed_emails set max_images = 24 where max_images = 10;
