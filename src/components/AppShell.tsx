"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { MaskTool, type MaskHandle } from "./MaskTool";
import { SettingsModal } from "./SettingsModal";
import type { Catalog, CategoryId } from "@/lib/catalog";
import type { MakeupStrength } from "@/lib/catalog";

/**
 * 確定 UI（index.html）の 3 カラム画面。
 * 構造・クラス名・文言はモックのまま。中身を実データに差し替えてある。
 */

type Slot = {
  slot: number;
  makeupStrength: MakeupStrength;
  variant: number;
  status: "queued" | "running" | "succeeded" | "failed";
  latencyMs: number | null;
  costUsd: number | null;
  errorKind: string | null;
  errorMessage: string | null;
  url: string | null;
};

type SessionData = {
  profile: {
    email: string;
    maxImages: number;
    usedImages: number;
    remainingImages: number;
  } | null;
  usage: { monthCount: number; monthCostUsd: number; todayCostUsd: number };
  history: {
    id: string;
    status: string;
    createdAt: string;
    title: string;
    modelName: string | null;
    imageCount: number;
  }[];
};

const STRENGTH_LABEL: Record<MakeupStrength, string> = {
  weak: "弱",
  medium: "中",
  strong: "強",
};

/** 確定 UI の店舗・キャストの候補（datalist）。 */
const STORE_OPTIONS = ["THE ESPERANZA", "ESPERANZA ANNEX", "クラブ ピア", "いたずらBUNNYちゃん"];

