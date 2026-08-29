-- ============================================================================
-- 除去を Gemini にも回せるようにする（委託者指示）
--
-- ★ Gemini にマスク画像は渡せない。
--   マスク編集対応だった imagen-3.0-capability-001 は 2026-06-30 に停止済みで、
--   2026-08-28 時点のモデル一覧にも inpaint/mask 対応は 1 つも無い
--   （画像モデルはすべて generateContent のみ）。
--
--   そこで Gemini へは semantic masking で回す：
--     元画像 ＋ 除去範囲の輪郭を描き込んだ目印つき画像 ＋ 位置を述べた文章
--
-- ★ inpaint とは別方式である。「マスク外は不変」の保証が無いため、
--   どちらで作ったのかを必ず記録する。混ぜると T-02 の判定基準
--   （マスク外に変化なしが 8 割以上）を誤って当てはめることになる。
-- ============================================================================

alter table public.job_images
  add column edit_method text
    check (edit_method in ('inpaint', 'semantic_mask', 'instruct'));

comment on column public.job_images.edit_method is
  'inpaint＝マスク画像を API へ渡す方式（OpenAI・マスク外の不変を仕組みで担保）／semantic_mask＝目印つき画像と文章で範囲を伝える方式（Google・保証は無い）／instruct＝通常加工。T-02 の判定基準は inpaint にしか適用できない。';

alter table public.demo_limits
  add column removal_fallback_enabled boolean not null default true;

comment on column public.demo_limits.removal_fallback_enabled is
  '除去で OpenAI が失敗したとき、Gemini の semantic masking へ回すか。別方式なので、測定目的では off にして OpenAI 単独の結果だけを見る運用も選べる。';
