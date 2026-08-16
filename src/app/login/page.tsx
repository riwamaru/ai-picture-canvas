"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * ログイン。招待されたアドレスだけが入れる。
 *
 * ★ shouldCreateUser: false にしてある。
 *   招待されていないアドレスを入力しても、ここでユーザーは作られない。
 *   （DB のトリガでも同じことを止めている。片方が外れても破れないようにするため）
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"link" | "password">("link");
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
              text:
                "ログインリンクを送れませんでした。招待されたアドレスか確認してください。\n" +
                `（${error.message}）`,
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
    <main style={{ maxWidth: 460 }}>
      <h1>AI Canvas 体験版</h1>
      <p className="muted">招待された方のみご利用いただけます。</p>

      <div className="panel">
        {status && <div className={`notice ${status.kind}`}>{status.text}</div>}

        <div className="row" style={{ marginBottom: 14 }}>
          <button
            type="button"
            aria-pressed={mode === "link"}
            className={mode === "link" ? "primary" : ""}
            onClick={() => setMode("link")}
          >
            メールのリンクで入る
          </button>
          <button
            type="button"
            aria-pressed={mode === "password"}
            className={mode === "password" ? "primary" : ""}
            onClick={() => setMode("password")}
          >
            パスワードで入る
          </button>
        </div>

        <form onSubmit={submit}>
          <label style={{ marginBottom: 12 }}>
            <span className="muted">メールアドレス</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </label>

          {mode === "password" && (
            <label style={{ marginBottom: 12 }}>
              <span className="muted">パスワード（管理者から伝えられたもの）</span>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
          )}

          <button className="primary" type="submit" disabled={busy}>
            {busy ? "送信中…" : mode === "link" ? "ログインリンクを送る" : "ログイン"}
          </button>
        </form>
      </div>

      <p className="muted">
        アップロードした写真と生成結果は非公開で保管され、招待された本人だけが閲覧できます。
      </p>
    </main>
  );
}