export function AppShell({
  catalog,
  email,
  isAdmin,
}: {
  catalog: Catalog;
  email: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const maskRef = useRef<MaskHandle>(null);

  // ── STEP 0 ──
  const [storeName, setStoreName] = useState("");
  const [castName, setCastName] = useState("");
  const [castOptions, setCastOptions] = useState(["アリス", "マイ", "サクラ", "レナ", "ハルカ"]);
  const [showCastRegister, setShowCastRegister] = useState(false);
  const [newCastName, setNewCastName] = useState("");
  const [newCastYm, setNewCastYm] = useState("");
  const [manualTitle, setManualTitle] = useState<string | null>(null);

  // ── STEP 1 ──
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // ── STEP 2 ──
  const [enabled, setEnabled] = useState<Partial<Record<CategoryId, boolean>>>({});
  const [templateIds, setTemplateIds] = useState<Partial<Record<CategoryId, string>>>({});
  const [freeTexts, setFreeTexts] = useState<Partial<Record<CategoryId, string>>>({});
  const [maskStrokes, setMaskStrokes] = useState(0);
  const [rights, setRights] = useState(false);

  // ── STEP 3 ──
  const [jobId, setJobId] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [registering, setRegistering] = useState(false);
  const [gateMessage, setGateMessage] = useState<string | null>(null);
  const [moderationWarning, setModerationWarning] = useState<string | null>(null);

  const [session, setSession] = useState<SessionData | null>(null);
  const [sessionRuns, setSessionRuns] = useState(0);
  const [chat, setChat] = useState<{ role: "assistant" | "user" | "warn"; text: string }[]>([
    {
      role: "assistant",
      text: "キャストの本人性を固定しています。6枚のドラフト候補から1枚を選び、「衣装を明るい赤のシルクに変更して」「背景のライトをもう少し落として」等の自然言語指示でピンポイント修正が可能です（直前に選択した画像を入力とした逐次編集）。反復による画質劣化を避けるため、5回を超える連続編集では原本からの再編集をおすすめします。",
    },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatExpanded, setChatExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);

  const removalOn = enabled.tattoo_removal === true;
  const jobRunning = registering || slots.some((s) => s.status === "queued" || s.status === "running");

  // ── セッション情報（当月の利用状況・履歴） ──
  const reloadSession = useCallback(async () => {
    const response = await fetch("/api/session", { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (response.ok && data?.ok) setSession(data as SessionData);
  }, []);

  useEffect(() => {
    void reloadSession();
  }, [reloadSession]);

  // ── 元画像のプレビュー ──
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [chat]);

  // ── F-09 セッション名の自動生成 ──
  const autoTitle = useMemo(() => {
    const store = storeName.trim() || "店舗未選択";
    const cast = castName.trim() || "キャスト未入力";
    const parts: string[] = [];
    const makeupTemplate = templateIds.makeup;
    const makeupLabel = catalog.categories
      .find((c) => c.id === "makeup")
      ?.templates.find((t) => t.id === makeupTemplate)?.labelJa;
    parts.push(makeupLabel ? `メイク(${makeupLabel.slice(0, 6)})` : "メイク");
    for (const category of catalog.categories) {
      if (category.id === "makeup") continue;
      if (enabled[category.id]) parts.push(category.titleJa.replace(/設定|指定|・不要物除去/g, ""));
    }
    return `${store}_${cast}_${parts.join("・")}`;
  }, [storeName, castName, enabled, templateIds, catalog]);

  const sessionTitle = manualTitle ?? autoTitle;

  // ── ジョブのポーリング（できたスロットから埋まる） ──
  useEffect(() => {
    if (!jobId) return;
    let stop = false;

    async function tick() {
      const response = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (stop || !response.ok || !data?.ok) return;

      setSlots(data.slots as Slot[]);

      const pending = (data.slots as Slot[]).some(
        (s) => s.status === "queued" || s.status === "running",
      );
      if (pending) {
        setTimeout(() => void tick(), 2000);
      } else {
        void reloadSession();
        finishGeneration(data.slots as Slot[]);
      }
    }

    void tick();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  function pushChat(role: "assistant" | "user" | "warn", text: string) {
    setChat((current) => [...current, { role, text }]);
  }

  function finishGeneration(finished: Slot[]) {
    const ok = finished.filter((s) => s.status === "succeeded").length;
    const policy = finished.filter((s) => s.errorKind === "policy").length;
    const infra = finished.filter((s) => s.errorKind === "infra").length;

    const activeCats = catalog.categories
      .filter((c) => c.id === "makeup" || enabled[c.id])
      .map((c) => c.titleJa.replace(/設定|指定|・不要物除去/g, ""));

    const removal =
      removalOn && maskStrokes > 0
        ? " タトゥー除去はマスク領域のみをインペインティング修復しています（マスク外は不変）。"
        : "";

    let text = `メイク強度「弱・中・強」各2枚、計${finished.length}枚のドラフト候補（1K）を生成しました。成功 ${ok} 枚。反映レイヤー：${activeCats.join("・")}。${removal}`;
    if (policy > 0) {
      text += ` ${policy} 枚は安全性判定により拒否されました。文言を変えた再投入は行いません（拒否は記録に残ります）。`;
      setModerationWarning(
        "⚠️ 一部の候補が安全性判定により拒否されました。別の写真、または別のテンプレートでお試しください。",
      );
    }
    if (infra > 0) text += ` ${infra} 枚は障害により失敗しました（この分の枚数は返却済みです）。`;
    pushChat("assistant", text);
  }

  // ── STEP 3 実行 ──
  async function executeGeneration() {
    if (jobRunning) return;
    setGateMessage(null);
    setModerationWarning(null);

    if (!storeName.trim()) {
      setGateMessage("STEP 0 の店舗名が未入力です。画像整理のため店舗を選択してください。");
      return;
    }
    if (!castName.trim()) {
      setGateMessage("STEP 0 のキャスト名が未入力です。画像整理のためキャスト名を選択してください。");
      return;
    }
    if (!file) {
      setGateMessage("STEP 1 でキャストの元画像をアップロードしてください。");
      return;
    }
    if (removalOn && maskStrokes === 0) {
      setGateMessage(
        "タトゥー・不要物除去が有効ですが、マスクが未指定です。元画像上で除去範囲をブラシで塗るか、カードを無効化してください。",
      );
      return;
    }
    if (!rights) {
      setGateMessage("「本人の同意を得た写真である」にチェックしてください。");
      return;
    }

    setRegistering(true);
    setSelectedSlot(null);
    setSlots([]);

    const form = new FormData();
    form.set("source", file);
    form.set("rightsConfirmed", "true");
    form.set("storeName", storeName.trim());
    form.set("castName", castName.trim());
    form.set("sessionTitle", sessionTitle);

    const selections = catalog.categories
      .filter((c) => c.id === "makeup" || enabled[c.id])
      .map((c) => ({
        categoryId: c.id,
        templateId: templateIds[c.id] ?? "",
        freeText: freeTexts[c.id] ?? "",
      }));
    form.set(
      "selection",
      JSON.stringify({ selections, removalType: templateIds.tattoo_removal ?? null }),
    );

    if (removalOn) {
      const blob = await maskRef.current?.toBlob();
      if (!blob) {
        setRegistering(false);
        setGateMessage("マスクが取得できませんでした。もう一度塗ってください。");
        return;
      }
      form.set("mask", new File([blob], "mask.png", { type: "image/png" }));
    }

    try {
      const response = await fetch("/api/generate", { method: "POST", body: form });
      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.ok) {
        setGateMessage(data?.message ?? "生成ジョブを登録できませんでした。");
        setRegistering(false);
        return;
      }

      setSessionRuns((n) => n + 1);
      setJobId(data.jobId as string);
      void reloadSession();
    } catch {
      setGateMessage("通信に失敗しました。時間をおいてもう一度お試しください。");
    } finally {
      setRegistering(false);
    }
  }

  function createNewSession() {
    if (!confirm("現在の加工設定をクリアして、新しい画像加工を開始しますか？")) return;
    setFile(null);
    setCastName("");
    setEnabled({});
    setTemplateIds({});
    setFreeTexts({});
    setMaskStrokes(0);
    setRights(false);
    setJobId(null);
    setSlots([]);
    setSelectedSlot(null);
    setManualTitle(null);
    setSessionRuns(0);
    setGateMessage(null);
    setModerationWarning(null);
  }

  function registerNewCast() {
    const name = newCastName.trim();
    if (!name) {
      setGateMessage("キャスト名を入力してください。");
      return;
    }
    const label = newCastYm ? `${name}_${newCastYm.replace("-", "")}` : name;
    setCastOptions((options) => (options.includes(label) ? options : [...options, label]));
    setCastName(label);
    setNewCastName("");
    setNewCastYm("");
    setShowCastRegister(false);
  }

  function sendChatMessage() {
    const text = chatInput.trim();
    if (!text) return;
    if (selectedSlot === null) {
      pushChat("warn", "先に修正対象の候補画像を1枚選択してください（逐次編集は選択画像を入力とします）。");
      return;
    }
    pushChat("user", text);
    setChatInput("");
    // ★ F-05（逐次編集）はこの体験環境では未実装。
    //   もっともらしい応答を返すと「効いているのに見た目が変わらない」と誤解される。
    pushChat(
      "assistant",
      "個別修正（F-05 逐次編集）は、この体験環境ではまだ実装されていません。指示は送信されておらず、画像は変更されていません。現時点では STEP 2 の条件を変えて 6 枚を作り直してください。",
    );
  }

  async function saveImage(slot: Slot) {
    if (!slot.url) return;
    // 確定 UI は「高解像度で再生成し Google Drive へ保存」だが、
    // この体験環境では 2K 再生成も Drive 連携も未実装。実際にできる保存＝ダウンロード。
    const link = document.createElement("a");
    link.href = slot.url;
    link.download = `${sessionTitle}_候補${slot.slot + 1}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    pushChat(
      "assistant",
      `候補${slot.slot + 1}をダウンロードしました。確定処理（高解像度2K再生成・Google Drive 共有ドライブへの自動保存）は、この体験環境では未実装です。`,
    );
  }

  async function signOut() {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const doneCount = slots.filter((s) => s.status === "succeeded" || s.status === "failed").length;
  const progressPct = slots.length > 0 ? Math.round((doneCount / slots.length) * 100) : 0;

  return (
    <div id="app-wrapper" style={{ display: "flex" }}>
      <div className="main-container">
        {/* ══════════ 左カラム ══════════ */}
        <div className="column sidebar">
          <div className="sidebar-top">
            <div className="app-title-area">
              <span className="app-title-icon">
                <i className="fa-solid fa-wand-magic-sparkles" />
              </span>
              <span className="app-title-text">AI Canvas</span>
              <span className="app-title-ver">v2.0</span>
            </div>

            <button className="new-chat-btn" onClick={createNewSession}>
              <i className="fa-solid fa-plus" /> 新しい画像加工セッション
            </button>

            <div className="usage-mini">
              <div className="usage-mini-title">
                <i className="fa-solid fa-gauge-high" /> 当月の利用状況
              </div>
              <div className="usage-mini-row">
                <span className="label">当月の生成回数</span>
                <span className="value">{session?.usage.monthCount ?? 0} 枚</span>
              </div>
              <div className="usage-mini-row">
                <span className="label">当月の推定コスト</span>
                <span className="value cost">
                  ${(session?.usage.monthCostUsd ?? 0).toFixed(2)}
                </span>
              </div>
              <div className="usage-mini-row">
                <span className="label">あなたの残り枚数</span>
                <span className="value">{session?.profile?.remainingImages ?? "—"} 枚</span>
              </div>
            </div>

            <div className="history-section" id="history-list">
              <div className="history-label">加工セッション履歴</div>
              {(session?.history ?? []).length === 0 && (
                <div className="history-item">
                  <div className="h-title">
                    <i className="fa-regular fa-image" /> まだ履歴はありません
                  </div>
                </div>
              )}
              {(session?.history ?? []).map((item) => (
                <div
                  key={item.id}
                  className={`history-item${jobId === item.id ? " active" : ""}`}
                  onClick={() => {
                    setJobId(item.id);
                    setSelectedSlot(null);
                  }}
                >
                  <div className="h-title">
                    <i className="fa-regular fa-image" />{" "}
                    {item.title.length > 18 ? `${item.title.slice(0, 18)}…` : item.title}
                  </div>
                  <div className="h-meta">
                    {new Date(item.createdAt).toLocaleDateString("ja-JP")} ・{" "}
                    {item.modelName ?? "—"} ・ {item.imageCount} 枚
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="sidebar-bottom">
            {isAdmin && (
              <button className="nav-button" onClick={() => setSettingsOpen(true)}>
                <i className="fa-solid fa-sliders" /> ⚙️ 管理者向けシステム設定
              </button>
            )}
            <button
              className="nav-button"
              onClick={() =>
                pushChat(
                  "assistant",
                  "使い方：STEP 0 で店舗・キャストを選び、STEP 1 で写真をアップロードし、STEP 2 で変えたい項目を有効にしてテンプレートを選び、STEP 3 で生成します。タトゥー除去は元画像上でブラシを塗ってください。",
                )
              }
            >
              <i className="fa-solid fa-book-open" /> ヘルプ＆ドキュメント
            </button>

            <div className="user-profile">
              <span className="user-email">{email}</span>
              <div className="user-role-container">
                <span
                  className="user-role-badge"
                  style={
                    isAdmin
                      ? { color: "#0284c7", background: "rgba(14, 165, 233, 0.08)" }
                      : { color: "#d97706", background: "rgba(251, 191, 36, 0.08)" }
                  }
                >
                  {isAdmin ? "管理者" : "店舗スタッフ"}
                </span>
                <span className="logout-text" onClick={signOut}>
                  <i className="fa-solid fa-arrow-right-from-bracket" /> ログアウト
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* ══════════ 中央カラム ══════════ */}
        <div className="column" id="center-operation-column">
          <div className="center-header">
            <div className="title-input-wrapper">
              <input
                type="text"
                className="editable-title"
                value={sessionTitle}
                onChange={(e) => setManualTitle(e.target.value)}
                title="クリックしてタイトルを編集できます"
                placeholder="セッションタイトルを入力"
              />
            </div>
          </div>

          {/* ── STEP 0 ── */}
          <div className="step-heading">
            <span className="step-num">STEP 0</span> 店舗・キャスト選択
          </div>
          <div className="card" id="asset-info-card">
            <div className="card-title">
              <span
                className="cat-letter"
                style={{
                  background: "rgba(15,23,42,0.06)",
                  color: "var(--text-main)",
                  borderColor: "#e2e8f0",
                }}
              >
                0
              </span>{" "}
              画像管理情報の指定
              <span className="required-tag">必須</span>
              <span className="title-note">ファイル名・保存フォルダに使用</span>
            </div>
            <div className="card-grid-fields">
              <div className="input-group">
                <label>
                  <i className="fa-solid fa-store" style={{ marginRight: 6, color: "var(--text-muted)" }} />{" "}
                  店舗選択
                </label>
                <div className="suggest-input-wrap">
                  <input
                    type="text"
                    list="store-options"
                    placeholder="店舗名を入力または選択"
                    autoComplete="off"
                    value={storeName}
                    onChange={(e) => setStoreName(e.target.value)}
                  />
                  <i className="fa-solid fa-chevron-down suggest-caret" />
                </div>
                <datalist id="store-options">
                  {STORE_OPTIONS.map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
              </div>

              <div className="input-group">
                <label>
                  <i className="fa-solid fa-user" style={{ marginRight: 6, color: "var(--text-muted)" }} />{" "}
                  キャスト名
                </label>
                <div className="suggest-input-wrap">
                  <input
                    type="text"
                    list="cast-options"
                    placeholder="キャスト名を入力または選択"
                    autoComplete="off"
                    value={castName}
                    onChange={(e) => setCastName(e.target.value)}
                  />
                  <i className="fa-solid fa-chevron-down suggest-caret" />
                </div>
                <datalist id="cast-options">
                  {castOptions.map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
                <button className="cast-register-link" onClick={() => setShowCastRegister(true)}>
                  <i className="fa-solid fa-user-plus" /> 新規キャストを登録（F-14）
                </button>
              </div>

              <div className={`cast-register-box${showCastRegister ? " show" : ""}`}>
                <div className="crb-title">
                  <i className="fa-solid fa-user-plus" style={{ color: "var(--primary)" }} />{" "}
                  キャスト新規登録
                </div>
                <div className="cast-register-fields">
                  <input
                    type="text"
                    placeholder="キャスト名（源氏名）"
                    value={newCastName}
                    onChange={(e) => setNewCastName(e.target.value)}
                  />
                  <input
                    type="month"
                    title="入店年月"
                    value={newCastYm}
                    onChange={(e) => setNewCastYm(e.target.value)}
                  />
                </div>
                <div className="crb-actions">
                  <button className="crb-btn primary" onClick={registerNewCast}>
                    登録して選択
                  </button>
                  <button className="crb-btn ghost" onClick={() => setShowCastRegister(false)}>
                    キャンセル
                  </button>
                </div>
                <div className="crb-note">
                  <i className="fa-solid fa-database" />{" "}
                  この体験環境ではキャストマスタへの登録は行いません。入力した名前はこのセッションの候補と、生成記録の整理用ラベルとしてのみ使われます。
                </div>
              </div>

              <div className="naming-preview">
                <i className="fa-solid fa-tag" style={{ color: "var(--primary)" }} /> 自動ネーミング：{" "}
                <code>{autoTitle}</code>
              </div>
            </div>
          </div>

          {/* ── STEP 1 ── */}
          <div className="step-heading">
            <span className="step-num">STEP 1</span> 元画像のアップロード（編集対象の原本）
          </div>
          <div
            className={`upload-section${dragOver ? " dragover" : ""}`}
            onDragEnter={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setDragOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const dropped = e.dataTransfer.files?.[0];
              if (dropped) setFile(dropped);
            }}
          >
            {!previewUrl && (
              <label className="upload-box" style={{ display: "block", cursor: "pointer" }}>
                <i className="fa-solid fa-cloud-arrow-up" />
                <p style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-main)" }}>
                  写真をドラッグ＆ドロップ、またはクリックして選択
                </p>
                <p style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: 4 }}>
                  ※本人性（顔立ち・表情）を保持したまま指定レイヤーのみを画像編集します
                </p>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  style={{ display: "none" }}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
            )}

            {previewUrl && (
              <div className="preview-container" style={{ display: "flex" }}>
                <div className="preview-wrap">
                  <span className="status-badge">
                    <i className="fa-solid fa-user-check" /> 読み込み完了
                  </span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={previewUrl} alt="元画像プレビュー" />
                </div>
                <div className="upload-meta-text">
                  <strong>本人性の保持を指示に含めます</strong>
                  <br />
                  以下の加工カテゴリ指定に従い、この原本を入力とした画像編集を行います。顔の造作を変えないことは毎回プロンプトで明示されます。
                  <br />
                  <span
                    className="logout-text"
                    style={{ marginLeft: 0 }}
                    onClick={() => setFile(null)}
                  >
                    <i className="fa-solid fa-rotate-left" /> 別の写真を選ぶ
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* ── STEP 2 ── */}
          <div className="step-heading">
            <span className="step-num">STEP 2</span> 加工カテゴリ設定（メイク以外は有効／無効を選択）
          </div>

          {catalog.categories.map((category) => {
            const on = category.required || enabled[category.id] === true;
            return (
              <div
                key={category.id}
                className={`card ${on ? "enabled" : "disabled"}`}
                data-category={category.titleJa}
              >
                <div className="card-title">
                  <span
                    className="cat-letter"
                    style={
                      category.processKind === "C"
                        ? {
                            background: "rgba(245,158,11,0.1)",
                            color: "var(--type-c)",
                            borderColor: "rgba(245,158,11,0.22)",
                          }
                        : undefined
                    }
                  >
                    {category.letterJa}
                  </span>{" "}
                  {category.titleJa}
                  <span className={`type-badge type-${category.processKind.toLowerCase()}`}>
                    {category.processLabelJa}
                  </span>
                  {category.required ? (
                    <span className="required-tag">必須</span>
                  ) : (
                    <div className="card-enable">
                      <span className="enable-text">{on ? "有効" : "無効"}</span>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setEnabled((c) => ({ ...c, [category.id]: checked }));
                            if (checked && !templateIds[category.id]) {
                              setTemplateIds((c) => ({
                                ...c,
                                [category.id]: category.templates[0]?.id ?? "",
                              }));
                            }
                          }}
                        />
                        <span className="slider" />
                      </label>
                    </div>
                  )}
                </div>

                <div className="card-body">
                  <div className="card-grid-fields">
                    {category.id === "makeup" && (
                      <div className="make-notice">
                        <i className="fa-solid fa-wand-magic-sparkles" />
                        <div>
                          加工強度の選択は不要です。AIが
                          <strong>
                            「弱」「中」「強」の各強度で2枚ずつ、合計6枚のドラフト候補（1K・低解像度）を出力
                          </strong>
                          します。生成後、右カラムの候補から気に入った1枚を選べます。
                          <div className="make-strength-chips">
                            {catalog.makeupStrengths.map((strength) => (
                              <span key={strength.id} className="make-strength-chip">
                                {strength.labelJa} × 2枚
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}

                    {category.requiresMask && (
                      <>
                        <div
                          className="make-notice"
                          style={{
                            background:
                              "linear-gradient(135deg, rgba(245,158,11,0.06), rgba(244,63,94,0.05))",
                            borderColor: "rgba(245,158,11,0.2)",
                          }}
                        >
                          <i className="fa-solid fa-eraser" style={{ color: "var(--type-c)" }} />
                          <div>
                            他カテゴリと処理方式が異なります。参考画像は使用せず、
                            <strong>元画像上でブラシを塗って除去範囲（マスク）を指定</strong>
                            してください。マスク領域のみをインペインティング修復し、
                            <strong>マスク外は一切変更しません</strong>（F-15）。
                          </div>
                        </div>

                        <MaskTool
                          imageUrl={previewUrl}
                          handleRef={maskRef}
                          onStrokesChange={setMaskStrokes}
                        />
                        <div className="mask-coverage">
                          <span className="dot" />{" "}
                          {maskStrokes === 0
                            ? "マスク未指定 — 除去したい箇所をブラシで塗ってください"
                            : `マスク指定済み：${maskStrokes} ストローク（マスク領域のみ修復し、マスク外は変更しません）`}
                        </div>
                      </>
                    )}

                    {category.acceptsReferences && (
                      <div className="input-group full-width">
                        <label>
                          参考画像をアップロード<span className="recommend-tag">未対応</span>
                        </label>
                        <div className="ref-drop" style={{ cursor: "not-allowed", opacity: 0.65 }}>
                          <i className="fa-solid fa-circle-info" />{" "}
                          参考画像（種別B）はこの体験環境では未対応です。下のテンプレートから選んでください
                        </div>
                      </div>
                    )}

                    <div className="input-group full-width">
                      <label>{category.selectLabelJa}</label>
                      <select
                        className="tpl-select"
                        value={templateIds[category.id] ?? ""}
                        disabled={!on}
                        onChange={(e) =>
                          setTemplateIds((c) => ({ ...c, [category.id]: e.target.value }))
                        }
                      >
                        <option value="">選択してください（未選択）</option>
                        {category.templates.map((template) => (
                          <option key={template.id} value={template.id}>
                            {template.labelJa}
                          </option>
                        ))}
                      </select>
                      {templateIds[category.id] && (
                        <div className="setting-note" style={{ marginTop: 6 }}>
                          <i className="fa-solid fa-circle-info" />{" "}
                          {category.templates.find((t) => t.id === templateIds[category.id])?.noteJa}
                        </div>
                      )}
                    </div>

                    <div className="input-group full-width">
                      <label>
                        {category.freeTextLabelJa}
                        <span className="recommend-tag">任意</span>
                      </label>
                      <input
                        type="text"
                        className="free-text"
                        maxLength={200}
                        disabled={!on}
                        placeholder={category.freeTextPlaceholder}
                        value={freeTexts[category.id] ?? ""}
                        onChange={(e) =>
                          setFreeTexts((c) => ({ ...c, [category.id]: e.target.value }))
                        }
                      />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* ══════════ 右カラム ══════════ */}
        <div className="column" id="right-result-column">
          <div className="right-column-container">
            <div className="action-area">
              <div className="step-heading" style={{ marginBottom: 2 }}>
                <span className="step-num">STEP 3</span> 生成実行
              </div>

              <label className={`rights-consent${rights ? "" : " unchecked"}`}>
                <input
                  type="checkbox"
                  checked={rights}
                  onChange={(e) => setRights(e.target.checked)}
                />
                <span>
                  この写真は、写っている本人から掲載・加工について
                  <strong>同意を得たもの</strong>です。
                </span>
              </label>

              <div className="generate-btn-wrapper">
                <button className="generate-btn" onClick={executeGeneration} disabled={jobRunning}>
                  <i className="fa-solid fa-bolt" />{" "}
                  {jobRunning ? "生成中…" : "ドラフト6枚を生成（非同期ジョブ）"}
                </button>
              </div>

              {gateMessage && (
                <div className="gate-note">
                  <i className="fa-solid fa-triangle-exclamation" />
                  <span>{gateMessage}</span>
                </div>
              )}

              <div className="usage-counter">
                <div className="usage-counter-row">
                  <div className="usage-stat">
                    セッション <strong>{sessionRuns}</strong> 回
                  </div>
                  <div className="usage-stat">
                    当月 <strong>{session?.usage.monthCount ?? 0}</strong> 枚
                  </div>
                  <div className="usage-stat">
                    本日推定 <strong className="cost">${(session?.usage.todayCostUsd ?? 0).toFixed(2)}</strong>
                  </div>
                  <div className="usage-stat quota">
                    残り <strong>{session?.profile?.remainingImages ?? "—"}</strong> 枚
                  </div>
                </div>
              </div>

              {registering && (
                <div className="loading-overlay" style={{ display: "flex" }}>
                  <div className="spinner" />
                  <div className="loading-text">生成ジョブを登録中...</div>
                  <div className="loading-subtext">
                    上限を確認し、抽象化レイヤー経由でプロバイダへ投入します
                  </div>
                </div>
              )}

              <div style={{ marginTop: 4, position: "relative" }}>
                <div className="results-header">
                  <h4>
                    <i className="fa-regular fa-images" /> 生成候補（6枚 / 弱・中・強 各2枚）
                  </h4>
                  {slots.length > 0 && (
                    <div className="job-progress" style={{ display: "flex" }}>
                      <span>
                        {doneCount}/{slots.length} 完了
                      </span>
                      <div className="job-progress-bar">
                        <span style={{ width: `${progressPct}%` }} />
                      </div>
                    </div>
                  )}
                </div>

                {moderationWarning && (
                  <div className="moderation-warning" style={{ display: "flex" }}>
                    <i className="fa-solid fa-triangle-exclamation" />
                    <span>{moderationWarning}</span>
                    <button
                      className="moderation-warning-close"
                      onClick={() => setModerationWarning(null)}
                    >
                      <i className="fa-solid fa-xmark" />
                    </button>
                  </div>
                )}

                <div className="results-grid">
                  {(slots.length > 0
                    ? slots
                    : Array.from({ length: 6 }, (_, i) => null as Slot | null)
                  ).map((slot, index) => {
                    if (!slot) {
                      return (
                        <div className="result-item" key={`empty-${index}`}>
                          <div className="slot-state slot-waiting">
                            <i className="fa-regular fa-image" style={{ fontSize: "1.1rem", opacity: 0.5 }} />
                            画像未生成
                            <span className="slot-strength">
                              メイク {["弱", "弱", "中", "中", "強", "強"][index]}
                            </span>
                          </div>
                        </div>
                      );
                    }

                    const label = `${STRENGTH_LABEL[slot.makeupStrength]} - パターン${slot.variant === 1 ? "A" : "B"}`;

                    if (slot.status === "queued") {
                      return (
                        <div className="result-item" key={slot.slot}>
                          <span className="slot-tag waiting">待機中</span>
                          <div className="slot-state slot-waiting">
                            <i className="fa-regular fa-clock" />
                            キュー待機中
                            <span className="slot-strength">{label}</span>
                          </div>
                        </div>
                      );
                    }
                    if (slot.status === "running") {
                      return (
                        <div className="result-item" key={slot.slot}>
                          <span className="slot-tag generating">生成中</span>
                          <div className="slot-state slot-generating">
                            <div className="mini-spinner" />
                            生成中...
                            <span className="slot-strength">{label}</span>
                          </div>
                        </div>
                      );
                    }
                    if (slot.status === "failed") {
                      return (
                        <div className="result-item" key={slot.slot}>
                          <span className="slot-tag failed">失敗</span>
                          <div className="slot-state slot-failed">
                            <i className="fa-solid fa-triangle-exclamation" />
                            {slot.errorKind === "policy"
                              ? "安全性判定により拒否"
                              : slot.errorKind === "input"
                                ? "送信内容に不備"
                                : "生成に失敗しました"}
                            <span className="slot-strength">{label}</span>
                            {slot.errorKind === "policy" && (
                              <span className="slot-reason">
                                同じ内容を言い換えて再投入することはしません
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div
                        className={`result-item${selectedSlot === slot.slot ? " selected" : ""}`}
                        key={slot.slot}
                        onClick={() => setSelectedSlot(slot.slot)}
                      >
                        <span className="slot-tag done">完了</span>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={slot.url ?? ""} alt={label} />
                        <div className="result-actions">
                          <span className="result-badge">{label}</span>
                          <button
                            className="action-icon-btn"
                            title="ダウンロード"
                            onClick={(e) => {
                              e.stopPropagation();
                              void saveImage(slot);
                            }}
                          >
                            <i className="fa-solid fa-floppy-disk" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* 個別やり直しチャット */}
            <div className={`chat-section${chatExpanded ? " expanded" : ""}`}>
              <div className="chat-header-bar">
                <div className="chat-header-left">
                  <i className="fa-solid fa-comments" />
                  <span>個別修正アシスタント</span>
                  <span className="ai-badge">逐次編集</span>
                </div>
                <button className="expand-toggle-btn" onClick={() => setChatExpanded((v) => !v)}>
                  <i className={chatExpanded ? "fa-solid fa-compress" : "fa-solid fa-expand"} />{" "}
                  <span>{chatExpanded ? "元に戻す" : "全画面表示"}</span>
                </button>
              </div>
              <div className="chat-history" ref={chatRef}>
                {chat.map((message, index) => (
                  <div
                    key={index}
                    className={`msg ${message.role === "warn" ? "system-warn" : message.role}`}
                  >
                    {message.role === "warn" && <i className="fa-solid fa-triangle-exclamation" />}{" "}
                    {message.text}
                  </div>
                ))}
              </div>
              <div className="chat-input-area">
                <input
                  type="text"
                  placeholder="選択中の候補への部分修正指示を入力..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") sendChatMessage();
                  }}
                />
                <button onClick={sendChatMessage}>送信</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
