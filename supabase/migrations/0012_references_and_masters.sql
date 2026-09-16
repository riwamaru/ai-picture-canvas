-- ============================================================================
-- ① 参考画像（機能仕様書 v2.1 4.2.5 / F-01 / 種別 B）
-- ② 店舗・キャストの台帳（F-12 / F-14 / 4.8）
-- （委託者指示・2026-09-16）
-- ============================================================================

-- ---------------------------------------------------------------------------
-- ① 参考画像
--
--   仕様書 4.2.5：「参考画像そのものを編集 API へ送信する」「参考画像は Storage 上の
--   オブジェクト ID を生成ジョブに紐付けて記録し、生成結果からどの参考画像が
--   使われたかを追跡できるようにする」
--
--   カテゴリごとに Storage のパスを並べて持つ。例：
--     { "background": ["<user>/<job>/ref-background-1.png"], "clothing": [...] }
--   上限は各カテゴリ 2 枚・合計 6 枚（仕様書 4.2.5 の初期値。vendor/prompts の REFERENCE_LIMIT と同じ）。
-- ---------------------------------------------------------------------------

alter table public.jobs
  add column reference_paths jsonb not null default '{}'::jsonb;

comment on column public.jobs.reference_paths is
  '参考画像の Storage パス（カテゴリ名 → パスの配列）。仕様書 4.2.5「どの参考画像が使われたかを追跡できるようにする」。';

-- ---------------------------------------------------------------------------
-- ② 店舗・キャストの台帳
--
--   これまで店舗名は画面に固定で書かれ、キャスト名は画面内の一時的な配列だった。
--   管理画面から追加・編集・削除できる台帳にする。
--
--   ★ jobs の store_name / cast_name は文字列のまま残す（外部キーにしない）。
--     台帳側で改名・削除しても、過去のセッションの記録は「当時の名前」で読めるべきだから。
--     仕様書 4.7.1 も、改名で Drive のフォルダ紐付けが切れないよう ID で追う設計にしている。
--
--   ★ 同意状態（仕様書 4.9・D-4 確認待ち）はここに持たない。
--     体験環境ではアップロード者の同意チェック（jobs.rights_confirmed）で担保している。
-- ---------------------------------------------------------------------------

create table public.stores (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  sort_order  int  not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.casts (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores(id) on delete cascade,
  name        text not null,
  -- 'YYYYMM'。表示名は「名前_YYYYMM」（仕様書 4.8）。無ければ名前だけ
  joined_ym   text check (joined_ym is null or joined_ym ~ '^[0-9]{6}$'),
  note        text,
  active      boolean not null default true,
  -- 仕様書 4.8：'manual'（画面から登録）／'batch'（既存システムから同期。体験環境では使わない）
  source      text not null default 'manual' check (source in ('manual', 'batch')),
  created_at  timestamptz not null default now(),
  -- 仕様書 4.8：UNIQUE (store_id, name, joined_ym)。同月入店の同名は登録時に弾く
  unique (store_id, name, joined_ym)
);

create index casts_store_idx on public.casts (store_id, active, name);

comment on table public.stores is '店舗の台帳。管理画面から編集する。';
comment on table public.casts  is 'キャストの台帳（仕様書 4.8）。表示名は「名前_YYYYMM」。';

-- 画面の候補（datalist）に使うので、ログイン済みなら読める。書くのは service_role だけ。
alter table public.stores enable row level security;
alter table public.casts  enable row level security;

create policy "ログイン済みなら店舗を読める"
  on public.stores for select to authenticated using (true);

create policy "ログイン済みならキャストを読める"
  on public.casts for select to authenticated using (true);

-- 画面に固定で書かれていた店舗を台帳へ移す（これまでの入力と同じ名前で並ぶように）
insert into public.stores (name, sort_order) values
  ('THE ESPERANZA', 1),
  ('ESPERANZA ANNEX', 2),
  ('クラブ ピア', 3),
  ('いたずらBUNNYちゃん', 4)
on conflict (name) do nothing;
