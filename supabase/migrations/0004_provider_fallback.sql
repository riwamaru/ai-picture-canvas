-- ============================================================================
-- ① OpenAI → Google のフォールバック（委託者指示：まず openai、無理なら gemini）
-- ② タトゥー除去を独立したモードとして分ける
--
-- 【なぜ必要になったか】
-- PoC の実測（docs/日報_2026-08-16.md）で次が判明した：
--   - OpenAI … 10 名 30 件すべて拒否（safety_violations=[sexual]）。被写体によらない
--   - Google … 35 件成功。10 名中 8 名は生成できる
-- OpenAI 専用のままでは、体験環境を配っても拒否しか表示されない。
--
-- 【確定 UI の記述との差分】
-- 確定 UI の設定モーダルは
--   「障害系エラー（5xx/タイムアウト/レート制限）のみフォールバック対象で、
--     ポリシー起因の拒否は再投入しません」
-- と書いてある。しかし実測では OpenAI の失敗は全件ポリシー拒否であり、
-- この規則のままだとフォールバックが一度も発動しない。
-- 委託者判断でポリシー拒否もフォールバック対象とした（設定で戻せる）。
--
-- 禁止事項③が禁じるのは「拒否された内容を文言を変えて再投入すること」であり、
-- 同一プロンプトを別ベンダーへ送ることはこれに当たらない。
-- また拒否は課金されないため、フォールバックによる追加費用は発生しない。
-- ============================================================================

alter table public.jobs
  add column job_mode text not null default 'normal'
    check (job_mode in ('normal', 'removal'));

alter table public.job_images
  add column provider                text check (provider in ('openai', 'google')),
  add column attempted_provider      text check (attempted_provider in ('openai', 'google')),
  add column attempted_error_kind    text check (attempted_error_kind in ('policy', 'input', 'infra')),
  add column attempted_error_message text;

alter table public.demo_limits
  add column fallback_enabled   boolean not null default true,
  add column primary_provider   text not null default 'openai'
    check (primary_provider in ('openai', 'google')),
  add column fallback_provider  text not null default 'google'
    check (fallback_provider in ('openai', 'google')),
  add column fallback_on_policy boolean not null default true;

-- Google は 1 枚 $0.134（OpenAI の medium 1024x1536 は約 $0.0795）。
-- 予約は高いほうで取るため、日次予算を上げておく。
update public.demo_limits set daily_budget_usd = 12.0000;
