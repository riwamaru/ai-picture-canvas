import type { SupabaseClient } from "@supabase/supabase-js";
import { PROVIDER_LABEL, type ProviderName } from "./models";

/**
 * Slack への生成ログ通知。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【何を送り、何を送らないか】
 *
 * 送る    … 利用者・枚数・成功/拒否/失敗の内訳・プロバイダ・実費・所要時間・当日累計
 * 送らない … 生成画像、元画像、署名付き URL、プロンプト全文
 *
 * ★ 画像と署名付き URL を送ってはならない。
 *   署名付き URL は 1 時間有効なので、チャンネルにいる全員が顔写真を開けてしまう。
 *   この環境は「招待された本人と管理者だけが見られる」ことを前提に
 *   権利の同意を取っている。Slack へ流すとその前提が崩れる。
 *
 * ★ 店舗名・キャスト名は demo_limits.slack_include_subject で切り替えられる。
 *   キャスト名は人物を指すラベルになりうるため、チャンネルの参加範囲によっては
 *   落とす運用が要る。
 *
 * 【失敗しても生成を壊さない】
 *
 * 通知の失敗で生成結果が失われては本末転倒なので、例外は外へ出さない。
 * ただし黙って消さず、slack_deliveries に結果を残す
 * （「送ったつもりで届いていない」に気づけるようにするため）。
 * ═══════════════════════════════════════════════════════════════
 */

/** 送信先。ここ以外へは送らない（providers/http.ts の allowlist と同じ考え方）。 */
const ALLOWED_WEBHOOK_HOST = "hooks.slack.com";

export type SlackSettings = {
  slack_enabled: boolean;
  slack_on_limit: boolean;
  slack_include_subject: boolean;
  daily_budget_usd: number | string;
  daily_max_images: number;
};

export type JobSummary = {
  jobId: string;
  email: string;
  mode: "normal" | "removal";
  storeName: string | null;
  castName: string | null;
  sessionTitle: string | null;
  /** 表示用の加工内容（例: メイク(ナチュラル美肌)・背景）。 */
  contentJa: string;
  requested: number;
  succeeded: number;
  policyRejected: number;
  inputRejected: number;
  infraFailed: number;
  /** 実際に画像を返したプロバイダごとの枚数。 */
  byProvider: Partial<Record<ProviderName, number>>;
  /** フォールバックが起きた枚数。 */
  fellBack: number;
  actualCostUsd: number;
  elapsedMs: number;
  /** 当日の累計（この生成を含む）。 */
  todayImages: number;
  todayCostUsd: number;
};

/**
 * 送信先の検査。hooks.slack.com への https 以外は通さない。
 * providers/http.ts の ALLOWED_HOSTS と同じ考え方（送信先の取り違えを塞ぐ）。
 */
export function isAllowedWebhook(raw: string | undefined): boolean {
  if (!raw?.trim()) return false;
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === "https:" && parsed.host === ALLOWED_WEBHOOK_HOST;
  } catch {
    return false;
  }
}

/**
 * 値の中から Slack の Webhook URL を取り出す。
 *
 * ★ 環境変数は人が貼るものなので、引用符・前後の説明文・改行が混ざる。
 *   そのたびに「設定したのに動かない」で止まるのは無駄なので、
 *   hooks.slack.com への https URL が含まれていれば拾う。
 *
 * ★ ただし拾えるのは許可ホストのものだけ。
 *   別ホストの URL が混ざっていても拾わない（送信先の取り違えを塞ぐ趣旨は変えない）。
 */
