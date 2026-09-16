-- ============================================================================
-- 通常加工のドラフトを 6 枚 → 4 枚にする（委託者指示・2026-09-16）
--
--   生成する強度を「弱・中」の 2 段階に絞る（× 各 2 枚 ＝ 4 枚）。
--   「強」のプロンプトは使わない。画面では「中」を「強」と表示する。
--
-- ★ プロンプトも記録も変えない。job_images.makeup_strength には実際に使った
--   段階（weak / medium）がそのまま残る。呼び名の対応は画面側にだけ置く
--   （表示名で記録を上書きすると、後から PoC の測定と突き合わせられない）。
-- ============================================================================

alter table public.demo_limits
  alter column images_per_job set default 4;

update public.demo_limits set images_per_job = 4 where images_per_job > 4;

comment on column public.demo_limits.images_per_job is
  '1 回の生成で作る枚数。弱・中 × 各 2 枚 ＝ 4 が上限（2026-09-16 に 6 から変更。強は作らない）。';
