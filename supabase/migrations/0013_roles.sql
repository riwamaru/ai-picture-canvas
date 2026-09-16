-- ============================================================================
-- ロール（機能仕様書 v2.1 F-08 / 4.6）を DB で持つ（委託者指示・2026-09-16）
--
--   これまで「管理者かどうか」は環境変数 ADMIN_EMAILS だけで決めていた。
--   招待画面でロールを選べるようにし、招待リスト（allowed_emails）と
--   利用者（profiles）の両方に持たせる。
--
--   ★ 今のロールは 2 つ：admin（管理者）／staff（利用者）。
--     仕様書 4.6 の「店長」は D-1（店舗ごとの閲覧範囲）が未確定で、
--     権限の中身が決まっていない。決まったら 'manager' を足す。
--     効かないロールを先に置くと「選べるのに何も変わらない」になるので置かない。
--
--   ★ ADMIN_EMAILS は「安全弁」として残す（環境変数に載っている人は常に管理者）。
--     無いと、誤って全員を利用者に落としたとき誰も管理画面へ入れなくなる。
-- ============================================================================

alter table public.allowed_emails
  add column role text not null default 'staff' check (role in ('admin', 'staff'));

alter table public.profiles
  add column role text not null default 'staff' check (role in ('admin', 'staff'));

comment on column public.profiles.role is
  'admin＝管理者（/admin と管理 API を使える）／staff＝利用者。ADMIN_EMAILS に載っている人は値によらず管理者。';

-- 招待時のロールを、サインアップ時に profiles へ写す
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

  insert into public.profiles (id, email, max_images, role)
  values (new.id, lower(new.email), v_allowed.max_images, v_allowed.role);

  return new;
end;
$$;

-- 既存の利用者：招待リストの値をそのまま写す（既定は staff）
update public.profiles p
   set role = a.role
  from public.allowed_emails a
 where a.email = p.email;
