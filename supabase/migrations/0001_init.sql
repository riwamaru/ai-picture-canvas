-- ============================================================================
-- AI Canvas 体験用デモ環境 — 初期スキーマ
--
-- ★ この環境は PoC 測定システム（../poc）とは別物である。
--   PoC は「マニフェストに申告済みの素材だけを扱う」設計（指示書 3.2 / 関所①隔離）だが、
--   こちらは任意画像のアップロードを受け付ける。よって：
--     - 記録を PoC の output/*/results.jsonl に混ぜない（封印済みの母数と判定基準を壊さないため）
--     - API キーを分ける（A-4「PoC にいくらかかったか」の測定を汚さないため）
--     - 権利の申告をマニフェストではなく「アップロード者の同意記録」で担保する
--
-- ★ サーバーレス（Vercel）ではプロセス内カウンタが使えない。
--   PoC の 6 重ブレーキに相当する歯止めは、すべてこの DB 側に置く。
--   reserve_generation() が唯一の入口で、行ロックにより同時実行でも二重に通らない。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 招待制（allowlist）
-- ---------------------------------------------------------------------------

create table public.allowed_emails (
  email       text primary key,
  max_images  int  not null default 10,
  note        text,
  invited_at  timestamptz not null default now()
);

comment on table public.allowed_emails is
  '招待済みメールアドレス。ここに無いアドレスは auth.users へ入れない（on_auth_user_created が拒否する）。';

create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null unique,
  max_images    int  not null default 10,
  used_images   int  not null default 0,
  last_call_at  timestamptz,
  created_at    timestamptz not null default now()
);

comment on column public.profiles.used_images is
  '消費した枚数。生成の予約時に加算し、インフラ障害で失敗したときだけ返却する（policy 拒否・入力不備では返さない）。';

-- 招待されていないアドレスのサインアップを DB 側で止める。
-- アプリ側でも shouldCreateUser:false にしているが、設定を戻しても破れないようにここにも置く。
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed public.allowed_emails%rowtype;
begin
  select * into v_allowed
    from public.allowed_emails
   where email = lower(new.email);

  if not found then
    raise exception '招待されていないメールアドレスです: %', new.email
      using errcode = 'check_violation';
  end if;

  insert into public.profiles (id, email, max_images)
  values (new.id, lower(new.email), v_allowed.max_images);

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 2. 上限設定と使用量（＝ブレーキの実体）
-- ---------------------------------------------------------------------------

create table public.demo_limits (
  id                      boolean primary key default true,
  enabled                 boolean not null default true,
  daily_budget_usd        numeric(10,4) not null default 5.0000,
  daily_max_images        int not null default 60,
  global_min_interval_ms  int not null default 10000,
  user_min_interval_ms    int not null default 60000,
  default_user_max_images int not null default 10,
  updated_at              timestamptz not null default now(),
  constraint demo_limits_singleton check (id)
);

comment on table public.demo_limits is
  'デモ環境の歯止め。1 行のみ。enabled=false にすると全ユーザーの生成が即座に止まる（緊急停止）。';

insert into public.demo_limits (id) values (true);

create table public.usage_daily (
  day      date primary key,
  images   int not null default 0,
  cost_usd numeric(12,6) not null default 0
);

comment on table public.usage_daily is
  '日次の使用量。日付は Asia/Tokyo で切る。';

create table public.rate_gate (
  id           boolean primary key default true,
  last_call_at timestamptz,
  constraint rate_gate_singleton check (id)
);

comment on table public.rate_gate is
  '全体の呼び出し間隔の床。1 行のみ。暴走時にまとめて走らせないための歯止め。';

insert into public.rate_gate (id) values (true);

-- ---------------------------------------------------------------------------
-- 3. 生成ジョブの記録
-- ---------------------------------------------------------------------------

create type public.job_status as enum ('running', 'succeeded', 'failed');

create table public.jobs (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles(id) on delete cascade,
  status             public.job_status not null default 'running',

  scenario_id        text not null,
  category_ids       text[] not null,
  makeup_strength    text not null,
  template_ids       jsonb not null default '{}'::jsonb,
  prompt_hash        text not null,
  template_version   text not null,
  model_name         text,

  source_path        text not null,
  mask_path          text,
  result_path        text,

  estimated_cost_usd numeric(12,6) not null default 0,
  actual_cost_usd    numeric(12,6),
  latency_ms         int,

  -- PoC の results.jsonl と同じ 3 分類（policy / input / infra）。
  -- 分類を揃えておくと、デモで観測した拒否も PoC の分類表へ持ち込める。
  error_kind         text check (error_kind in ('policy', 'input', 'infra')),
  error_message      text,

  -- アップロード者が「本人の同意を得た画像である」と申告したことの記録。
  -- PoC 側のマニフェスト rights に相当する担保。
  rights_confirmed   boolean not null default false,

  usage_day          date not null,
  created_at         timestamptz not null default now(),
  finished_at        timestamptz
);

create index jobs_user_created_idx on public.jobs (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. RLS
--
--   書き込みはすべて service_role（API ルート）が行う。service_role は RLS を迂回する。
--   ブラウザから来る authenticated ロールには「自分の行を読む」だけを許す。
--   allowed_emails / demo_limits / usage_daily / rate_gate はポリシーを 1 つも作らない
--   ＝ authenticated からは読むことすらできない。
-- ---------------------------------------------------------------------------

alter table public.allowed_emails enable row level security;
alter table public.profiles       enable row level security;
alter table public.demo_limits    enable row level security;
alter table public.usage_daily    enable row level security;
alter table public.rate_gate      enable row level security;
alter table public.jobs           enable row level security;

create policy "自分のプロフィールだけ読める"
  on public.profiles for select
  to authenticated
  using (id = (select auth.uid()));

create policy "自分のジョブだけ読める"
  on public.jobs for select
  to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 5. ブレーキ本体
--
--   ★ 生成の直前に必ずこれを通す。ここを通らない経路を作ってはならない。
--   ★ 行ロックの取得順を demo_limits → profiles → usage_daily → rate_gate に固定している。
--     順序が揃っていないと同時実行でデッドロックする。
-- ---------------------------------------------------------------------------

create or replace function public.reserve_generation(p_user uuid, p_est_cost numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lim     public.demo_limits;
  v_prof    public.profiles;
  v_day     public.usage_daily;
  v_gate    public.rate_gate;
  v_today   date := (now() at time zone 'Asia/Tokyo')::date;
  v_wait_ms bigint;
  v_wait_s  int;
begin
  -- ① 全体の停止スイッチ
  select * into v_lim from public.demo_limits where id = true for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_limits',
      'message', '上限設定（demo_limits）がありません。管理者へ連絡してください。');
  end if;
  if not v_lim.enabled then
    return jsonb_build_object('ok', false, 'reason', 'disabled',
      'message', '管理者により生成が停止されています。');
  end if;

  -- ② 利用者ごとの枚数上限
  select * into v_prof from public.profiles where id = p_user for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_profile',
      'message', '利用登録がありません。招待を受けたアドレスでログインし直してください。');
  end if;
  if v_prof.used_images >= v_prof.max_images then
    return jsonb_build_object('ok', false, 'reason', 'user_quota',
      'message', format('あなたの上限に達しました（%s / %s 枚）。追加が必要なら管理者へ依頼してください。',
                        v_prof.used_images, v_prof.max_images));
  end if;

  -- ③ 利用者ごとの呼び出し間隔
  if v_prof.last_call_at is not null then
    v_wait_ms := v_lim.user_min_interval_ms
                 - (extract(epoch from (now() - v_prof.last_call_at)) * 1000)::bigint;
    if v_wait_ms > 0 then
      v_wait_s := ceil(v_wait_ms / 1000.0);
      return jsonb_build_object('ok', false, 'reason', 'user_interval',
        'retry_after_seconds', v_wait_s,
        'message', format('前回の生成から %s 秒お待ちください。', v_wait_s));
    end if;
  end if;

  -- ④ 日次の枚数・予算
  insert into public.usage_daily (day) values (v_today) on conflict (day) do nothing;
  select * into v_day from public.usage_daily where day = v_today for update;

  if v_day.images >= v_lim.daily_max_images then
    return jsonb_build_object('ok', false, 'reason', 'daily_images',
      'message', format('本日の枚数上限に達しました（%s / %s 枚）。明日また試してください。',
                        v_day.images, v_lim.daily_max_images));
  end if;
  if v_day.cost_usd + p_est_cost > v_lim.daily_budget_usd then
    return jsonb_build_object('ok', false, 'reason', 'daily_budget',
      'message', format('本日の予算上限に達しました（$%s / $%s）。明日また試してください。',
                        round(v_day.cost_usd, 4), v_lim.daily_budget_usd));
  end if;

  -- ⑤ 全体の呼び出し間隔
  select * into v_gate from public.rate_gate where id = true for update;
  if v_gate.last_call_at is not null then
    v_wait_ms := v_lim.global_min_interval_ms
                 - (extract(epoch from (now() - v_gate.last_call_at)) * 1000)::bigint;
    if v_wait_ms > 0 then
      v_wait_s := ceil(v_wait_ms / 1000.0);
      return jsonb_build_object('ok', false, 'reason', 'global_interval',
        'retry_after_seconds', v_wait_s,
        'message', format('他の方の生成中です。%s 秒後にもう一度押してください。', v_wait_s));
    end if;
  end if;

  -- ⑥ 予約を確定する（見積で先に引く。実額は settle_generation で差し替える）
  update public.profiles
     set used_images = used_images + 1, last_call_at = now()
   where id = p_user;
  update public.usage_daily
     set images = images + 1, cost_usd = cost_usd + p_est_cost
   where day = v_today;
  update public.rate_gate set last_call_at = now() where id = true;

  return jsonb_build_object(
    'ok', true,
    'day', v_today,
    'remaining_user_images', v_prof.max_images - v_prof.used_images - 1,
    'remaining_daily_images', v_lim.daily_max_images - v_day.images - 1,
    'remaining_daily_budget_usd', v_lim.daily_budget_usd - v_day.cost_usd - p_est_cost
  );
end;
$$;

comment on function public.reserve_generation is
  '生成の予約。上限に触れたら ok=false を返す（例外は投げない）。API ルートはこれが ok=true のときだけ OpenAI を呼ぶ。';

-- 生成後の精算。見積で引いた分を実額へ差し替える。
--   p_refund_image = true のときだけ枚数を返す。
--   インフラ障害（こちら側の都合）でのみ true にする。
--   policy 拒否・入力不備で返してしまうと、拒否されるまで何度でも試せることになる。
create or replace function public.settle_generation(
  p_user         uuid,
  p_day          date,
  p_est_cost     numeric,
  p_actual_cost  numeric,
  p_refund_image boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.usage_daily
     set cost_usd = greatest(0, cost_usd - p_est_cost + coalesce(p_actual_cost, 0)),
         images   = case when p_refund_image then greatest(0, images - 1) else images end
   where day = p_day;

  if p_refund_image then
    update public.profiles
       set used_images = greatest(0, used_images - 1)
     where id = p_user;
  end if;
end;
$$;

-- ブラウザから直接叩けないようにする（service_role だけが呼ぶ）。
revoke execute on function public.reserve_generation(uuid, numeric) from public, anon, authenticated;
revoke execute on function public.settle_generation(uuid, date, numeric, numeric, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Storage
--
--   どちらも非公開。ブラウザへは API ルートが発行する署名付き URL でだけ渡す。
--   storage.objects にポリシーを作らない ＝ authenticated からは直接触れない。
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('sources', 'sources', false, 15728640, array['image/png', 'image/jpeg', 'image/webp']),
  ('results', 'results', false, 15728640, array['image/png', 'image/jpeg']);

-- ---------------------------------------------------------------------------
-- 7. トリガ関数を PostgREST から隠す
--    security definer の関数は public スキーマに置くと /rest/v1/rpc/ で叩けてしまう。
--    トリガ以外から呼べば Postgres 側で落ちるが、公開しておく理由が無いので塞ぐ。
-- ---------------------------------------------------------------------------

revoke execute on function public.handle_new_user() from public, anon, authenticated;
