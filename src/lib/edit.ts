import type { SupabaseClient } from "@supabase/supabase-js";
import { createProvider, estimateOne, type ProviderKeys } from "./generate";
import { DEMO_RESOLUTION, PER_CALL_TIMEOUT_MS, type ProviderName } from "./models";
import { classifyError } from "./vendor/providers/errors";
import { promptHash } from "./vendor/prompts/hash";
import { IDENTITY_GUARD_INSTRUCTION } from "./vendor/prompts/templates";
import { notifyJobFinished, type SlackSettings } from "./slack";

/**
 * 個別修正（機能仕様書 v2.1 F-05 逐次編集）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 仕様書 F-05：
 *   「チャットによるやり直し。直前の生成画像を入力とする逐次編集として実行する。
 *     連続 5 回を超える場合は原本からの再編集を推奨する警告を表示する」
 *
 * 【自由文をそのまま送る】
 * 委託者判断（2026-09-16）により、利用者の指示文をそのまま API へ送る。
 * PoC の禁止事項②（自由入力の禁止）とは相容れないので、
 *   - 指示の全文を edit_steps.instruction に必ず残す（監査）
 *   - 生成 AI に指示文を書き換えさせない（仕様書 4.5.3）
 * テストで問題が出たら、定型の語彙から選ぶ方式へ切り替える前提。
 *
 * 【逐次】
 * 入力は「直前の修正結果」。原本（ドラフト）ではない。
 * 5 回を超えると劣化が蓄積するので警告を返す（止めはしない）。
 * 利用者は「候補からやり直す」で系統を原本へ戻せる。
 * ═══════════════════════════════════════════════════════════════
 */

/** 仕様書 F-05：この回数を超えたら原本からの再編集を推奨する。 */
export const EDIT_CHAIN_WARN_AFTER = 5;

/** 自由文の上限。長すぎる指示は効きが散るうえ、記録も膨らむ。 */
export const INSTRUCTION_MAX = 300;

export type EditOutcome =
  | {
      ok: true;
      stepId: string;
      stepNo: number;
      /** この修正が何回目の連続修正か（原本からやり直すと 1 に戻る）。 */
      chainLength: number;
      /** 5 回を超えたときの推奨文。仕様書 F-05。 */
      warning: string | null;
      provider: ProviderName;
      costUsd: number;
      latencyMs: number;
      resultPath: string;
    }
  | {
      ok: false;
      reason: "limit" | "failed" | "invalid" | "busy";
      message: string;
      retryAfterSeconds?: number;
      errorKind?: "policy" | "input" | "infra";
    };

/**
 * 指示文からプロンプトを組む。
 *
 * ★ 指示文には手を入れない。前後に「それ以外は変えない」「本人性を保つ」の枠を付けるだけ。
 *   これは PoC のドラフト生成と同じ枠で、無効カテゴリを「変えるな」と明示する考え方に合わせている
 *   （黙っていると、実測では姿勢・画角が全件変わった）。
 */
export function buildEditPrompt(instruction: string): { text: string; hash: string } {
  const text = [
    "Apply the following instruction to the provided photograph, and nothing else:",
    `"${instruction}"`,
    "Keep everything the instruction does not mention exactly as-is: the person, pose, framing, background, clothing, and lighting. " +
      "Do not re-compose, re-crop, re-frame, or re-shoot the scene.",
    IDENTITY_GUARD_INSTRUCTION,
  ].join("\n");

  return { text, hash: promptHash({ kind: "edit", instruction }) };
}

type JobRow = { id: string; user_id: string; job_mode: "normal" | "removal"; store_name: string | null; cast_name: string | null; session_title: string | null };
type StepRow = {
  id: string;
  step_no: number;
  source_kind: "draft" | "step";
  source_slot: number | null;
  status: string;
  provider: ProviderName | null;
  result_path: string | null;
};