export function extractWebhook(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();

  // 値そのものと、値の中に含まれる https URL の両方を候補にする。
  // ★ 値そのものも「掃除してから」検査する。掃除せずに先に通すと、
  //   末尾に句点が付いた URL（…abcdefg.）をそのまま採用してしまい、
  //   送信時に 404 になる。
  const candidates = [trimmed, ...(trimmed.match(/https:\/\/[^\s"'`<>]+/g) ?? [])];
  for (const candidate of candidates) {
    const cleaned = candidate
      .replace(/^["'`]+/, "")
      .replace(/[.,;:)\]}>"'`]+$/, "");
    if (isAllowedWebhook(cleaned)) return cleaned;
  }
  return null;
}

function webhookUrl(): string | null {
  return extractWebhook(process.env.SLACK_WEBHOOK_URL);
}

/** Slack が設定されているか（画面の表示に使う）。 */
export function isSlackConfigured(): boolean {
  return webhookUrl() !== null;
}

/**
 * 設定の診断。「設定したのに configured が false」の原因を切り分けるためのもの。
 *
 * ★ URL のパス（＝実質の資格情報）は返さない。ホスト名までにとどめる。
 *   ホスト名は秘密ではなく、取り違えの発見に必要な情報である。
 */
export type WebhookDiagnosis = {
  present: boolean;
  length: number;
  parsable: boolean;
  protocol: string | null;
  host: string | null;
  allowed: boolean;
  /** 何が混ざっているかの手掛かり。値そのものは一切含まない。 */
  looksLike: {
    startsWithHttps: boolean;
    containsHooksSlack: boolean;
    containsQuote: boolean;
    containsWhitespace: boolean;
    containsNewline: boolean;
    /** 取り出せる URL が含まれていたか（含まれていれば救える）。 */
    extractable: boolean;
  };
};

export function diagnoseWebhook(): WebhookDiagnosis {
  const raw = process.env.SLACK_WEBHOOK_URL ?? "";
  const trimmed = raw.trim();
  const empty = {
    startsWithHttps: false,
    containsHooksSlack: false,
    containsQuote: false,
    containsWhitespace: false,
    containsNewline: false,
    extractable: false,
  };

  if (!trimmed) {
    return {
      present: false,
      length: 0,
      parsable: false,
      protocol: null,
      host: null,
      allowed: false,
      looksLike: empty,
    };
  }

  const looksLike = {
    startsWithHttps: trimmed.startsWith("https://"),
    containsHooksSlack: trimmed.includes(ALLOWED_WEBHOOK_HOST),
    containsQuote: /["'`]/.test(trimmed),
    containsWhitespace: /\s/.test(trimmed),
    containsNewline: /[\r\n]/.test(trimmed),
    extractable: extractWebhook(raw) !== null,
  };

  try {
    const parsed = new URL(trimmed);
    return {
      present: true,
      length: trimmed.length,
      parsable: true,
      protocol: parsed.protocol,
      host: parsed.host,
      allowed: isAllowedWebhook(trimmed),
      looksLike,
    };
  } catch {
    return {
      present: true,
      length: trimmed.length,
      parsable: false,
      protocol: null,
      host: null,
      allowed: false,
      looksLike,
    };
  }
}

async function post(
  admin: SupabaseClient,
  kind: "job" | "limit",
  jobId: string | null,
  payload: unknown,
): Promise<void> {
  const url = webhookUrl();
  if (!url) return;

  let ok = false;
  let statusCode: number | null = null;
  let error: string | null = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    statusCode = response.status;
    ok = response.ok;
    if (!ok) error = (await response.text()).slice(0, 300);
  } catch (cause) {
    error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  }

  // 届かなかったことに気づけるように、成否を必ず残す
  await admin
    .from("slack_deliveries")
    .insert({ job_id: jobId, kind, ok, status_code: statusCode, error });
}

const YEN_PER_USD = 150; // config/limits.json の exchangeRate と同じ値

function usd(value: number): string {
  return `$${value.toFixed(4)} (約${Math.round(value * YEN_PER_USD).toLocaleString("ja-JP")}円)`;
}

/**
 * 1 回の生成が終わったときに送る本文を組み立てる。
 *
 * ★ 送信から切り離してある。「何を送っているか」を送信せずに検査できるようにするため
 *   （画像や署名付き URL が混ざっていないことを機械的に確かめられる）。
 */
export function buildJobMessage(settings: SlackSettings, summary: JobSummary): unknown {
  const failed = summary.policyRejected + summary.inputRejected + summary.infraFailed;
  const icon = failed === 0 ? "✅" : summary.succeeded === 0 ? "🚫" : "⚠️";
  const modeJa = summary.mode === "removal" ? "タトゥー・不要物除去" : "通常加工";

  const subject = settings.slack_include_subject
    ? `${summary.storeName ?? "（店舗未入力）"} / ${summary.castName ?? "（キャスト未入力）"}`
    : "（非表示）";

  const providers = (Object.entries(summary.byProvider) as [ProviderName, number][])
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${PROVIDER_LABEL[name]} ${count}枚`)
    .join(" / ");

  const budget = Number(settings.daily_budget_usd);
  const budgetPct = budget > 0 ? Math.round((summary.todayCostUsd / budget) * 100) : 0;

  const fields: string[] = [
    `*利用者*\n${summary.email}`,
    `*対象*\n${subject}`,
    `*内容*\n${modeJa}／${summary.contentJa}`,
    `*結果*\n成功 ${summary.succeeded} ／ 拒否 ${summary.policyRejected} ／ 不備 ${summary.inputRejected} ／ 障害 ${summary.infraFailed}`,
    `*モデル*\n${providers || "—"}${summary.fellBack > 0 ? `\n（うち ${summary.fellBack} 枚はフォールバック）` : ""}`,
    `*所要*\n${(summary.elapsedMs / 1000).toFixed(1)} 秒`,
  ];

  return {
    text: `${icon} 生成 ${summary.succeeded}/${summary.requested}枚 ／ ${usd(summary.actualCostUsd)}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${icon} AI Canvas 体験版｜${summary.succeeded}/${summary.requested} 枚 ／ ${usd(summary.actualCostUsd)}`,
          emoji: true,
        },
      },
      {
        type: "section",
        fields: fields.map((text) => ({ type: "mrkdwn", text })),
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text:
              `本日累計 *${summary.todayImages} 枚 ／ ${usd(summary.todayCostUsd)}*` +
              `（日次予算 $${budget.toFixed(2)} の ${budgetPct}%・上限 ${settings.daily_max_images} 枚）` +
              `　｜　job \`${summary.jobId.slice(0, 8)}\``,
          },
        ],
      },
      ...(summary.policyRejected > 0
        ? [
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text:
                    `:warning: ${summary.policyRejected} 枚が安全性判定で拒否されました。` +
                    `文言を変えた再投入は行いません（禁止事項③）。拒否は課金されません。`,
                },
              ],
            },
          ]
        : []),
    ],
  };
}

