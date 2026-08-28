-- ============================================================================
-- Slack 通知（確定 UI の設定モーダル F-10「Slack Webhook 通知」を実動作にする）
--
-- 委託者の指示：1 送信ごとに生成枚数・料金などの生成ログを Slack へ送る。
--
-- ★ Slack へは画像も署名付き URL も送らない。テキストの実績値だけを送る。
--   送ると、チャンネルにいる全員が顔写真を開けてしまい、
--   招待制で守っている前提が崩れる。
-- ============================================================================

alter table public.demo_limits
  add column slack_enabled          boolean not null default true,
  add column slack_on_limit         boolean not null default true,
  add column slack_include_subject  boolean not null default true;

comment on column public.demo_limits.slack_include_subject is
  '店舗名・キャスト名を Slack 本文に含めるか。false にすると「(非表示)」になる。画像と署名付き URL は設定によらず常に送らない。';

create table public.slack_deliveries (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid references public.jobs(id) on delete set null,
  kind        text not null check (kind in ('job', 'limit')),
  ok          boolean not null,
  status_code int,
  error       text,
  created_at  timestamptz not null default now()
);

create index slack_deliveries_created_idx on public.slack_deliveries (created_at desc);

alter table public.slack_deliveries enable row level security;
-- ポリシーを作らない ＝ service_role（サーバー側）だけが読み書きする
