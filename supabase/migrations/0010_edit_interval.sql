-- ============================================================================
-- 逐次編集（F-05）だけ、利用者ごとの呼び出し間隔を別に持つ（委託者指示・2026-09-16）
--
-- 6 枚生成の間隔（user_min_interval_ms・既定 60 秒）をそのまま修正にも当てると、
-- 「背景を暗く → 髪を明るく」と続けたいだけで毎回 1 分待たされる。
-- 逐次編集は 1 回 1 枚・約 20 秒なので、短い間隔で回してよい。
--
-- ★ 全体の間隔（global_min_interval_ms）は種別を問わず据え置く。
--   あれは「システム全体で同時に走らせない」ための床で、利用者の体験とは別の話。
-- ============================================================================

alter table public.demo_limits
  add column edit_min_interval_ms int not null default 5000;

comment on column public.demo_limits.edit_min_interval_ms is
  '逐次編集（F-05）の利用者ごとの呼び出し間隔。6 枚生成の user_min_interval_ms とは別。既定 5 秒。';

-- 引数を足すと別の関数として作られ、既存の 3 引数呼び出しが曖昧になるので、先に落とす。
drop function if exists public.reserve_generation(uuid, numeric, integer);

create or replace function public.reserve_generation(
  p_user     uuid,
  p_est_cost numeric,
  p_count    integer default 1,
  -- 'generate'（6 枚生成・確定）／'edit'（逐次編集）。間隔の選び分けにだけ使う。
  p_kind     text default 'generate'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_lim      public.demo_limits;
  v_prof     public.profiles;
  v_day      public.usage_daily;
  v_gate     public.rate_gate;
  v_today    date := (now() at time zone 'Asia/Tokyo')::date;
  v_wait_ms  bigint;
  v_wait_s   int;
  v_interval int;
begin
  if p_count < 1 then
    return jsonb_build_object('ok', false, 'reason', 'bad_count',
      'message', '生成枚数の指定が不正です。');
  end if;

  select * into v_lim from public.demo_limits where id = true for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_limits',
      'message', '上限設定（demo_limits）がありません。管理者へ連絡してください。');
  end if;
  if not v_lim.enabled then
    return jsonb_build_object('ok', false, 'reason', 'disabled',
      'message', '管理者により生成が停止されています。');
  end if;

  select * into v_prof from public.profiles where id = p_user for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_profile',
      'message', '利用登録がありません。招待を受けたアドレスでログインし直してください。');
  end if;

  -- 6 枚ぶんの空きが無ければ通さない（半端なジョブを作らない）
  if v_prof.used_images + p_count > v_prof.max_images then
    return jsonb_build_object('ok', false, 'reason', 'user_quota',
      'message', format('あなたの残り枚数が足りません（残り %s 枚 / 今回 %s 枚必要）。追加が必要なら管理者へ依頼してください。',
                        v_prof.max_images - v_prof.used_images, p_count));
  end if;

  -- ★ 利用者ごとの間隔は種別で切り替える
  v_interval := case when p_kind = 'edit' then v_lim.edit_min_interval_ms
                     else v_lim.user_min_interval_ms end;

  if v_prof.last_call_at is not null then
    v_wait_ms := v_interval
                 - (extract(epoch from (now() - v_prof.last_call_at)) * 1000)::bigint;
    if v_wait_ms > 0 then
      v_wait_s := ceil(v_wait_ms / 1000.0);
      return jsonb_build_object('ok', false, 'reason', 'user_interval',
        'retry_after_seconds', v_wait_s,
        'message', format(case when p_kind = 'edit' then '前回の修正から %s 秒お待ちください。'
                               else '前回の生成から %s 秒お待ちください。' end, v_wait_s));
    end if;
  end if;

  insert into public.usage_daily (day) values (v_today) on conflict (day) do nothing;
  select * into v_day from public.usage_daily where day = v_today for update;

  if v_day.images + p_count > v_lim.daily_max_images then
    return jsonb_build_object('ok', false, 'reason', 'daily_images',
      'message', format('本日の枚数上限に届きます（本日 %s / %s 枚・今回 %s 枚必要）。明日また試してください。',
                        v_day.images, v_lim.daily_max_images, p_count));
  end if;
  if v_day.cost_usd + p_est_cost > v_lim.daily_budget_usd then
    return jsonb_build_object('ok', false, 'reason', 'daily_budget',
      'message', format('本日の予算上限に届きます（本日 $%s / $%s・今回 約$%s）。明日また試してください。',
                        round(v_day.cost_usd, 2), v_lim.daily_budget_usd, round(p_est_cost, 2)));
  end if;

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

  update public.profiles
     set used_images = used_images + p_count, last_call_at = now()
   where id = p_user;
  update public.usage_daily
     set images = images + p_count, cost_usd = cost_usd + p_est_cost
   where day = v_today;
  update public.rate_gate set last_call_at = now() where id = true;

  return jsonb_build_object(
    'ok', true,
    'day', v_today,
    'count', p_count,
    'kind', p_kind,
    'variant_strategy', v_lim.variant_strategy,
    'remaining_user_images', v_prof.max_images - v_prof.used_images - p_count,
    'remaining_daily_images', v_lim.daily_max_images - v_day.images - p_count,
    'remaining_daily_budget_usd', v_lim.daily_budget_usd - v_day.cost_usd - p_est_cost
  );
end;
$function$;

comment on function public.reserve_generation is
  '生成の予約。上限に触れたら ok=false を返す（例外は投げない）。p_kind=''edit'' のときは逐次編集用の短い間隔を使う。';

-- ブラウザから直接呼べてはならない（既存の方針と同じ）
revoke execute on function public.reserve_generation(uuid, numeric, integer, text) from public, anon, authenticated;