export async function runEditStep(
  admin: SupabaseClient,
  input: {
    jobId: string;
    userId: string;
    email: string;
    instruction: string;
    /** 指定すると、その候補を入力にして系統を原本からやり直す。 */
    fromDraftSlot: number | null;
  },
): Promise<EditOutcome> {
  const instruction = input.instruction.trim().slice(0, INSTRUCTION_MAX);
  if (!instruction) return { ok: false, reason: "invalid", message: "指示を入力してください。" };

  const { data: job } = await admin
    .from("jobs")
    .select("id, user_id, job_mode, store_name, cast_name, session_title")
    .eq("id", input.jobId)
    .maybeSingle<JobRow>();
  if (!job) return { ok: false, reason: "invalid", message: "対象が見つかりません。" };

  const { data: steps } = await admin
    .from("edit_steps")
    .select("id, step_no, source_kind, source_slot, status, provider, result_path")
    .eq("job_id", input.jobId)
    .order("step_no", { ascending: true })
    .returns<StepRow[]>();
  const history = steps ?? [];

  if (history.some((s) => s.status === "running")) {
    return { ok: false, reason: "busy", message: "前の修正を処理中です。しばらくお待ちください。" };
  }

  // ── 入力元を決める ──
  //
  // 指定があればその候補（原本）から。無ければ直前の成功した修正から。
  // どちらも無ければ、候補を選んでもらう。
  const lastOk = [...history].reverse().find((s) => s.status === "succeeded" && s.result_path);

  let source: { kind: "draft"; slot: number; path: string; provider: ProviderName | null } |
              { kind: "step"; stepId: string; path: string; provider: ProviderName | null };

  if (input.fromDraftSlot !== null || !lastOk) {
    const slot = input.fromDraftSlot;
    if (slot === null) {
      return { ok: false, reason: "invalid", message: "先に修正したい候補を 1 枚選んでください。" };
    }
    const { data: draft } = await admin
      .from("job_images")
      .select("slot, status, result_path, provider")
      .eq("job_id", input.jobId)
      .eq("slot", slot)
      .maybeSingle();
    if (!draft || draft.status !== "succeeded" || !draft.result_path) {
      return { ok: false, reason: "invalid", message: "その候補には修正できる画像がありません。" };
    }
    source = { kind: "draft", slot, path: draft.result_path as string, provider: (draft.provider as ProviderName | null) ?? null };
  } else {
    source = { kind: "step", stepId: lastOk.id, path: lastOk.result_path!, provider: lastOk.provider };
  }

  // 連続回数：最後に原本から始めた修正以降の成功回数 ＋ 今回
  let chainLength = 1;
  if (source.kind === "step") {
    let count = 0;
    for (const s of [...history].reverse()) {
      if (s.status !== "succeeded") continue;
      count += 1;
      if (s.source_kind === "draft") break;
    }
    chainLength = count + 1;
  }
  const warning =
    chainLength > EDIT_CHAIN_WARN_AFTER
      ? `連続 ${chainLength} 回目の修正です。回を重ねるほど画質が劣化します。候補からやり直すことをお勧めします（仕様書 F-05）。`
      : null;

  const stepNo = (history.at(-1)?.step_no ?? 0) + 1;

  // ── 試す順番：入力画像を作ったプロバイダを先に（見た目の連続性のため） ──
  const { data: limits } = await admin
    .from("demo_limits")
    .select("fallback_enabled, fallback_on_policy, primary_provider, slack_enabled, slack_on_limit, slack_include_subject, daily_budget_usd, daily_max_images")
    .eq("id", true)
    .maybeSingle();
  const first: ProviderName = source.provider ?? ((limits?.primary_provider as ProviderName | undefined) ?? "openai");
  const second: ProviderName = first === "openai" ? "google" : "openai";
  const chain: ProviderName[] = limits?.fallback_enabled === false ? [first] : [first, second];

  const keys: ProviderKeys = { openai: process.env.OPENAI_API_KEY, google: process.env.GEMINI_API_KEY };
  const usable = chain.filter((name) => createProvider(name, keys) !== null);
  if (usable.length === 0) return { ok: false, reason: "failed", message: "画像生成の API キーが設定されていません。" };

  // ── 上限（★ ここを迂回する経路を作ってはならない） ──
  const perImageUsd = Math.max(...usable.map((name) => estimateOne(name, false, DEMO_RESOLUTION)));
  const { data: reservation, error: reserveError } = await admin.rpc("reserve_generation", {
    p_user: input.userId,
    p_est_cost: perImageUsd,
    p_count: 1,
  });
  if (reserveError) return { ok: false, reason: "failed", message: `上限の確認に失敗しました: ${reserveError.message}` };
  const reserved = reservation as { ok: boolean; message?: string; day?: string; retry_after_seconds?: number };
  if (!reserved.ok) {
    return { ok: false, reason: "limit", message: reserved.message ?? "上限に達しました。", retryAfterSeconds: reserved.retry_after_seconds };
  }
  const usageDay = reserved.day!;

  const built = buildEditPrompt(instruction);

  const { data: row, error: rowError } = await admin
    .from("edit_steps")
    .insert({
      job_id: input.jobId,
      user_id: input.userId,
      step_no: stepNo,
      source_kind: source.kind,
      source_slot: source.kind === "draft" ? source.slot : null,
      source_step_id: source.kind === "step" ? source.stepId : null,
      instruction,
      prompt_hash: built.hash,
      status: "running",
      reserved_cost_usd: perImageUsd,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .maybeSingle();
  if (rowError || !row) {
    await settle(admin, input.userId, usageDay, perImageUsd, 0, 1);
    return { ok: false, reason: "failed", message: `修正を開始できません: ${rowError?.message ?? "不明"}` };
  }
  const stepId = row.id as string;

  const { data: file, error: dlError } = await admin.storage.from("results").download(source.path);
  if (dlError || !file) {
    await failStep(admin, stepId, "infra", "入力画像を取得できませんでした。");
    await settle(admin, input.userId, usageDay, perImageUsd, 0, 1);
    return { ok: false, reason: "failed", errorKind: "infra", message: "入力画像を取得できませんでした。" };
  }
  const sourceBytes = new Uint8Array(await file.arrayBuffer());

  const startedAt = Date.now();
  let attempted: { provider: ProviderName; kind: string; detail: string } | null = null;

  for (let index = 0; index < usable.length; index += 1) {
    const name = usable[index]!;
    const provider = createProvider(name, keys)!;
    const isLast = index === usable.length - 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS);

    try {
      const result = await provider.edit(
        { mode: "instruct", baseImage: sourceBytes, prompt: built.text, resolution: DEMO_RESOLUTION },
        controller.signal,
      );

      const resultPath = `${input.userId}/${input.jobId}/edit-${stepNo}.png`;
      const { error: upError } = await admin.storage
        .from("results")
        .upload(resultPath, Buffer.from(result.image), { contentType: "image/png", upsert: true });
      if (upError) throw new Error(`修正結果を保存できませんでした: ${upError.message}`);

      await admin
        .from("edit_steps")
        .update({
          status: "succeeded",
          provider: name,
          attempted_provider: attempted?.provider ?? null,
          attempted_error_kind: attempted?.kind ?? null,
          attempted_error_message: attempted ? attempted.detail.slice(0, 2000) : null,
          result_path: resultPath,
          actual_cost_usd: result.estimatedCostUsd,
          latency_ms: result.latencyMs,
          finished_at: new Date().toISOString(),
        })
        .eq("id", stepId);

      await settle(admin, input.userId, usageDay, perImageUsd, result.estimatedCostUsd, 0);
      await notifyEdit(admin, limits, {
        jobId: input.jobId, email: input.email, job, mode: job.job_mode,
        instruction, stepNo, provider: name, attempted, costUsd: result.estimatedCostUsd,
        elapsedMs: Date.now() - startedAt, usageDay, succeeded: true, errorKind: null,
      });

      return {
        ok: true, stepId, stepNo, chainLength, warning,
        provider: name, costUsd: result.estimatedCostUsd, latencyMs: result.latencyMs, resultPath,
      };
    } catch (error) {
      const classified = classifyError(error);
      const canFallback =
        !isLast && classified.kind !== "input" &&
        (classified.kind !== "policy" || (limits?.fallback_on_policy ?? true));
      if (canFallback) {
        attempted = { provider: name, kind: classified.kind, detail: classified.detail };
        clearTimeout(timeout);
        continue;
      }

      await admin
        .from("edit_steps")
        .update({
          status: "failed",
          provider: name,
          attempted_provider: attempted?.provider ?? null,
          attempted_error_kind: attempted?.kind ?? null,
          attempted_error_message: attempted ? attempted.detail.slice(0, 2000) : null,
          error_kind: classified.kind,
          error_message: `${classified.code}: ${classified.detail}`.slice(0, 2000),
          finished_at: new Date().toISOString(),
        })
        .eq("id", stepId);

      await settle(admin, input.userId, usageDay, perImageUsd, 0, classified.kind === "infra" ? 1 : 0);
      await notifyEdit(admin, limits, {
        jobId: input.jobId, email: input.email, job, mode: job.job_mode,
        instruction, stepNo, provider: name, attempted, costUsd: 0,
        elapsedMs: Date.now() - startedAt, usageDay, succeeded: false, errorKind: classified.kind,
      });

      return {
        ok: false, reason: "failed", errorKind: classified.kind,
        message:
          classified.kind === "policy"
            ? "この指示は内容の判定により断られました。同じ内容を言い換えて再送することはしません。別の指示をお試しください。"
            : classified.kind === "input"
              ? `送信内容に不備があります: ${classified.detail}`
              : `修正を生成できませんでした: ${classified.detail}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  await failStep(admin, stepId, "infra", "試せるプロバイダがありませんでした。");
  await settle(admin, input.userId, usageDay, perImageUsd, 0, 1);
  return { ok: false, reason: "failed", errorKind: "infra", message: "修正を生成できませんでした。" };
}

async function failStep(admin: SupabaseClient, stepId: string, kind: "policy" | "input" | "infra", message: string) {
  await admin
    .from("edit_steps")
    .update({ status: "failed", error_kind: kind, error_message: message, finished_at: new Date().toISOString() })
    .eq("id", stepId);
}

async function settle(admin: SupabaseClient, userId: string, usageDay: string, est: number, actual: number, refund: number) {
  const { error } = await admin.rpc("settle_generation", {
    p_user: userId, p_day: usageDay, p_est_cost: est, p_actual_cost: actual, p_refund_images: refund,
  });
  if (error) console.error("[edit] 精算に失敗しました:", error.message);
}

/**
 * Slack への生成ログ（1 送信ごとに送る、という委託者指示に合わせる）。
 * 指示文は 40 字まで。人物を指すラベルになりうるので、店舗名などと同じ扱い（slack_include_subject）にする。
 */
async function notifyEdit(
  admin: SupabaseClient,
  limits: (SlackSettings & Record<string, unknown>) | null,
  info: {
    jobId: string; email: string; job: JobRow; mode: "normal" | "removal";
    instruction: string; stepNo: number; provider: ProviderName;
    attempted: { provider: ProviderName; kind: string } | null;
    costUsd: number; elapsedMs: number; usageDay: string; succeeded: boolean;
    errorKind: "policy" | "input" | "infra" | null;
  },
) {
  if (!limits?.slack_enabled) return;
  const { data: today } = await admin.from("usage_daily").select("images, cost_usd").eq("day", info.usageDay).maybeSingle();
  const shortInstruction = info.instruction.length > 40 ? `${info.instruction.slice(0, 40)}…` : info.instruction;
  await notifyJobFinished(admin, limits, {
    jobId: info.jobId,
    email: info.email,
    mode: info.mode,
    storeName: info.job.store_name,
    castName: info.job.cast_name,
    sessionTitle: info.job.session_title,
    contentJa: `個別修正 ${info.stepNo} 回目${limits.slack_include_subject ? `「${shortInstruction}」` : ""}`,
    requested: 1,
    succeeded: info.succeeded ? 1 : 0,
    policyRejected: info.errorKind === "policy" ? 1 : 0,
    inputRejected: info.errorKind === "input" ? 1 : 0,
    infraFailed: info.errorKind === "infra" ? 1 : 0,
    byProvider: info.succeeded ? { [info.provider]: 1 } : {},
    fellBack: info.succeeded && info.attempted ? 1 : 0,
    actualCostUsd: info.costUsd,
    elapsedMs: info.elapsedMs,
    todayImages: today?.images ?? 0,
    todayCostUsd: Number(today?.cost_usd ?? 0),
  }).catch(() => undefined);
}
