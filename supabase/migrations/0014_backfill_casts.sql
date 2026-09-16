-- ============================================================================
-- 過去のセッションで使われた店舗・キャストを台帳へ取り込む（1 回だけ）
--
--   台帳（stores / casts）は 0012 で作ったが、それ以前に STEP 0 で打ち込まれた
--   名前は jobs に文字列として残っているだけで、台帳には無い。
--   管理画面を開いたら空だった、という状態を埋める。
--
--   キャスト名の末尾が「_YYYYMM」なら入店年月として分ける（仕様書 4.8 の表示名規則）。
-- ============================================================================

insert into public.stores (name, sort_order)
select distinct store_name, 100
  from public.jobs
 where store_name is not null and store_name <> ''
on conflict (name) do nothing;

insert into public.casts (store_id, name, joined_ym, source)
select distinct
       s.id,
       case when j.cast_name ~ '_[0-9]{6}$' then left(j.cast_name, length(j.cast_name) - 7) else j.cast_name end,
       case when j.cast_name ~ '_[0-9]{6}$' then right(j.cast_name, 6) else null end,
       'manual'
  from public.jobs j
  join public.stores s on s.name = j.store_name
 where j.cast_name is not null and j.cast_name <> ''
on conflict (store_id, name, joined_ym) do nothing;
