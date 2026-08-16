"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * ログイン画面。モック（index.html）の .login-screen をそのまま使う。
 *
 * 変えたのは中身だけ：
 *   - モックは「manager を含めば管理者」という擬似ロール判定だった。
 *     実際のロールは ADMIN_EMAILS（サーバー側）で決まる。
 *   - 招待されたアドレスだけが入れる（shouldCreateUser: false ／ DB のトリガ）。
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"password" | "link">("password");
  const [status, setStatus] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    const supabase = createClient();

    if (mode === "link") {
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          shouldCreateUser: false,
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      setBusy(false);
      setStatus(
        error
          ? {
              kind: "error",
              text: "ログインリンクを送れませんでした。招待されたアドレスかご確認ください。",
            }
          : {
              kind: "info",
              text: "ログイン用のリンクをメールで送りました。メール内のリンクを開いてください。",
            },
      );
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setBusy(false);
    if (error) {
      setStatus({ kind: "error", text: "メールアドレスかパスワードが違います。" });
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <div className="login-screen" id="login-screen">
      <div className="login-card">
        <div className="logo-area">
          <div className="logo-icon">
            <i className="fa-solid fa-wand-sparkles" />
          </div>
          <div className="logo-text">AI Canvas</div>
        </div>
        <div className="logo-badge-ver">v2.0 確定版</div>
        <div className="logo-subtitle">
          自社専用クローズド AI 画像加工システム（画像編集・inpainting）
        </div>

        {status && (
          <div
            className="role-hint"
            style={{
              textAlign: "left",
              marginBottom: 20,
              padding: "10px 14px",
              borderRadius: "var(--radius-sm)",
              background: status.kind === "error" ? "#fff5f5" : "rgba(14,165,233,0.06)",
              border: `1px solid ${status.kind === "error" ? "rgba(244,63,94,0.3)" : "rgba(14,165,233,0.2)"}`,
              color: status.kind === "error" ? "#e11d48" : "var(--text-link)",
              fontWeight: 600,
            }}
          >
            {status.text}
          </div>
        )}

        <form onSubmit={submit}>
          <div className="form-group">
            <label>
              <i className="fa-solid fa-user-tag" /> 店舗スタッフID（メールアドレス）
            </label>
            <input
              type="email"
              id="email-input"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="招待されたメールアドレス"
            />
            <div className="role-hint">
              <i className="fa-solid fa-circle-info" /> 招待された方のみご利用いただけます。ロール（管理者
              / 店舗スタッフ）はサーバー側の設定で決まります
            </div>
          </div>

          {mode === "password" && (
            <div className="form-group">
              <label>
                <i className="fa-solid fa-lock" /> パスワード
              </label>
              <input
                type="password"
                id="password-input"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="管理者から伝えられたパスワード"
              />
              <div className="role-hint">
                <span
                  className="logout-text"
                  style={{ marginLeft: 0 }}
                  onClick={() => setMode("link")}
                >
                  <i className="fa-solid fa-envelope" /> パスワードが分からない場合はメールでログインリンクを受け取る
                </span>
              </div>
            </div>
          )}

          {mode === "link" && (
            <div className="form-group">
              <div className="role-hint">
                <span
                  className="logout-text"
                  style={{ marginLeft: 0 }}
                  onClick={() => setMode("password")}
                >
                  <i className="fa-solid fa-lock" /> パスワードでログインする
                </span>
              </div>
            </div>
          )}

          <button className="sb-btn" type="submit" disabled={busy}>
            {busy
              ? "送信中..."
              : mode === "password"
                ? "システムにセキュアログイン"
                : "ログインリンクをメールで送る"}
          </button>
        </form>

        <div className="security-notice">
          <i className="fa-solid fa-shield-halved" /> RLS 有効・全 API 呼び出しはサーバーサイドで実行
        </div>
      </div>
    </div>
  );
}
