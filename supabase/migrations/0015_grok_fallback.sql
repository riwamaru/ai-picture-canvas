-- ============================================================================
-- OpenAI → Gemini → Grok の 3 段フォールバック（委託者指示・2026-10-06）
--
-- 「OpenAI → Gemini で拒否されたときの回し先に Grok を含める」。
--
-- ① provider / attempted_provider の CHECK に 'grok' を足す
--    （job_images / final_images / edit_steps / demo_limits）
-- ② demo_limits.second_fallback_provider … fallback でも失敗したときの回し先。
--    既定 'grok'。null にすると従来どおり 2 段で止まる。
-- ③ attempt_trail … 先に試して失敗したプロバイダを順に残す（[{provider, kind, detail}]）。
--    attempted_* は「最初に失敗したもの」（＝通常 OpenAI）のまま意味を変えない。
--    OpenAI の拒否率を数える用途に使っているため。
--
-- 禁止事項③（文言を変えた再投入）には当たらない。同一プロンプトを別ベンダーへ送るだけで、
-- 拒否は課金されない（0004_provider_fallback.sql と同じ整理）。
--
-- ★ アプリより先に当てること。アプリが second_fallback_provider / attempt_trail を
--   select するため、列が無いと設定の読み込みと候補の取得が失敗する。
-- ============================================================================

alter table public.job_images
  drop constraint job_images_provider_check,
  drop constraint job_images_attempted_provider_check,
  add constraint job_images_provider_check
    check (provider in ('openai', 'google', 'grok')),
  add constraint job_images_attempted_provider_check
    check (attempted_provider in ('openai', 'google', 'grok')),
  add column attempt_trail jsonb not null default '[]'::jsonb;

alter table public.final_images
  drop constraint final_images_provider_check,
  drop constraint final_images_attempted_provider_check,
  add constraint final_images_provider_check
    check (provider in ('openai', 'google', 'grok')),
  add constraint final_images_attempted_provider_check
    check (attempted_provider in ('openai', 'google', 'grok')),
  add column attempt_trail jsonb not null default '[]'::jsonb;

alter table public.edit_steps
  drop constraint edit_steps_provider_check,
  drop constraint edit_steps_attempted_provider_check,
  add constraint edit_steps_provider_check
    check (provider in ('openai', 'google', 'grok')),
  add constraint edit_steps_attempted_provider_check
    check (attempted_provider in ('openai', 'google', 'grok')),
  add column attempt_trail jsonb not null default '[]'::jsonb;

alter table public.demo_limits
  drop constraint demo_limits_primary_provider_check,
  drop constraint demo_limits_fallback_provider_check,
  add constraint demo_limits_primary_provider_check
    check (primary_provider in ('openai', 'google', 'grok')),
  add constraint demo_limits_fallback_provider_check
    check (fallback_provider in ('openai', 'google', 'grok')),
  add column second_fallback_provider text default 'grok'
    check (second_fallback_provider is null
           or second_fallback_provider in ('openai', 'google', 'grok'));
