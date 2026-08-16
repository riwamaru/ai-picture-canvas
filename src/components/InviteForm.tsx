"use client";

import { useState } from "react";

export function InviteForm() {
  const [email, setEmail] = useState("");
  const [maxImages, setMaxImages] = useState(10);
  const [withPassword, setWithPassword] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    message: string;
    password?: string | null;
  } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setResult(null);
    const response = await fetch("/api/admin/invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, maxImages, withPassword }),
    });
    const data = (await response.json()) as {
      ok: boolean;
      message: string;
      password?: string | null;
    };
    setResult(data);
    setBusy(false);
    if (data.ok) setEmail("");
  }

  return (
    <main style={{ maxWidth: 560 }}>
      <h1>招待する</h1>
      <p className="muted">
        <a href="/">← 体験画面へ戻る</a>
      </p>

      <div className="panel">
        {result && (
          <div className={`notice ${result.ok ? "info" : "error"}`}>
            {result.message}
            {result.password && (
              <p style={{ marginBottom: 0 }}>
                パスワード: <code style={{ fontSize: 16 }}>{result.password}</code>
              </p>
            )}
          </div>
        )}

        <form onSubmit={submit}>
          <label style={{ marginBottom: 12 }}>
            <span className="muted">招待するメールアドレス</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>

          <label style={{ marginBottom: 12 }}>
            <span className="muted">この人が生成できる上限枚数</span>
            <input
              type="number"
              min={1}
              max={100}
              value={maxImages}
              onChange={(e) => setMaxImages(Number(e.target.value))}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--panel)",
                color: "var(--text)",
                fontSize: 15,
              }}
            />
          </label>

          <label className="row" style={{ marginBottom: 16, alignItems: "flex-start" }}>
            <input
              type="checkbox"
              checked={withPassword}
              onChange={(e) => setWithPassword(e.target.checked)}
              style={{ marginTop: 6 }}
            />
            <span style={{ flex: 1 }}>
              パスワードを発行する
              <br />
              <span className="muted">
                Supabase の組み込みメール送信には厳しい回数制限があります。独自 SMTP
                を設定するまでは、パスワードを発行して直接伝えるほうが確実です。
              </span>
            </span>
          </label>

          <button className="primary" type="submit" disabled={busy}>
            {busy ? "招待中…" : "招待する"}
          </button>
        </form>
      </div>
    </main>
  );
}
