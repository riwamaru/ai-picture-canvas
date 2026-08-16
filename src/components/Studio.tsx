"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { MaskCanvas, type MaskCanvasHandle } from "./MaskCanvas";
import type { Catalog, CategoryId, MakeupStrength } from "@/lib/catalog";

type JobRow = {
  id: string;
  status: "running" | "succeeded" | "failed";
  createdAt: string;
  categoryIds: string[];
  makeupStrength: string;
  latencyMs: number | null;
  costUsd: number | null;
  errorKind: string | null;
  errorMessage: string | null;
  sourceUrl: string | null;
  resultUrl: string | null;
};

type Profile = { email: string; max_images: number; used_images: number };

export function Studio({
  catalog,
  email,
  isAdmin,
}: {
  catalog: Catalog;
  email: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const maskRef = useRef<MaskCanvasHandle>(null);

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [makeupStrength, setMakeupStrength] = useState<MakeupStrength>("medium");
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ sourceUrl: string; resultUrl: string } | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [history, setHistory] = useState<JobRow[]>([]);

  const needsMask = picked["tattoo_removal"] !== undefined;

  const reload = useCallback(async () => {
    const response = await fetch("/api/jobs", { cache: "no-store" });
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      message?: string;
      profile?: Profile | null;
      jobs?: JobRow[];
    } | null;

    if (!response.ok || !data?.ok) {
      // 黙って空の履歴を出すと、設定漏れに気づけないまま使われてしまう。
      setError(data?.message ?? "残り枚数と履歴を読み込めませんでした。");
      return;
    }
    setProfile(data.profile ?? null);
    setHistory(data.jobs ?? []);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    setResult(null);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function toggleCategory(id: CategoryId, firstTemplateId: string) {
    setPicked((current) => {
      const next = { ...current };
      if (next[id] !== undefined) delete next[id];
      else next[id] = firstTemplateId;
      return next;
    });
  }

  async function generate() {
    if (!file) return setError("写真を選んでください。");
    if (!rights) {
      return setError("「本人の同意を得た写真である」にチェックしてください。");
    }

    setBusy(true);
    setError(null);
    setResult(null);

    const form = new FormData();
    form.set("source", file);
    form.set("rightsConfirmed", String(rights));
    form.set(
      "selection",
      JSON.stringify({
        makeupStrength,
        selections: Object.entries(picked).map(([categoryId, templateId]) => ({
          categoryId,
          templateId,
        })),
      }),
    );

    if (needsMask) {
      const blob = await maskRef.current?.toBlob();
      if (!blob) {
        setBusy(false);
        return setError("消したい範囲をブラシで塗ってください。");
      }
      form.set("mask", new File([blob], "mask.png", { type: "image/png" }));
    }

    try {
      const response = await fetch("/api/generate", { method: "POST", body: form });
      const data = (await response.json()) as {
        ok: boolean;
        message?: string;
        sourceUrl?: string;
        resultUrl?: string;
      };

      if (!data.ok || !data.resultUrl || !data.sourceUrl) {
        setError(data.message ?? "生成に失敗しました。");
      } else {
        setResult({ sourceUrl: data.sourceUrl, resultUrl: data.resultUrl });
      }
    } catch {
      setError(
        "通信が途切れました。生成は完了している場合があります。下の「これまでの結果」を確認してください。",
      );
    } finally {
      setBusy(false);
      void reload();
    }
  }

  async function signOut() {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const remaining = profile ? profile.max_images - profile.used_images : null;

  return (
    <main>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h1>AI Canvas 体験版</h1>
          <p className="muted" style={{ margin: 0 }}>
            {email}
            {remaining !== null && ` ／ 残り ${remaining} 枚（上限 ${profile!.max_images} 枚）`}
            {isAdmin && " ／ 管理者"}
          </p>
        </div>
        <div className="row">
          {isAdmin && (
            <a href="/admin" className="muted">
              招待する
            </a>
          )}
          <button type="button" onClick={signOut}>
            ログアウト
          </button>
        </div>
      </div>

      <div className="notice info">
        本人の同意を得た写真だけをアップロードしてください。アップロードした写真と生成結果は非公開で保管され、
        あなたと管理者以外は閲覧できません。生成は 1 回押すごとに 1 枚です（再試行は行いません）。
      </div>

      {error && <div className="notice error">{error}</div>}

      <div className="grid2">
        <section className="panel">
          <h2>1. 写真を選ぶ</h2>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />

          {previewUrl && needsMask && (
            <div style={{ marginTop: 14 }}>
              <MaskCanvas imageUrl={previewUrl} handleRef={maskRef} />
            </div>
          )}
          {previewUrl && !needsMask && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl} alt="選んだ写真" className="preview" style={{ marginTop: 14 }} />
          )}
        </section>

        <section className="panel">
          <h2>2. 加工内容を選ぶ</h2>

          <div style={{ marginBottom: 16 }}>
            <p className="muted" style={{ margin: "0 0 6px" }}>
              メイクの強さ（必須）
            </p>
            <div className="strengths">
              {catalog.makeupStrengths.map((strength) => (
                <button
                  key={strength.id}
                  type="button"
                  aria-pressed={makeupStrength === strength.id}
                  onClick={() => setMakeupStrength(strength.id)}
                >
                  {strength.labelJa}
                </button>
              ))}
            </div>
          </div>

          {catalog.categories.map((category) => {
            const on = picked[category.id] !== undefined;
            return (
              <div className="category" key={category.id}>
                <header>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={category.templates.length === 0}
                    onChange={() =>
                      toggleCategory(category.id, category.templates[0]?.id ?? "")
                    }
                  />
                  <span>{category.labelJa}</span>
                  {category.requiresMask && (
                    <span className="muted">（塗った範囲だけを作り直します）</span>
                  )}
                </header>

                {on && category.templates.length > 0 && (
                  <>
                    <select
                      value={picked[category.id]}
                      onChange={(e) =>
                        setPicked((c) => ({ ...c, [category.id]: e.target.value }))
                      }
                      style={{ marginTop: 8 }}
                    >
                      {category.templates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.labelJa}
                        </option>
                      ))}
                    </select>
                    <p className="muted" style={{ margin: "6px 0 0" }}>
                      {
                        category.templates.find((t) => t.id === picked[category.id])
                          ?.noteJa
                      }
                    </p>
                  </>
                )}
              </div>
            );
          })}

          <p className="muted">
            指示文は固定のテンプレートから選ぶ方式です（自由入力欄はありません）。テンプレート版数:{" "}
            {catalog.templateVersion}
          </p>

          <label className="row" style={{ margin: "16px 0", alignItems: "flex-start" }}>
            <input
              type="checkbox"
              checked={rights}
              onChange={(e) => setRights(e.target.checked)}
              style={{ marginTop: 6 }}
            />
            <span style={{ flex: 1 }}>
              この写真は、写っている本人から掲載・加工について同意を得たものです。
            </span>
          </label>

          <button className="primary" type="button" onClick={generate} disabled={busy || !file}>
            {busy ? "生成中…（最大 3 分ほどかかります）" : "この内容で 1 枚つくる"}
          </button>
        </section>
      </div>

      {result && (
        <section className="panel">
          <h2>結果</h2>
          <div className="grid2">
            <figure style={{ margin: 0 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={result.sourceUrl} alt="元の写真" className="preview" />
              <figcaption className="muted">元の写真</figcaption>
            </figure>
            <figure style={{ margin: 0 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={result.resultUrl} alt="生成結果" className="preview" />
              <figcaption className="muted">生成結果</figcaption>
            </figure>
          </div>
        </section>
      )}

      {history.length > 0 && (
        <section className="panel">
          <h2>これまでの結果</h2>
          <div className="history">
            {history.map((job) => (
              <figure key={job.id}>
                {job.resultUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={job.resultUrl} alt="生成結果" className="preview" />
                ) : (
                  <div
                    className="preview"
                    style={{ padding: 12, fontSize: 12, color: "var(--danger)" }}
                  >
                    {job.errorKind === "policy"
                      ? "安全性判定により拒否されました"
                      : (job.errorMessage ?? job.status)}
                  </div>
                )}
                <figcaption>
                  {new Date(job.createdAt).toLocaleString("ja-JP")}
                  <br />
                  {job.categoryIds.join(" / ")}
                  {job.latencyMs !== null && ` ／ ${(job.latencyMs / 1000).toFixed(1)} 秒`}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
