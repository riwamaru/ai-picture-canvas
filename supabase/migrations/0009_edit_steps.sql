-- ============================================================================
-- 個別修正（機能仕様書 v2.1 F-05 逐次編集）
--
--   「チャットによるやり直し。直前の生成画像を入力とする逐次編集として実行する。
--     連続 5 回を超える場合は原本からの再編集を推奨する警告を表示する」
--
-- ★ 利用者の自由文をそのまま指示として送る（委託者判断・2026-09-16）。
--   PoC の禁止事項②（自由入力の禁止）とは相容れないため、
--   指示の全文を必ず記録し、後から監査できるようにする。
--   テストで問題が出たら、定型の語彙から選ぶ方式へ切り替える前提。
--
-- ★ 1 回ごとに 1 行。何を入力にしたか（ドラフトの何枚目か／直前の何回目か）を残す。
--   これが無いと「5 回目の結果が変なのは、どこで崩れたのか」を追えない。
-- ============================================================================

create table public.edit_steps (
  id                      uuid primary key default gen_random_uuid(),
  job_id                  uuid not null references public.jobs(id) on delete cascade,
  user_id                 uuid not null references public.profiles(id) on delete cascade,

  -- 同じジョブの中で何回目か（1 から）
  step_no                 int not null,

  -- 入力にした画像。'draft'＝6 枚のうちの 1 枚、'step'＝直前の修正結果
  source_kind             text not null check (source_kind in ('draft', 'step')),
  source_slot             int,
  source_step_id          uuid references public.edit_steps(id) on delete set null,

  -- 利用者の指示（自由文・全文）。★ 監査のため切り詰めない
  instruction             text not null,
  prompt_hash             text not null,

  status                  public.job_status not null default 'queued',
  provider                text check (provider in ('openai', 'google')),
  attempted_provider      text check (attempted_provider in ('openai', 'google')),
  attempted_error_kind    text check (attempted_error_kind in ('policy', 'input', 'infra')),
  attempted_error_message text,

  result_path             text,
  reserved_cost_usd       numeric(12,6) not null default 0,
  actual_cost_usd         numeric(12,6),
  latency_ms              int,
  error_kind              text check (error_kind in ('policy', 'input', 'infra')),
  error_message           text,

  created_at              timestamptz not null default now(),
  started_at              timestamptz,
  finished_at             timestamptz,

  unique (job_id, step_no),
  -- 入力元は必ずどちらか一方
  constraint edit_steps_source_check check (
    (source_kind = 'draft' and source_slot is not null and source_step_id is null) or
    (source_kind = 'step'  and source_step_id is not null and source_slot is null)
  )
);

comment on table public.edit_steps is
  '個別修正（F-05 逐次編集）の 1 回ごとの記録。自由文の指示を全文残す（監査のため）。';

create index edit_steps_job_idx on public.edit_steps (job_id, step_no);

alter table public.edit_steps enable row level security;

create policy "自分のジョブの修正だけ読める"
  on public.edit_steps for select
  to authenticated
  using (user_id = (select auth.uid()));

-- 確定画像の入力元に「修正結果」も取れるようにする（仕様書 STEP 4 → STEP 5）。
-- source_slot は「どのドラフト系統か」を残すために引き続き持つ。
alter table public.final_images
  add column source_step_id uuid references public.edit_steps(id) on delete set null;

comment on column public.final_images.source_step_id is
  '個別修正を経てから確定した場合、その最後の修正。null ならドラフトを直接確定した。';