/** 1 回の生成が終わったときの通知。 */
export async function notifyJobFinished(
  admin: SupabaseClient,
  settings: SlackSettings,
  summary: JobSummary,
): Promise<void> {
  if (!settings.slack_enabled) return;
  await post(admin, "job", summary.jobId, buildJobMessage(settings, summary));
}

export type LimitHit = {
  email: string;
  reason: string;
  message: string;
  requestedImages: number;
};

/** 上限に当たって生成を断ったときの通知。 */
export async function notifyLimitHit(
  admin: SupabaseClient,
  settings: SlackSettings,
  hit: LimitHit,
): Promise<void> {
  if (!settings.slack_enabled || !settings.slack_on_limit) return;

  // 呼び出し間隔による一時的な待ちは、通知するとうるさいだけなので送らない。
  if (hit.reason === "user_interval" || hit.reason === "global_interval") return;

  const labels: Record<string, string> = {
    disabled: "管理者が生成を停止中",
    user_quota: "利用者の枚数上限",
    daily_images: "本日の枚数上限",
    daily_budget: "本日の予算上限",
    no_profile: "利用登録なし",
    no_limits: "上限設定が見つからない",
  };

  await post(admin, "limit", null, {
    text: `🛑 生成を止めました：${labels[hit.reason] ?? hit.reason}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `:octagonal_sign: *生成を止めました*　${labels[hit.reason] ?? hit.reason}\n` +
            `*利用者* ${hit.email}　*要求* ${hit.requestedImages} 枚\n` +
            `> ${hit.message}`,
        },
      },
    ],
  });
}
