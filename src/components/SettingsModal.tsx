"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 管理者向けシステム設定。確定 UI（index.html）のモーダルをそのまま移植した。
 *
 * モックとの違いは 2 点：
 *
 *  ① 「生成回数の可視化・レート監視」は、モックでは表示だけで
 *     「強制停止（ハードリミット）は当面実装しません」と書かれていた。
 *     この体験環境は任意の人が実費のかかるボタンを押せるため、
 *     ここの値は **実際に効く上限** として扱う。
 *
 *  ② 招待の節を足した（モックには無い）。体験環境は招待制で運用するため。
 */

type Limits = {
  enabled: boolean;
  daily_budget_usd: string | number;
  daily_max_images: number;
  global_min_interval_ms: number;
  user_min_interval_ms: number;
  default_user_max_images: number;
  images_per_job: number;
  variant_strategy: "identical" | "micro_delta";
  fallback_enabled: boolean;
  primary_provider: "openai" | "google";
  fallback_provider: "openai" | "google";
  fallback_on_policy: boolean;
};

type UserRow = {
  email: string;
  max_images: number;
  used_images: number;
  last_call_at: string | null;
};

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [limits, setLimits] = useState<Limits | null>(null);
  const [today, setToday] = useState<{ day: string; images: number; cost_usd: string } | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteMax, setInviteMax] = useState(24);
  const [inviteWithPassword, setInviteWithPassword] = useState(true);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteResult, setInviteResult] = useState<{
    ok: boolean;
    message: string;
    password?: string | null;
  } | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const response = await fetch("/api/admin/limits", { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (response.ok && data?.ok) {
      setLoadError(null);
      setLimits(data.limits as Limits);
      setToday(data.today ?? null);
      setUsers((data.users ?? []) as UserRow[]);
      return;
    }
    // 読めなかったときに 0 を並べると「上限が 0 に設定されている」と読めてしまう。
    setLoadError(
      data?.message ??
        "上限設定を読み込めませんでした（サーバー側の設定が未完了の可能性があります）。",
    );
    setLimits(null);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function patch(update: Partial<Limits>) {
    setSaving(true);
    setSaved(false);
    setLimits((current) => (current ? { ...current, ...update } : current));
    const response = await fetch("/api/admin/limits", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    });
    setSaving(false);
    if (response.ok) {
      setSaved(true);
      void reload();
    }
  }

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    setInviteBusy(true);
    setInviteResult(null);
    const response = await fetch("/api/admin/invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: inviteEmail,
        maxImages: inviteMax,
        withPassword: inviteWithPassword,
      }),
    });
    const data = await response.json().catch(() => null);
    setInviteBusy(false);
    setInviteResult(data);
    if (data?.ok) {
      setInviteEmail("");
      void reload();
    }
  }

  return (
    <div className="modal-overlay" style={{ display: "flex" }}>
      <div className="modal-card">
        <div className="modal-header">
          <h3>
            <i className="fa-solid fa-screwdriver-wrench" style={{ color: "var(--primary)" }} /> AI
            Canvas 管理者システム設定
          </h3>
          <button className="modal-close-btn" onClick={onClose}>
            <i className="fa-solid fa-xmark" />
          </button>
        </div>

        <div className="settings-tab-content">
          {loadError && (
            <div className="invite-result error" style={{ marginBottom: 14 }}>
              {loadError}
            </div>
          )}

          {/* ── 緊急停止 ── */}
          <div className="settings-section-title">
            生成の停止スイッチ <span className="sec-badge">体験環境</span>
          </div>
          <div className="toggle-inline">
            <span>
              <i
                className="fa-solid fa-power-off"
                style={{ color: limits?.enabled ? "#10b981" : "#ef4444" }}
              />{" "}
              生成を受け付ける（オフにすると全利用者の生成が即座に止まります）
            </span>
            <label className="switch">
              <input
                type="checkbox"
                checked={limits?.enabled ?? false}
                onChange={(e) => void patch({ enabled: e.target.checked })}
              />
              <span className="slider" />
            </label>
          </div>
          <div className="setting-note">
            <i className="fa-solid fa-circle-info" /> 本日の使用量：
            {today ? `${today.images} 枚 / $${Number(today.cost_usd).toFixed(2)}` : "なし"}（日付は
            Asia/Tokyo で切り替わります）
            {saving && "　保存中…"}
            {saved && !saving && "　保存しました"}
          </div>

          {/* ── 上限 ── */}
          <div className="settings-section-title">
            生成回数・コストの上限 <span className="sec-badge">F-10</span>
          </div>
          {limits && (
          <div className="settings-grid-row">
            <div className="setting-field">
              <label>1 日の予算上限（USD）</label>
              <input
                type="number"
                step="0.5"
                value={Number(limits?.daily_budget_usd ?? 0)}
                onChange={(e) => void patch({ daily_budget_usd: Number(e.target.value) })}
              />
            </div>
            <div className="setting-field">
              <label>1 日の枚数上限</label>
              <input
                type="number"
                value={limits?.daily_max_images ?? 0}
                onChange={(e) => void patch({ daily_max_images: Number(e.target.value) })}
              />
            </div>
            <div className="setting-field">
              <label>全体の呼び出し間隔（ミリ秒）</label>
              <input
                type="number"
                step="1000"
                value={limits?.global_min_interval_ms ?? 0}
                onChange={(e) => void patch({ global_min_interval_ms: Number(e.target.value) })}
              />
            </div>
            <div className="setting-field">
              <label>1 人あたりの呼び出し間隔（ミリ秒）</label>
              <input
                type="number"
                step="1000"
                value={limits?.user_min_interval_ms ?? 0}
                onChange={(e) => void patch({ user_min_interval_ms: Number(e.target.value) })}
              />
            </div>
            <div className="setting-field">
              <label>招待時の既定の枚数上限</label>
              <input
                type="number"
                value={limits?.default_user_max_images ?? 0}
                onChange={(e) => void patch({ default_user_max_images: Number(e.target.value) })}
              />
            </div>
            <div className="setting-field">
              <label>1 回の生成で作る枚数（最大 6）</label>
              <input
                type="number"
                min={1}
                max={6}
                value={limits?.images_per_job ?? 6}
                onChange={(e) => void patch({ images_per_job: Number(e.target.value) })}
              />
            </div>
          </div>
          )}
          <div className="setting-note">
            <i className="fa-solid fa-triangle-exclamation" /> 1 枚あたり OpenAI 約 $0.083
            （1024×1536・quality medium）／ Google 約 $0.136。6 枚 ＝ 1 回あたり約 $0.50〜$0.82
            です。予約は高いほうで押さえ、実額は生成後に差し替えます。ここの値は表示だけでなく実際に効きます
            （上限に達すると生成を受け付けません）。
          </div>

          {/* ── プロバイダとフォールバック ── */}
          <div className="settings-section-title">
            画像生成プロバイダとフォールバック <span className="sec-badge">F-16</span>
          </div>
          {limits && (
            <>
              <div className="settings-grid-row">
                <div className="setting-field">
                  <label>先に試すプロバイダ</label>
                  <select
                    value={limits.primary_provider}
                    onChange={(e) =>
                      void patch({ primary_provider: e.target.value as Limits["primary_provider"] })
                    }
                  >
                    <option value="openai">OpenAI gpt-image-2</option>
                    <option value="google">Google gemini-3-pro-image</option>
                  </select>
                </div>
                <div className="setting-field">
                  <label>失敗したときに回す先</label>
                  <select
                    value={limits.fallback_provider}
                    onChange={(e) =>
                      void patch({
                        fallback_provider: e.target.value as Limits["fallback_provider"],
                      })
                    }
                  >
                    <option value="google">Google gemini-3-pro-image</option>
                    <option value="openai">OpenAI gpt-image-2</option>
                  </select>
                </div>
              </div>

              <div className="toggle-inline">
                <span>
                  <i className="fa-solid fa-shuffle" style={{ color: "var(--primary)" }} />{" "}
                  フォールバックを有効にする
                </span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={limits.fallback_enabled}
                    onChange={(e) => void patch({ fallback_enabled: e.target.checked })}
                  />
                  <span className="slider" />
                </label>
              </div>

              <div className="toggle-inline">
                <span>
                  <i className="fa-solid fa-triangle-exclamation" style={{ color: "#d97706" }} />{" "}
                  ポリシー拒否でもフォールバックする
                </span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={limits.fallback_on_policy}
                    onChange={(e) => void patch({ fallback_on_policy: e.target.checked })}
                  />
                  <span className="slider" />
                </label>
              </div>
            </>
          )}
          <div className="setting-note">
            <i className="fa-solid fa-circle-info" /> PoC の実測（2026-08-16 日報）では
            <strong> OpenAI は 30 件すべてポリシー拒否</strong>され、Google は 35 件成功しています。
            確定 UI は「障害系のみフォールバック・ポリシー起因は再投入しない」と書いていますが、
            その規則ではフォールバックが一度も発動しないため、委託者判断でポリシー拒否も対象にしています。
            禁止事項③が禁じるのは「文言を変えた再投入」であり、同一プロンプトを別ベンダーへ送ることは
            これに当たりません。<strong>拒否は課金されない</strong>ため、追加費用も発生しません。
            なお<strong>タトゥー除去はマスク入力が必要なため OpenAI 専用</strong>で、
            フォールバック先がありません（Google はマスク画像を受け付けない）。
          </div>

          {/* ── 同一条件 2 枚の作り分け ── */}
          <div className="settings-section-title">
            同一条件 2 枚の作り分け <span className="sec-badge">4.2.4 / T-03</span>
          </div>
          <div className="settings-grid-row">
            <div className="setting-field">
              <label>方式</label>
              <select
                value={limits?.variant_strategy ?? "micro_delta"}
                onChange={(e) =>
                  void patch({ variant_strategy: e.target.value as Limits["variant_strategy"] })
                }
              >
                <option value="micro_delta">案 2：表情・向き・照明に軽微な差分を付ける</option>
                <option value="identical">案 1：同一プロンプトを 2 回実行する</option>
              </select>
            </div>
          </div>
          <div className="setting-note">
            <i className="fa-solid fa-circle-info" /> 機能仕様書 4.2.4
            はどちらを採用するか未確定（区分 A-2）で、PoC の T-03
            で決めることになっています。ここを切り替えると、その比較をこの画面で行えます。seed
            指定は OpenAI・Google のいずれも非対応のため、案 1 の差分はモデル固有のゆらぎのみに依存します。
          </div>

          {/* ── 招待 ── */}
          <div className="settings-section-title">
            利用者の招待 <span className="sec-badge">体験環境</span>
          </div>
          <form onSubmit={invite}>
            <div className="invite-row">
              <div className="setting-field">
                <label>招待するメールアドレス</label>
                <input
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="tester@example.com"
                />
              </div>
              <div className="setting-field">
                <label>枚数上限</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={inviteMax}
                  onChange={(e) => setInviteMax(Number(e.target.value))}
                />
              </div>
              <button className="crb-btn primary" type="submit" disabled={inviteBusy}>
                {inviteBusy ? "招待中…" : "招待する"}
              </button>
            </div>
            <div className="toggle-inline" style={{ marginTop: 10 }}>
              <span>
                <i className="fa-solid fa-key" style={{ color: "var(--primary)" }} />{" "}
                パスワードを発行する（メール送信の回数制限を避けられます）
              </span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={inviteWithPassword}
                  onChange={(e) => setInviteWithPassword(e.target.checked)}
                />
                <span className="slider" />
              </label>
            </div>
          </form>

          {inviteResult && (
            <div className={`invite-result${inviteResult.ok ? "" : " error"}`}>
              {inviteResult.message}
              {inviteResult.password && (
                <div style={{ marginTop: 6 }}>
                  パスワード: <code>{inviteResult.password}</code>
                  <br />
                  <span style={{ color: "var(--text-muted)" }}>
                    この画面を閉じると二度と表示されません。
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="setting-note">
            <i className="fa-solid fa-circle-info" /> Supabase
            の組み込みメール送信には厳しい回数制限があります（独自 SMTP
            を設定するまでは、パスワードを発行して直接伝えるほうが確実です）。
          </div>

          {/* ── 利用者一覧 ── */}
          <div className="settings-section-title">
            利用者と消費枚数 <span className="sec-badge">F-07</span>
          </div>
          <table className="log-table">
            <thead>
              <tr>
                <th>メールアドレス</th>
                <th>消費 / 上限</th>
                <th>最終利用</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr>
                  <td colSpan={3}>まだ利用者がいません</td>
                </tr>
              )}
              {users.map((user) => (
                <tr key={user.email}>
                  <td>{user.email}</td>
                  <td>
                    {user.used_images} / {user.max_images} 枚
                  </td>
                  <td>
                    {user.last_call_at
                      ? new Date(user.last_call_at).toLocaleString("ja-JP")
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* ── セキュリティ ── */}
          <div className="settings-section-title">
            セキュリティ・データ保護ポリシー <span className="sec-badge">4.5</span>
          </div>
          <div className="policy-list">
            <div className="policy-item">
              <i className="fa-solid fa-user-shield ok" /> 全テーブルで RLS
              有効化（自分の行のみ読み取り可・anon 拒否）<span className="pi-tag">有効</span>
            </div>
            <div className="policy-item">
              <i className="fa-solid fa-key ok" /> 生成 API
              の呼び出しはすべてサーバーサイド実行（API キー非露出）
              <span className="pi-tag">有効</span>
            </div>
            <div className="policy-item">
              <i className="fa-solid fa-link ok" /> Supabase Storage
              非公開バケット＋有効期限付き署名付き URL<span className="pi-tag">有効</span>
            </div>
            <div className="policy-item">
              <i className="fa-solid fa-user-check ok" />{" "}
              アップロード時に本人同意のチェックを必須化し、記録に残す
              <span className="pi-tag">有効</span>
            </div>
            <div className="policy-item">
              <i className="fa-solid fa-ban" style={{ color: "#94a3b8" }} /> 事前モデレーションスキャン
              <span className="pi-tag">未実装</span>
            </div>
            <div className="policy-item">
              <i className="fa-solid fa-ban" style={{ color: "#94a3b8" }} /> Google Drive
              共有ドライブ保存<span className="pi-tag">未実装</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
