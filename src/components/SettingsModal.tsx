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
  edit_min_interval_ms: number;
  default_user_max_images: number;
  images_per_job: number;
  variant_strategy: "identical" | "micro_delta";
  fallback_enabled: boolean;
  primary_provider: "openai" | "google";
  fallback_provider: "openai" | "google";
  fallback_on_policy: boolean;
  removal_fallback_enabled: boolean;
  slack_enabled: boolean;
  slack_on_limit: boolean;
  slack_include_subject: boolean;
  drive_enabled: boolean;
  final_resolution: "1k" | "2k";
};

type DriveState = {
  diagnosis: {
    configured: boolean;
    reason: string;
    serviceAccount: string | null;
    rootFolderId: string | null;
    oidcPresent: boolean;
  };
  syncedCount: number;
  pending: {
    job_id: string;
    source_slot: number;
    drive_attempts: number;
    drive_error: string | null;
    drive_last_attempt_at: string | null;
  }[];
  folders: {
    store_name: string;
    folder_name: string;
    folder_id: string | null;
    recreate_count: number;
    recreated_at: string | null;
  }[];
  orphans: {
    id: string;
    folder_name: string;
    created_folder_id: string | null;
    created_at: string;
  }[];
};

type SlackState = {
  configured: boolean;
  deliveries: {
    kind: string;
    ok: boolean;
    status_code: number | null;
    error: string | null;
    created_at: string;
  }[];
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
  const [slack, setSlack] = useState<SlackState | null>(null);
  const [slackTest, setSlackTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [slackBusy, setSlackBusy] = useState(false);
  const [drive, setDrive] = useState<DriveState | null>(null);
  const [driveBusy, setDriveBusy] = useState(false);
  const [driveResult, setDriveResult] = useState<{ ok: boolean; message: string } | null>(null);

  const reload = useCallback(async () => {
    const response = await fetch("/api/admin/limits", { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (response.ok && data?.ok) {
      setLoadError(null);
      setLimits(data.limits as Limits);
      setToday(data.today ?? null);
      setUsers((data.users ?? []) as UserRow[]);
      setSlack((data.slack ?? null) as SlackState | null);

      // Drive の状態は別のルート（孤児フォルダの点検などで重いため）
      const driveResponse = await fetch("/api/admin/drive", { cache: "no-store" });
      const driveData = await driveResponse.json().catch(() => null);
      setDrive(driveResponse.ok && driveData?.ok ? (driveData as DriveState) : null);
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
              <label>1 人あたりの呼び出し間隔（ミリ秒・6 枚生成と確定）</label>
              <input
                type="number"
                step="1000"
                value={limits?.user_min_interval_ms ?? 0}
                onChange={(e) => void patch({ user_min_interval_ms: Number(e.target.value) })}
              />
            </div>
            <div className="setting-field">
              <label>個別修正の呼び出し間隔（ミリ秒・逐次編集だけ）</label>
              <input
                type="number"
                step="1000"
                value={limits?.edit_min_interval_ms ?? 0}
                onChange={(e) => void patch({ edit_min_interval_ms: Number(e.target.value) })}
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

              <div className="toggle-inline">
                <span>
                  <i className="fa-solid fa-eraser" style={{ color: "var(--type-c)" }} />{" "}
                  除去も Gemini へ回す（範囲を目印と文章で伝える方式）
                </span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={limits.removal_fallback_enabled}
                    onChange={(e) => void patch({ removal_fallback_enabled: e.target.checked })}
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
            <br />
            <strong>除去（マスク編集）は方式が 2 つある。</strong> OpenAI はマスク画像そのものを
            API へ渡すので「マスク外は変更しない」ことが仕組みで担保される。Gemini
            はマスク画像を受け取れないため（対応していた imagen-3.0-capability-001 は 2026-06-30
            に停止済み。2026-08-28 時点のモデル一覧にも inpaint 対応は無い）、
            <strong>範囲の輪郭を描き込んだ画像と位置の説明で伝える</strong>方式になる。
            こちらは<strong>マスク外の不変が保証されない</strong>ので、結果には
            「マスク指定」「範囲を説明」のどちらかが表示される。
            T-02 の判定基準（マスク外に変化なしが 8 割以上）は前者にしか適用できないため、
            測定目的なら上のスイッチを切って OpenAI 単独の結果だけを見ることもできる。
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

          {/* ── Slack 通知 ── */}
          <div className="settings-section-title">
            Slack への生成ログ通知 <span className="sec-badge">F-10</span>
          </div>

          {slack && !slack.configured && (
            <div className="invite-result error">
              <strong>SLACK_WEBHOOK_URL が未設定です。</strong>
              <br />
              Slack で Incoming Webhook を作成し、その URL（<code>
                https://hooks.slack.com/services/…
              </code>）を環境変数 <code>SLACK_WEBHOOK_URL</code> に設定してください。
              設定するまで通知は送られません（生成そのものは動きます）。
            </div>
          )}

          {limits && (
            <>
              <div className="toggle-inline">
                <span>
                  <i className="fa-brands fa-slack" style={{ color: "var(--primary)" }} />{" "}
                  1 回の生成が終わるたびに送る（枚数・料金・成否・モデル）
                </span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={limits.slack_enabled}
                    onChange={(e) => void patch({ slack_enabled: e.target.checked })}
                  />
                  <span className="slider" />
                </label>
              </div>

              <div className="toggle-inline">
                <span>
                  <i className="fa-solid fa-octagon-xmark" style={{ color: "#d97706" }} />{" "}
                  上限に当たって生成を断ったときにも送る
                </span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={limits.slack_on_limit}
                    onChange={(e) => void patch({ slack_on_limit: e.target.checked })}
                  />
                  <span className="slider" />
                </label>
              </div>

              <div className="toggle-inline">
                <span>
                  <i className="fa-solid fa-user-tag" style={{ color: "var(--text-muted)" }} />{" "}
                  店舗名・キャスト名を本文に含める
                </span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={limits.slack_include_subject}
                    onChange={(e) => void patch({ slack_include_subject: e.target.checked })}
                  />
                  <span className="slider" />
                </label>
              </div>
            </>
          )}

          <div className="setting-note">
            <i className="fa-solid fa-shield-halved" />{" "}
            <strong>Slack へは画像も署名付き URL も送りません。</strong>
            送るとチャンネルにいる全員が顔写真を開けてしまい、招待制で守っている前提が崩れます。
            送るのは利用者・枚数・成否・モデル・料金・所要時間・当日累計のテキストだけです。
            キャスト名は人物を指すラベルになりうるため、上のスイッチで落とせます。
          </div>

          <div className="row" style={{ gap: 10, marginTop: 10 }}>
            <button
              type="button"
              className="crb-btn primary"
              disabled={slackBusy || !slack?.configured}
              onClick={async () => {
                setSlackBusy(true);
                setSlackTest(null);
                const response = await fetch("/api/admin/slack-test", { method: "POST" });
                const data = await response.json().catch(() => null);
                setSlackBusy(false);
                setSlackTest(data ?? { ok: false, message: "応答を読めませんでした。" });
                void reload();
              }}
            >
              {slackBusy ? "送信中…" : "テスト送信する（費用は発生しません）"}
            </button>
          </div>

          {slackTest && (
            <div className={`invite-result${slackTest.ok ? "" : " error"}`}>
              {slackTest.message}
            </div>
          )}

          {slack && slack.deliveries.length > 0 && (
            <table className="log-table" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>日時</th>
                  <th>種別</th>
                  <th>結果</th>
                </tr>
              </thead>
              <tbody>
                {slack.deliveries.map((d, i) => (
                  <tr key={i}>
                    <td>{new Date(d.created_at).toLocaleString("ja-JP")}</td>
                    <td>{d.kind === "job" ? "生成ログ" : "上限"}</td>
                    <td>
                      {d.ok ? (
                        <span style={{ color: "#10b981", fontWeight: 600 }}>送信成功</span>
                      ) : (
                        <span style={{ color: "#ef4444", fontWeight: 600 }}>
                          失敗 {d.status_code ?? ""} {String(d.error ?? "").slice(0, 60)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* ── 確定処理（高解像度の再生成 → Drive 保存） ── */}
          <div className="settings-section-title">
            確定処理と Google Drive 保存 <span className="sec-badge">STEP 5 / F-06</span>
          </div>

          {limits && (
            <div className="setting-field" style={{ marginBottom: 12 }}>
              <label>確定画像の解像度</label>
              <select
                value={limits.final_resolution}
                onChange={(e) =>
                  void patch({ final_resolution: e.target.value as "1k" | "2k" })
                }
              >
                <option value="2k">2K（仕様書どおり・1 枚あたり約 $0.85）</option>
                <option value="1k">1K（ドラフトと同じ解像度・1 枚あたり約 $0.05）</option>
              </select>
            </div>
          )}

          <div className="setting-note">
            仕様書 STEP 5 は「選択された 1 枚のみを高解像度で再生成し確定画像とする」としています。
            <strong>引き伸ばしではなく作り直し</strong>なので、選んだ候補と完全に同じ絵にはなりません。
            <br />
            <strong>2K は 1 枚あたり約 $0.85 です。</strong>
            日次予算の既定 $10 では、確定 11 回で 1 日ぶんを使い切ります。
            測定目的で回すときは 1K へ落とせます（何で作ったかは記録に必ず残ります）。
          </div>

          {drive && !drive.diagnosis.configured && (
            <div className="invite-result error" style={{ marginTop: 10 }}>
              <strong>Google Drive の設定が未完了です。</strong>
              <br />
              {drive.diagnosis.reason}
              <br />
              <br />
              この連携は<strong>秘密鍵を使いません</strong>。Google Cloud で Workload Identity
              プールとプロバイダを作り、その対象者を <code>GOOGLE_DRIVE_WIF_AUDIENCE</code>、
              なりすます相手を <code>GOOGLE_DRIVE_SERVICE_ACCOUNT</code>、保存先フォルダの ID を{" "}
              <code>GOOGLE_DRIVE_ROOT_FOLDER_ID</code> へ設定してください。
            </div>
          )}

          {drive?.diagnosis.serviceAccount && (
            <div className="setting-note" style={{ marginTop: 10 }}>
              このアドレスを<strong>共有ドライブのメンバー（コンテンツ管理者以上）</strong>
              に追加してください。追加しないと権限エラーで保存できません。
              <br />
              <code>{drive.diagnosis.serviceAccount}</code>
              <br />
              Vercel の OIDC トークン：
              {drive.diagnosis.oidcPresent ? (
                <strong style={{ color: "#10b981" }}>受信できています</strong>
              ) : (
                <strong style={{ color: "#ef4444" }}>来ていません</strong>
              )}
            </div>
          )}

          {limits && (
            <div className="toggle-inline">
              <span>
                <i className="fa-brands fa-google-drive" style={{ color: "var(--primary)" }} />{" "}
                確定画像を共有ドライブへ保存する
              </span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={limits.drive_enabled}
                  onChange={(e) => void patch({ drive_enabled: e.target.checked })}
                />
                <span className="slider" />
              </label>
            </div>
          )}

          <div className="setting-note">
            保存先は「<strong>店舗名 ／ キャスト名_入店年月</strong>」（仕様書 4.7.1）。
            フォルダ名ではなくフォルダ ID で解決するので、キャストを改名しても過去画像との紐付けは切れません。
            <br />
            <strong>共有ドライブ以外へは保存できません。</strong>
            サービスアカウントは自身のストレージ容量を持たないためです（仕様書 4.1.2）。
            <br />
            Drive へ入るのは<strong>確定画像だけ</strong>です。ドラフト 6 枚は Supabase 側に留まります。
          </div>

          <div className="row" style={{ gap: 10, marginTop: 10 }}>
            <button
              type="button"
              className="crb-btn primary"
              disabled={driveBusy || !drive?.diagnosis.configured}
              onClick={async () => {
                setDriveBusy(true);
                setDriveResult(null);
                const response = await fetch("/api/admin/drive", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ action: "test" }),
                });
                const data = await response.json().catch(() => null);
                setDriveBusy(false);
                setDriveResult(data ?? { ok: false, message: "応答を読めませんでした。" });
              }}
            >
              {driveBusy ? "確認中…" : "接続を確認する（保存はしません）"}
            </button>

            <button
              type="button"
              className="crb-btn ghost"
              disabled={driveBusy || !drive || drive.pending.length === 0}
              onClick={async () => {
                setDriveBusy(true);
                setDriveResult(null);
                const response = await fetch("/api/admin/drive", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ action: "resync" }),
                });
                const data = await response.json().catch(() => null);
                setDriveBusy(false);
                setDriveResult(data ?? { ok: false, message: "応答を読めませんでした。" });
                await reload();
              }}
            >
              未同期を今すぐ再送する
            </button>
          </div>

          {driveResult && (
            <div className={`invite-result${driveResult.ok ? "" : " error"}`}>
              {driveResult.message}
            </div>
          )}

          {drive && (
            <div className="setting-note" style={{ marginTop: 10 }}>
              保存済み <strong>{drive.syncedCount}</strong> 枚 ／ 未同期{" "}
              <strong>{drive.pending.length}</strong> 枚 ／ 台帳のフォルダ{" "}
              <strong>{drive.folders.length}</strong> 件
            </div>
          )}

          {drive && drive.pending.length > 0 && (
            <table className="log-table" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>最終試行</th>
                  <th>候補</th>
                  <th>試行</th>
                  <th>理由</th>
                </tr>
              </thead>
              <tbody>
                {drive.pending.map((row) => (
                  <tr key={row.job_id}>
                    <td>
                      {row.drive_last_attempt_at
                        ? new Date(row.drive_last_attempt_at).toLocaleString("ja-JP")
                        : "—"}
                    </td>
                    <td>候補{row.source_slot + 1}</td>
                    <td>{row.drive_attempts} 回</td>
                    <td>{String(row.drive_error ?? "").slice(0, 80)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* 仕様書 4.7.2：Drive には作られたが台帳へ書けなかったフォルダを一覧する */}
          {drive && drive.orphans.length > 0 && (
            <>
              <div className="invite-result error" style={{ marginTop: 12 }}>
                <strong>台帳に登録できなかったフォルダが {drive.orphans.length} 件あります。</strong>
                <br />
                Drive 上には作られていますが、システムはこれを保存先として使いません。
                中身を確認のうえ、Drive で手動で片付けてください。
              </div>
              <table className="log-table" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>作成日時</th>
                    <th>フォルダ名</th>
                    <th>フォルダ ID</th>
                  </tr>
                </thead>
                <tbody>
                  {drive.orphans.map((row) => (
                    <tr key={row.id}>
                      <td>{new Date(row.created_at).toLocaleString("ja-JP")}</td>
                      <td>{row.folder_name}</td>
                      <td>
                        <code>{row.created_folder_id}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

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
