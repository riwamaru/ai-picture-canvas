"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { MaskTool, type MaskHandle } from "./MaskTool";
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
  provider: "openai" | "google" | null;
  editMethod: "inpaint" | "semantic_mask" | "instruct" | null;
  attemptedProvider: "openai" | "google" | null;
  attemptedErrorKind: string | null;
  latencyMs: number | null;
  costUsd: number | null;
  errorKind: string | null;
  errorMessage: string | null;
  url: string | null;
};

/**
 * 確定画像（仕様書 STEP 5）。選んだ 1 枚を高解像度で作り直したもの。
 * Drive へ入るのはこれだけで、ドラフト 4 枚は Supabase 側に留まる。
 */
type FinalImage = {
  sourceSlot: number;
  sourceStepId: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  resolution: "1k" | "2k";
  provider: "openai" | "google" | null;
  editMethod: "inpaint" | "semantic_mask" | "instruct" | null;
  costUsd: number | null;
  latencyMs: number | null;
  errorKind: string | null;
  errorMessage: string | null;
  // failed は「Supabase には残っているが Drive へ送れていない」状態。画像は失われていない。
  driveStatus: "none" | "pending" | "synced" | "failed";
  driveViewUrl: string | null;
  driveSyncedAt: string | null;
  url: string | null;
};

/** 個別修正（F-05 逐次編集）の 1 回分。 */
type EditStep = {
  id: string;
  stepNo: number;
  sourceKind: "draft" | "step";
  sourceSlot: number | null;
  instruction: string;
  status: "queued" | "running" | "succeeded" | "failed";
  provider: "openai" | "google" | null;
  attemptedProvider: "openai" | "google" | null;
  costUsd: number | null;
  latencyMs: number | null;
  errorKind: string | null;
  errorMessage: string | null;
  createdAt: string;
  url: string | null;
};

/** 履歴から開き直すときに使う、ジョブの入力値。 */
type RestorableJob = {
  jobMode: "normal" | "removal";
  storeName: string | null;
  castName: string | null;
  sessionTitle: string | null;
  categoryIds: string[];
  templateIds: Record<string, string>;
  freeTexts: Record<string, string>;
  sourceUrl: string | null;
  referenceUrls: Record<string, string[]>;
};

type ChatMessage = {
  role: "assistant" | "user" | "warn";
  text: string;
  /** 修正結果のサムネイル。 */
  image?: string | null;
  /** どの修正に対応するか（履歴の再読込で二重に並べないため）。 */
  stepId?: string;
};

type SessionData = {
  /** 管理者設定で Drive 保存が有効か。false でも確定（高解像度の再生成）は行える。 */
  driveEnabled: boolean;
  /** 確定画像の解像度。 */
  finalResolution: "1k" | "2k";
  /** 確定 1 回の実費の見込み（USD）。押す前に見せる。 */
  finalUnitUsd: number;
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
    costUsd: number;
  }[];
};

/** チャット・バッジで使う短い表示名。 */
const PROVIDER_LABEL_SHORT: Record<"openai" | "google", string> = {
  openai: "OpenAI",
  google: "Google（Gemini）",
};

/** そのスロットが確定済みか。 */
function isConfirmed(final: FinalImage | null, slot: number): boolean {
  return final?.status === "succeeded" && final.sourceSlot === slot;
}

function confirmClass(final: FinalImage | null, slot: number): string {
  if (!isConfirmed(final, slot)) return "";
  // Drive 未同期でも確定そのものは成功している。色で区別する。
  return final!.driveStatus === "failed" ? " drive-failed" : " drive-synced";
}

function confirmTitle(final: FinalImage | null, slot: number, session: SessionData | null): string {
  if (isConfirmed(final, slot)) {
    if (final!.driveStatus === "synced") return "確定済み（押すと Drive で開きます）";
    if (final!.driveStatus === "failed") {
      // ★ 「失われた」と読ませない。画像は Supabase 側に残っている（仕様書 4.7.2）。
      return "確定済み。Drive へは未同期です（画像は保存されています。あとから自動で再送します）";
    }
    return "確定済み";
  }
  if (final?.status === "succeeded") {
    return `別の候補（候補${final.sourceSlot + 1}）が確定済みです。この回の確定は 1 枚だけです`;
  }
  const price = session?.finalUnitUsd;
  const resolution = session?.finalResolution?.toUpperCase() ?? "2K";
  return price === undefined
    ? `この 1 枚を ${resolution} で作り直して確定する`
    : `この 1 枚を ${resolution} で作り直して確定する（実費の見込み 約 $${price.toFixed(2)}）`;
}

/** 参考画像の上限（仕様書 4.2.5 の初期値。サーバー側 REFERENCE_LIMIT と同じ）。 */
const REF_PER_CATEGORY = 2;
const REF_PER_SESSION = 6;

/** File のサムネイル。object URL を描画のたびに作らず、外れたら解放する。 */
function FileThumb({ file, alt }: { file: File; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt={alt} /> : null;
}

const CHAT_INTRO: ChatMessage = {
  role: "assistant",
  text: "キャストの本人性を固定しています。4枚のドラフト候補から1枚を選び、「衣装を明るい赤のシルクに変更して」「背景のライトをもう少し落として」等の自然言語指示でピンポイント修正が可能です（直前に選択した画像を入力とした逐次編集）。反復による画質劣化を避けるため、5回を超える連続編集では原本からの再編集をおすすめします。",
};

/** 実際の段階名（DB・PoC と同じ）。古いセッション（強まで作っていた頃）の表示に使う。 */
const STRENGTH_LABEL: Record<MakeupStrength, string> = {
  weak: "弱",
  medium: "中",
  strong: "強",
};

/**
 * 画面での呼び名（委託者指示・2026-09-16）。
 *
 * 生成するのは弱・中の 2 段階だが、画面では「中」を「強」と呼ぶ。
 * プロンプトも DB の記録も変えていない。変えたのは呼び名だけ。
 *
 * ★ 「強」まで作っていた頃のセッションを履歴から開いたときは、実際の段階名で出す。
 *   そうしないと中と強の両方に「強」が付いて見分けられなくなる。
 */
function strengthLabel(strength: MakeupStrength, slots: Slot[]): string {
  const legacy = slots.some((s) => s.makeupStrength === "strong");
  if (legacy) return STRENGTH_LABEL[strength];
  return strength === "medium" ? "強" : STRENGTH_LABEL[strength];
}

/** 店舗・キャストの台帳（/api/masters）。管理画面から編集できる。 */
type Masters = {
  stores: { id: string; name: string }[];
  casts: { id: string; storeId: string; name: string; joinedYm: string | null; label: string }[];
};

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

  // ── モード（通常加工 / 除去専用） ──
  //
  // ★ 確定 UI では除去は STEP 2 のカードの 1 つだったが、コーナーとして独立させた。
  //   マスクを入力できるのは OpenAI だけで Google へフォールバックできず、
  //   通常加工と同じ導線に置くと「他と同じように動くはず」という誤解を生むため。
  const [mode, setMode] = useState<"normal" | "removal">("normal");

  // ── STEP 0 ──
  const [storeName, setStoreName] = useState("");
  const [castName, setCastName] = useState("");
  const [masters, setMasters] = useState<Masters>({ stores: [], casts: [] });
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
  // 参考画像（種別 B・仕様書 4.2.5）。各カテゴリ 2 枚・合計 6 枚まで。
  const [refFiles, setRefFiles] = useState<Partial<Record<CategoryId, File[]>>>({});
  const [refDragOver, setRefDragOver] = useState<CategoryId | null>(null);
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
  const [chat, setChat] = useState<ChatMessage[]>([CHAT_INTRO]);
  const [chatInput, setChatInput] = useState("");
  // 個別修正（F-05）。送信中は二重送信しない。
  const [edits, setEdits] = useState<EditStep[]>([]);
  const [editing, setEditing] = useState(false);
  // 修正結果の拡大表示（候補の拡大とは別に持つ）
  const [zoomImage, setZoomImage] = useState<{ url: string; label: string } | null>(null);
  const [chatExpanded, setChatExpanded] = useState(false);
  /** 拡大表示しているスロット番号。null なら閉じている。 */
  const [zoomSlot, setZoomSlot] = useState<number | null>(null);

  // 確定処理（高解像度の再生成 → Drive 保存）。二度押しでの二重課金を防ぐ。
  const [confirming, setConfirming] = useState(false);
  const [finalImage, setFinalImage] = useState<FinalImage | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  // 履歴から開いたときだけ、次のポーリング結果で STEP 0〜2 の入力と元画像を戻す（F-07）。
  // 生成直後のポーリングでは戻さない（入力欄はもう埋まっている）。
  const restoreRef = useRef(false);

  // 除去コーナーでは常にマスクが要る。通常加工では除去カードを出さない。
  const removalOn = mode === "removal";
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

  const reloadMasters = useCallback(async () => {
    const response = await fetch("/api/masters", { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (response.ok && data?.ok) setMasters({ stores: data.stores ?? [], casts: data.casts ?? [] });
  }, []);

  useEffect(() => {
    void reloadMasters();
  }, [reloadMasters]);

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

  // ── 修正履歴をチャットへ映す（ページを開き直しても履歴が見えるように） ──
  useEffect(() => {
    if (edits.length === 0) return;
    setChat((current) => {
      const known = new Set(current.map((m) => m.stepId).filter(Boolean));
      const missing = edits.filter((step) => !known.has(step.id));
      if (missing.length === 0) return current;
      const appended: ChatMessage[] = [];
      for (const step of missing) {
        appended.push({ role: "user", text: step.instruction, stepId: `${step.id}:u` });
        appended.push(
          step.status === "succeeded"
            ? {
                role: "assistant",
                stepId: step.id,
                image: step.url,
                text: `修正 ${step.stepNo} 回目${step.provider ? `（${PROVIDER_LABEL_SHORT[step.provider]}）` : ""}`,
              }
            : {
                role: "warn",
                stepId: step.id,
                text: `修正 ${step.stepNo} 回目は失敗しました${step.errorKind === "policy" ? "（内容の判定により拒否）" : ""}。`,
              },
        );
      }
      return [...current, ...appended];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits]);

  // ── ジョブのポーリング（できたスロットから埋まる） ──
  useEffect(() => {
    if (!jobId) return;
    let stop = false;

    async function tick() {
      const response = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (stop || !response.ok || !data?.ok) return;

      setSlots(data.slots as Slot[]);
      setFinalImage((data.final ?? null) as FinalImage | null);
      setEdits((data.edits ?? []) as EditStep[]);

      if (restoreRef.current) {
        restoreRef.current = false;
        await restoreInputs(data.job as RestorableJob);
      }

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

  /**
   * 履歴から開いたセッションの入力を戻す（仕様書 F-07）。
   *
   * 結果（候補・修正・確定）はポーリングで戻るが、STEP 0〜2 の入力と元画像は
   * jobs に記録した値から組み直す。元画像は署名付き URL から取り直して File にする
   * （「同じ条件でもう 1 回」を押せるようにするため。プレビューだけでは生成できない）。
   *
   * ★ 除去のマスクは戻さない。マスクは筆で描いた画像で、描画ツールへ読み戻す口が無い。
   *   除去のセッションを開き直して再生成するには、マスクを描き直す必要がある。
   */
  async function restoreInputs(job: RestorableJob) {
    // モードは switchMode を通さない（あれは作りかけの結果を捨てる）
    setMode(job.jobMode);
    setStoreName(job.storeName ?? "");
    setCastName(job.castName ?? "");
    setManualTitle(job.sessionTitle ?? null);

    const nextEnabled: Partial<Record<CategoryId, boolean>> = {};
    for (const id of job.categoryIds) nextEnabled[id as CategoryId] = true;
    setEnabled(nextEnabled);
    setTemplateIds(job.templateIds as Partial<Record<CategoryId, string>>);
    setFreeTexts(job.freeTexts as Partial<Record<CategoryId, string>>);

    if (job.sourceUrl) {
      try {
        const blob = await fetch(job.sourceUrl).then((r) => (r.ok ? r.blob() : null));
        if (blob) setFile(new File([blob], "source.png", { type: blob.type || "image/png" }));
      } catch {
        // 取れなくても結果の閲覧はできる。再生成だけができない
      }
    }

    // 参考画像も File に戻す（「同じ条件でもう 1 回」を成立させるため）
    const restored: Partial<Record<CategoryId, File[]>> = {};
    for (const [categoryId, urls] of Object.entries(job.referenceUrls ?? {})) {
      const files: File[] = [];
      for (const [index, url] of urls.entries()) {
        try {
          const blob = await fetch(url).then((r) => (r.ok ? r.blob() : null));
          if (blob) files.push(new File([blob], `ref-${index + 1}.png`, { type: blob.type || "image/png" }));
        } catch {
          /* 1 枚取れなくても他は戻す */
        }
      }
      if (files.length > 0) restored[categoryId as CategoryId] = files;
    }
    setRefFiles(restored);
  }

  /** 参考画像を足す（各カテゴリ 2 枚・合計 6 枚まで。超えたぶんは捨てて知らせる）。 */
  function addReferences(categoryId: CategoryId, incoming: File[]) {
    const images = incoming.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    setRefFiles((current) => {
      const total = Object.values(current).reduce((n, list) => n + (list?.length ?? 0), 0);
      const mine = current[categoryId] ?? [];
      const roomHere = Math.max(0, REF_PER_CATEGORY - mine.length);
      const roomAll = Math.max(0, REF_PER_SESSION - total);
      const accepted = images.slice(0, Math.min(roomHere, roomAll));
      if (accepted.length < images.length) {
        setGateMessage(
          `参考画像は各カテゴリ ${REF_PER_CATEGORY} 枚・合計 ${REF_PER_SESSION} 枚までです。超えたぶんは追加していません。`,
        );
      }
      return accepted.length === 0 ? current : { ...current, [categoryId]: [...mine, ...accepted] };
    });
  }

  function removeReference(categoryId: CategoryId, index: number) {
    setRefFiles((current) => {
      const next = (current[categoryId] ?? []).filter((_, i) => i !== index);
      return { ...current, [categoryId]: next };
    });
  }

  /** 履歴のセッションを開く。 */
  function openHistory(id: string) {
    if (jobRunning || id === jobId) return;
    restoreRef.current = true;
    setChat([CHAT_INTRO]);
    setEdits([]);
    setFinalImage(null);
    setSelectedSlot(null);
    setGateMessage(null);
    setModerationWarning(null);
    setJobId(id);
  }

  /** タイトルを保存する（仕様書 F-07 / F-09「リネーム可」）。作成前は生成時に送るだけ。 */
  async function commitTitle() {
    if (!jobId || manualTitle === null) return;
    const response = await fetch(`/api/jobs/${jobId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionTitle: manualTitle }),
    });
    if (response.ok) void reloadSession();
  }

  /** モードを切り替える。作りかけの結果を持ち越さない。 */
  function switchMode(next: "normal" | "removal") {
    if (next === mode || jobRunning) return;
    setMode(next);
    setJobId(null);
    setSlots([]);
    setFinalImage(null);
    setEdits([]);
    setSelectedSlot(null);
    setGateMessage(null);
    setModerationWarning(null);
    setMaskStrokes(0);
    maskRef.current?.clear();
  }

  const removalCategory = catalog.categories.find((c) => c.id === "tattoo_removal");

  /**
   * タトゥー・不要物除去のコーナー。
   *
   * ★ 確定 UI では STEP 2 のカードの 1 つだったが、独立させた理由：
   *   マスク画像を入力できるのは OpenAI だけで、Google へフォールバックできない。
   *   通常加工と同じ導線に置くと「他と同じように動くはず」という誤解を生む。
   *   さらに PoC の実測（2026-08-16）では、その OpenAI が素材を全件拒否している。
   */
  //
  // ★ ここを function RemovalPanel() { ... } として定義してはならない。
  //   AppShell が再描画されるたびに別の関数になり、React が
  //   「別のコンポーネント」と判断して中身を作り直す。
  //   その結果 MaskTool が再マウントされ、塗ったマスクが毎回消える。
  //   JSX の値として持つことで、同一要素として扱われる。
  const removalPanel = !removalCategory ? null : (
      <div className="card enabled" data-category="タトゥー・不要物除去">
        <div className="card-title">
          <span
            className="cat-letter"
            style={{
              background: "rgba(245,158,11,0.1)",
              color: "var(--type-c)",
              borderColor: "rgba(245,158,11,0.22)",
            }}
          >
            除
          </span>{" "}
          タトゥー・不要物除去
          <span className="type-badge type-c">種別C マスク局所修復</span>
          <span className="required-tag">OpenAI 専用</span>
        </div>

        <div className="card-body">
          <div className="card-grid-fields">
            <div
              className="make-notice"
              style={{
                background: "linear-gradient(135deg, rgba(245,158,11,0.06), rgba(244,63,94,0.05))",
                borderColor: "rgba(245,158,11,0.2)",
              }}
            >
              <i className="fa-solid fa-eraser" style={{ color: "var(--type-c)" }} />
              <div>
                参考画像は使用せず、<strong>元画像上でブラシを塗って除去範囲（マスク）を指定</strong>
                してください。マスク領域のみをインペインティング修復し、
                <strong>マスク外は一切変更しません</strong>（F-15）。
                メイクなど他の加工は行いません（1 回につき 1 枚）。
              </div>
            </div>

            <div className="gate-note">
              <i className="fa-solid fa-triangle-exclamation" />
              <span>
                まず <strong>OpenAI</strong> がマスク画像を使って修復します（マスク外は変更されません）。
                拒否された場合は <strong>Google（Gemini）</strong> へ回しますが、Gemini
                はマスク画像を受け取れないため、
                <strong>範囲を目印と文章で伝える別方式</strong>になります。
                こちらは<strong>マスク外が変わらない保証がありません</strong>。
                結果には「マスク指定」「範囲を説明」のどちらで作られたかが表示されます。
              </span>
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

            <div className="input-group">
              <label>除去対象の種類</label>
              <select
                className="tpl-select"
                value={templateIds.tattoo_removal ?? ""}
                onChange={(e) =>
                  setTemplateIds((c) => ({ ...c, tattoo_removal: e.target.value }))
                }
              >
                <option value="">選択してください（未選択）</option>
                {removalCategory.templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.labelJa}
                  </option>
                ))}
              </select>
              {templateIds.tattoo_removal && (
                <div className="setting-note" style={{ marginTop: 6 }}>
                  <i className="fa-solid fa-circle-info" />{" "}
                  {
                    removalCategory.templates.find((t) => t.id === templateIds.tattoo_removal)
                      ?.noteJa
                  }
                </div>
              )}
            </div>

            <div className="input-group">
              <label>
                補足メモ<span className="recommend-tag">任意</span>
              </label>
              <input
                type="text"
                className="free-text"
                maxLength={200}
                placeholder={removalCategory.freeTextPlaceholder}
                value={freeTexts.tattoo_removal ?? ""}
                onChange={(e) =>
                  setFreeTexts((c) => ({ ...c, tattoo_removal: e.target.value }))
                }
              />
            </div>
          </div>
        </div>
      </div>
  );

  /**
   * 拡大表示を開く。
   *
   * ★ 履歴を 1 つ積む。こうしないと Android の戻るボタンや
   *   ブラウザの戻るでアプリごと離脱してしまう。
   *   「戻れない」がこの機能を足した直接の理由なので、
   *   閉じる手段は多いほうがよい（× ／ 背景タップ ／ Esc ／ 端末の戻る）。
   */
  function openZoom(slot: number) {
    setZoomSlot(slot);
    setSelectedSlot(slot);
    try {
      history.pushState({ zoom: slot }, "");
    } catch {
      // 履歴が使えない環境でも拡大表示自体は動かす
    }
  }

  function closeZoom() {
    setZoomSlot(null);
  }

  // Esc と端末の戻るで閉じる
  useEffect(() => {
    if (zoomSlot === null && zoomImage === null) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        history.back();
      }
    };
    const onPop = () => {
      setZoomSlot(null);
      setZoomImage(null);
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onPop);
    // 背後の画面がスクロールしないようにする
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onPop);
      document.body.style.overflow = previousOverflow;
    };
  }, [zoomSlot, zoomImage]);

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

    // OpenAI が拒否して Google が引き受けた枚数（フォールバックの実績）
    const fellBack = finished.filter(
      (s) => s.status === "succeeded" && s.attemptedProvider !== null,
    ).length;

    let text =
      mode === "removal"
        ? (() => {
            const semantic = finished.filter(
              (s) => s.status === "succeeded" && s.editMethod === "semantic_mask",
            ).length;
            const base = `除去を ${finished.length} 枚実行しました。成功 ${ok} 枚。`;
            return semantic > 0
              ? base +
                  `うち ${semantic} 枚は OpenAI が受け付けなかったため、Google（Gemini）で範囲を目印と文章で伝える方式で作っています。` +
                  `この方式ではマスク外が変わらない保証がないので、元画像と見比べてください。`
              : base + "マスク領域のみを修復し、マスク外は変更していません。";
          })()
        : `${
            // 枚数は設定（images_per_job）で変わる。4 枚のときだけ「各2枚」と言う。
            finished.length === 4 ? "メイク強度「弱・強」各2枚、計4枚" : `計${finished.length}枚`
          }のドラフト候補（1K）を生成しました。成功 ${ok} 枚。反映レイヤー：${activeCats.join("・")}。${removal}`;

    if (fellBack > 0) {
      // 「拒否」と「障害」は分けて言う。障害を拒否と書くと、
      // 素材のせいで弾かれたのか、こちらの不調だったのかが読めなくなる。
      const byPolicy = finished.filter(
        (s) => s.status === "succeeded" && s.attemptedErrorKind === "policy",
      ).length;
      const reason =
        byPolicy === fellBack
          ? "拒否されたため"
          : byPolicy === 0
            ? "エラーになったため"
            : `拒否・エラーになったため（うち拒否 ${byPolicy} 枚）`;
      text += ` うち ${fellBack} 枚は ${PROVIDER_LABEL_SHORT[finished.find((s) => s.attemptedProvider)!.attemptedProvider!]}で${reason}、${PROVIDER_LABEL_SHORT[finished.find((s) => s.attemptedProvider)!.provider ?? "google"]}で生成しています。`;
    }
    if (policy > 0) {
      text +=
        mode === "removal"
          ? ` ${policy} 枚は安全性判定により拒否されました。除去はマスクを入力できる OpenAI 専用のため、Google へ回すことができません。`
          : ` ${policy} 枚は安全性判定により拒否されました。文言を変えた再投入は行いません（拒否は記録に残ります）。`;
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
    // 有効にしたカードは、テンプレート・参考画像・自由記述のどれか 1 つが要る（メイク以外）
    if (mode === "normal") {
      const empty = catalog.categories.find(
        (c) =>
          c.id !== "makeup" &&
          c.id !== "tattoo_removal" &&
          enabled[c.id] &&
          !templateIds[c.id] &&
          !(freeTexts[c.id] ?? "").trim() &&
          (refFiles[c.id] ?? []).length === 0,
      );
      if (empty) {
        setGateMessage(
          `STEP 2「${empty.titleJa}」が有効ですが中身がありません。テンプレート・参考画像・自由記述のどれか 1 つを入れるか、カードを無効にしてください。`,
        );
        return;
      }
    }
    if (removalOn && maskStrokes === 0) {
      setGateMessage("マスクが未指定です。元画像上で除去したい範囲をブラシで塗ってください。");
      return;
    }
    if (removalOn && !templateIds.tattoo_removal) {
      setGateMessage("除去対象の種類を選んでください。");
      return;
    }
    if (!rights) {
      setGateMessage("「本人の同意を得た写真である」にチェックしてください。");
      return;
    }

    setRegistering(true);
    setSelectedSlot(null);
    setSlots([]);
    setFinalImage(null);
    setEdits([]);

    const form = new FormData();
    form.set("source", file);
    form.set("rightsConfirmed", "true");
    form.set("storeName", storeName.trim());
    form.set("castName", castName.trim());
    form.set("sessionTitle", sessionTitle);

    form.set("jobMode", mode);

    // 除去コーナーではメイクを送らない。
    // inpaint はマスク領域の中身を作り直す処理なので、
    // 「メイクを変えろ」を混ぜると指示が破綻する。
    const selections =
      mode === "removal"
        ? [
            {
              categoryId: "tattoo_removal",
              templateId: templateIds.tattoo_removal ?? "",
              freeText: freeTexts.tattoo_removal ?? "",
            },
          ]
        : catalog.categories
            .filter((c) => c.id !== "tattoo_removal" && (c.id === "makeup" || enabled[c.id]))
            .map((c) => ({
              categoryId: c.id,
              templateId: templateIds[c.id] ?? "",
              freeText: freeTexts[c.id] ?? "",
            }));

    form.set(
      "selection",
      JSON.stringify({ selections, removalType: templateIds.tattoo_removal ?? null }),
    );

    // 参考画像（種別 B）。有効なカテゴリのぶんだけ送る（無効カテゴリの参考画像は送らない：仕様書 2.2.1）
    if (mode === "normal") {
      for (const category of catalog.categories) {
        if (!category.acceptsReferences || !enabled[category.id]) continue;
        for (const ref of refFiles[category.id] ?? []) form.append(`ref:${category.id}`, ref);
      }
    }

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
    // 履歴から開いたセッションのタイトルを、新しいセッションへ持ち越さない
    setManualTitle(null);
    setChat([CHAT_INTRO]);
    setEnabled({});
    setTemplateIds({});
    setFreeTexts({});
    setRefFiles({});
    setMaskStrokes(0);
    setRights(false);
    setJobId(null);
    setSlots([]);
    setFinalImage(null);
    setEdits([]);
    setSelectedSlot(null);
    setManualTitle(null);
    setSessionRuns(0);
    setGateMessage(null);
    setModerationWarning(null);
  }

  /** キャストの新規登録（F-14）。台帳（casts）へ入れ、そのまま選択する。 */
  async function registerNewCast() {
    const name = newCastName.trim();
    if (!name) {
      setGateMessage("キャスト名を入力してください。");
      return;
    }
    if (!storeName.trim()) {
      setGateMessage("先に店舗名を入力してください。キャストは店舗に紐づけて登録します。");
      return;
    }
    const response = await fetch("/api/casts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ storeName: storeName.trim(), name, joinedYm: newCastYm }),
    });
    const data = (await response.json().catch(() => null)) as
      | { ok?: boolean; message?: string; cast?: { label: string } }
      | null;
    if (!response.ok || !data?.ok || !data.cast) {
      setGateMessage(data?.message ?? "キャストを登録できませんでした。");
      return;
    }
    await reloadMasters();
    setCastName(data.cast.label);
    setNewCastName("");
    setNewCastYm("");
    setShowCastRegister(false);
    setGateMessage(null);
  }

  /**
   * 個別修正（仕様書 F-05 逐次編集）。
   *
   * 次の指示を「何に」適用するかは、選んでいる候補で決まる：
   *   - 直前の修正と同じ候補を選んだまま → 直前の修正結果に重ねる（逐次）
   *   - 別の候補を選んだ            → その候補（原本）から系統をやり直す
   * 5 回を超えると劣化が蓄積するので、サーバーが警告を返す（止めはしない）。
   *
   * ★ 自由文をそのまま送る（委託者判断・2026-09-16）。指示の全文はサーバーで記録される。
   */
  async function sendChatMessage() {
    const text = chatInput.trim();
    if (!text || editing || !jobId) return;
    if (selectedSlot === null) {
      pushChat("warn", "先に修正対象の候補画像を 1 枚選択してください（逐次編集は選択画像を入力とします）。");
      return;
    }

    const base = editBase();
    const fromDraftSlot = base.kind === "draft" ? base.slot : null;

    pushChat("user", text);
    setChatInput("");
    setEditing(true);
    pushChat(
      "assistant",
      base.kind === "draft"
        ? `候補${base.slot + 1}の原本に適用しています…`
        : `修正 ${base.stepNo} 回目の結果に重ねて適用しています…`,
    );

    try {
      const response = await fetch(`/api/jobs/${jobId}/edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction: text, fromDraftSlot }),
      });
      const data = (await response.json().catch(() => null)) as {
        ok?: boolean;
        message?: string;
        stepId?: string;
        stepNo?: number;
        chainLength?: number;
        warning?: string | null;
        provider?: "openai" | "google";
        costUsd?: number;
        latencyMs?: number;
        url?: string | null;
      } | null;

      if (!data) {
        pushChat("warn", "修正の結果を読み取れませんでした。");
        return;
      }
      if (!data.ok) {
        pushChat("warn", data.message ?? "修正できませんでした。");
        return;
      }

      setChat((current) => [
        ...current,
        {
          role: "assistant",
          stepId: data.stepId,
          image: data.url ?? null,
          text:
            `修正 ${data.stepNo} 回目ができました` +
            (data.provider ? `（${PROVIDER_LABEL_SHORT[data.provider]}` : "（") +
            (data.costUsd !== undefined ? `・$${data.costUsd.toFixed(3)}` : "") +
            (data.latencyMs !== undefined ? `・${(data.latencyMs / 1000).toFixed(1)} 秒` : "") +
            "）。タップで拡大。続けて指示すると、この結果に重ねて適用します。",
        },
      ]);
      if (data.warning) pushChat("warn", data.warning);

      await refreshJob();
      void reloadSession();
    } catch (error) {
      pushChat("warn", `修正を依頼できませんでした: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setEditing(false);
    }
  }

  /** 現在の系統の根＝最後に「候補から」始めた修正の候補番号。 */
  function chainRootSlot(): number | null {
    for (let i = edits.length - 1; i >= 0; i -= 1) {
      const step = edits[i]!;
      if (step.sourceKind === "draft") return step.sourceSlot;
    }
    return null;
  }

  /** 次の指示（または確定）が対象にする画像。 */
  function editBase():
    | { kind: "draft"; slot: number }
    | { kind: "step"; stepId: string; stepNo: number; url: string | null } {
    const last = [...edits].reverse().find((step) => step.status === "succeeded");
    if (last && selectedSlot !== null && selectedSlot === chainRootSlot()) {
      return { kind: "step", stepId: last.id, stepNo: last.stepNo, url: last.url };
    }
    return { kind: "draft", slot: selectedSlot ?? 0 };
  }

  function openZoomImage(url: string, label: string) {
    setZoomImage({ url, label });
    try {
      history.pushState({ zoomImage: true }, "");
    } catch {
      /* 履歴が使えなくても拡大表示自体は動かす */
    }
  }

  function saveImage(slot: Slot) {
    if (!slot.url || !jobId) return;

    // ★ 署名付き URL を <a download> に入れてはいけない。
    //   download 属性はクロスオリジンの URL では無視される仕様で、
    //   署名付き URL は Supabase（別オリジン）を指すため、
    //   ブラウザはダウンロードせず「その URL へ遷移」してしまう。
    //   画面いっぱいに画像が出てアプリへ戻れなくなる（実際にそうなった）。
    //
    //   同一オリジンの API ルートが Content-Disposition: attachment を付けて返すので、
    //   そちらへ遷移させる。iOS Safari を含めて確実にダウンロードになる。
    window.location.href = `/api/jobs/${jobId}/download?slot=${slot.slot}`;

    pushChat(
      "assistant",
      `候補${slot.slot + 1}（1K のドラフト）をダウンロードしました。高解像度の確定画像が必要な場合は「確定」を押してください。`,
    );
  }

  /**
   * 確定処理（仕様書 STEP 5）。
   *   ① 選んだ 1 枚を高解像度で作り直す
   *   ② 共有ドライブへ保存する
   *   ③ 使用モデル・推定コスト・処理時間を記録する
   *
   * ★ 実費が発生する操作なので、押す前に金額を見せて確認を取る。
   * ★ Drive への保存だけが失敗しても、確定そのものは成功として扱う。
   *   画像は Supabase 側に残っており、未同期として後から再送される（仕様書 4.7.2）。
   */
  async function confirmSelection(slot: Slot) {
    // 修正を経た系統の候補を確定するなら、最後の修正結果が「選んだ 1 枚」（仕様書 STEP 4 → STEP 5）
    const base =
      slot.slot === chainRootSlot()
        ? [...edits].reverse().find((step) => step.status === "succeeded") ?? null
        : null;
    await runConfirm({
      slot: slot.slot,
      stepId: base?.id ?? null,
      label: base
        ? `候補${slot.slot + 1}の修正 ${base.stepNo} 回目の結果`
        : `候補${slot.slot + 1}`,
    });
  }

  /** 修正結果そのものを確定する（チャットのボタンから）。 */
  async function confirmEdit(step: EditStep) {
    await runConfirm({
      slot: rootSlotOf(step),
      stepId: step.id,
      label: `修正 ${step.stepNo} 回目の結果`,
    });
  }

  /** その修正が、どの候補から始まった系統か。 */
  function rootSlotOf(step: EditStep): number {
    const index = edits.findIndex((s) => s.id === step.id);
    for (let i = index; i >= 0; i -= 1) {
      const s = edits[i]!;
      if (s.sourceKind === "draft" && s.sourceSlot !== null) return s.sourceSlot;
    }
    return selectedSlot ?? 0;
  }

  /** この対象が、いま確定されているものと同じか。 */
  function isCurrentFinal(target: { slot: number; stepId: string | null }): boolean {
    if (finalImage?.status !== "succeeded") return false;
    if (target.stepId) return finalImage.sourceStepId === target.stepId;
    return finalImage.sourceStepId === null && finalImage.sourceSlot === target.slot;
  }

  /**
   * 確定処理（仕様書 STEP 5）。
   *   ① 対象を高解像度で作り直す ② 共有ドライブへ保存 ③ 記録
   *
   * ★ 実費が発生する操作なので、押す前に金額を見せて確認を取る。
   * ★ 既に別の画像で確定済みなら「置き換え」になる。1 セッションにつき確定は 1 枚。
   *   古い確定画像は Drive ではゴミ箱へ入り、実費はもう 1 回かかる。これも確認を取る。
   * ★ Drive への保存だけが失敗しても、確定そのものは成功として扱う（仕様書 4.7.2）。
   */
  async function runConfirm(target: { slot: number; stepId: string | null; label: string }) {
    if (!jobId || confirming) return;

    // 同じものが確定済みなら、もう一度作らずに Drive を開く（二重課金と重複ファイルを避ける）
    if (isCurrentFinal(target)) {
      if (finalImage?.driveViewUrl) window.open(finalImage.driveViewUrl, "_blank", "noopener,noreferrer");
      else pushChat("assistant", "この画像は確定済みです。");
      return;
    }

    const replacing = finalImage?.status === "succeeded";
    const price = session?.finalUnitUsd ?? null;
    const yen = price === null ? null : Math.round(price * 150).toLocaleString("ja-JP");
    const ok = window.confirm(
      `${target.label}を確定します。\n\n` +
        (replacing
          ? "★ この回は既に確定済みです。今の確定画像を置き換えます（Drive の古いほうはゴミ箱へ入ります）。\n\n"
          : "") +
        `${session?.finalResolution?.toUpperCase() ?? "2K"} で作り直してから Drive へ保存します。` +
        (price === null ? "" : `\n実費の見込み：約 $${price.toFixed(2)}（約${yen}円）`) +
        "\n\n★ 引き伸ばしではなく作り直しのため、元の絵と完全に同じにはなりません。",
    );
    if (!ok) return;

    setConfirming(true);
    pushChat("assistant", `${target.label}の確定処理を始めました。高解像度で作り直しています…`);

    try {
      const response = await fetch(`/api/jobs/${jobId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot: target.slot, stepId: target.stepId, replace: replacing }),
      });
      const data = (await response.json().catch(() => null)) as {
        ok?: boolean;
        message?: string;
        reason?: string;
        drive?: { ok: boolean; viewUrl: string | null } | null;
      } | null;

      if (!data) {
        pushChat("warn", "確定処理の結果を読み取れませんでした。");
        return;
      }
      if (!data.ok) {
        pushChat("warn", data.message ?? "確定できませんでした。");
        return;
      }

      pushChat("assistant", data.message ?? "確定しました。");
      // 記録は DB を正とする。作り直した画像・Drive の状態はポーリングで取り直す。
      await refreshJob();
      void reloadSession();
    } catch (error) {
      pushChat(
        "warn",
        `確定処理を依頼できませんでした: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setConfirming(false);
    }
  }

  /** 修正結果・確定画像のダウンロード（候補と同じく、同一オリジンの API を経由する）。 */
  function downloadEdit(step: EditStep) {
    if (!jobId) return;
    window.location.href = `/api/jobs/${jobId}/download?step=${step.id}`;
  }
  function downloadFinal() {
    if (!jobId) return;
    window.location.href = `/api/jobs/${jobId}/download?final=1`;
  }

  /** ジョブの状態を 1 回だけ取り直す（確定処理の後に使う）。 */
  async function refreshJob() {
    if (!jobId) return;
    const response = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) return;
    setSlots(data.slots as Slot[]);
    setFinalImage((data.final ?? null) as FinalImage | null);
    setEdits((data.edits ?? []) as EditStep[]);
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
                  onClick={() => openHistory(item.id)}
                >
                  <div className="h-title">
                    <i className="fa-regular fa-image" />{" "}
                    {item.title.length > 18 ? `${item.title.slice(0, 18)}…` : item.title}
                  </div>
                  <div className="h-meta">
                    {new Date(item.createdAt).toLocaleDateString("ja-JP")} ・{" "}
                    {item.modelName ?? "—"} ・ {item.imageCount} 枚
                    {item.costUsd > 0 && ` ・ $${item.costUsd.toFixed(2)}`}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="sidebar-bottom">
            {isAdmin && (
              <button className="nav-button" onClick={() => router.push("/admin")}>
                <i className="fa-solid fa-sliders" /> ⚙️ 管理者向けシステム設定
              </button>
            )}
            <button className="nav-button" onClick={() => window.open("/help", "_blank", "noopener")}>
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
                onBlur={() => void commitTitle()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur();
                }}
                title={jobId ? "タイトルを書き換えて Enter で保存" : "クリックしてタイトルを編集できます"}
                placeholder="セッションタイトルを入力"
              />
            </div>
          </div>

          {/* ── モード切替（確定 UI には無い。除去は経路が別なので分けている） ── */}
          <div className="mode-tabs">
            <button
              type="button"
              className={`mode-tab${mode === "normal" ? " active" : ""}`}
              onClick={() => switchMode("normal")}
            >
              <i className="fa-solid fa-wand-magic-sparkles" /> 通常加工（メイク・背景・衣装ほか）
            </button>
            <button
              type="button"
              className={`mode-tab removal${mode === "removal" ? " active" : ""}`}
              onClick={() => switchMode("removal")}
            >
              <i className="fa-solid fa-eraser" /> タトゥー・不要物除去
            </button>
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
                  {masters.stores.map((store) => (
                    <option key={store.id} value={store.name} />
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
                  {/* 店舗が選ばれていればその店舗のキャストだけ。未選択なら全員 */}
                  {masters.casts
                    .filter((cast) => {
                      const store = masters.stores.find((s) => s.name === storeName.trim());
                      return !store || cast.storeId === store.id;
                    })
                    .map((cast) => (
                      <option key={cast.id} value={cast.label} />
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
                  <button className="crb-btn primary" onClick={() => void registerNewCast()}>
                    登録して選択
                  </button>
                  <button className="crb-btn ghost" onClick={() => setShowCastRegister(false)}>
                    キャンセル
                  </button>
                </div>
                <div className="crb-note">
                  <i className="fa-solid fa-database" />{" "}
                  キャストの台帳に登録され、次回から候補に出ます。表示名は「名前_入店年月」で、Drive の保存先フォルダ名もこれになります。編集・削除は管理者向けシステム設定から行えます。
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
                {/* .preview-wrap は CSS で display:none。
                    モックでは JS が実行時に block を入れていたので、ここで指定する。 */}
                <div className="preview-wrap" style={{ display: "block" }}>
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
            <span className="step-num">STEP 2</span>{" "}
            {mode === "removal"
              ? "除去範囲の指定（マスク描画）"
              : "加工カテゴリ設定（メイク以外は有効／無効を選択）"}
          </div>

          {mode === "removal" && removalPanel}

          {mode === "normal" &&
            catalog.categories
            .filter((category) => category.id !== "tattoo_removal")
            .map((category) => {
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
                            「弱」「強」の各強度で2枚ずつ、合計4枚のドラフト候補（1K・低解像度）を出力
                          </strong>
                          します。生成後、右カラムの候補から気に入った1枚を選べます。
                          <div className="make-strength-chips">
                            {/* 画面上の呼び名は弱・強（実際に作るのは弱・中）。strengthLabel と同じ対応 */}
                            {["弱", "強"].map((label) => (
                              <span key={label} className="make-strength-chip">
                                {label} × 2枚
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}

                    {category.acceptsReferences && (
                      <div className="input-group full-width">
                        <label>
                          参考画像をアップロード
                          <span className="recommend-tag">
                            任意・{(refFiles[category.id] ?? []).length}/{REF_PER_CATEGORY} 枚
                          </span>
                        </label>
                        {(refFiles[category.id] ?? []).length > 0 && (
                          <div className="ref-thumbs">
                            {(refFiles[category.id] ?? []).map((ref, index) => (
                              <div key={`${ref.name}-${index}`} className="ref-thumb">
                                <FileThumb file={ref} alt={`参考画像 ${index + 1}`} />
                                <button
                                  type="button"
                                  className="ref-remove"
                                  title="外す"
                                  aria-label="この参考画像を外す"
                                  onClick={() => removeReference(category.id, index)}
                                >
                                  <i className="fa-solid fa-xmark" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                        {(refFiles[category.id] ?? []).length < REF_PER_CATEGORY && (
                          <label
                            className={`ref-drop${refDragOver === category.id ? " dragover" : ""}`}
                            onDragOver={(e) => {
                              e.preventDefault();
                              setRefDragOver(category.id);
                            }}
                            onDragLeave={() => setRefDragOver(null)}
                            onDrop={(e) => {
                              e.preventDefault();
                              setRefDragOver(null);
                              addReferences(category.id, Array.from(e.dataTransfer.files));
                            }}
                          >
                            <i className="fa-solid fa-image" />{" "}
                            見本にしたい{category.titleJa.replace(/設定|指定/g, "")}の写真を追加（各 {REF_PER_CATEGORY} 枚まで）
                            <input
                              type="file"
                              accept="image/*"
                              multiple
                              hidden
                              onChange={(e) => {
                                addReferences(category.id, Array.from(e.target.files ?? []));
                                e.target.value = "";
                              }}
                            />
                          </label>
                        )}
                        <div className="ref-note">
                          参考画像はそのまま生成 API へ送られます。<strong>テンプレートより参考画像が優先</strong>され、テンプレートは補助になります。
                          このカードを無効にすると送られません。
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
                        <option value="">
                          {category.acceptsReferences ? "選択しない（参考画像・自由記述だけでも可）" : "選択しない（自由記述だけでも可）"}
                        </option>
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
                  {jobRunning
                    ? "生成中…"
                    : mode === "removal"
                      ? "除去を実行（1枚）"
                      : "ドラフト4枚を生成（非同期ジョブ）"}
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
                    <i className="fa-regular fa-images" />{" "}
                    {mode === "removal" ? "除去結果（1枚）" : "生成候補（4枚 / 弱・強 各2枚）"}
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
                    : Array.from(
                        // 生成前の空枠。弱・強 × 各 2 枚 ＝ 4（除去は 1）
                        { length: mode === "removal" ? 1 : 4 },
                        () => null as Slot | null,
                      )
                  ).map((slot, index) => {
                    if (!slot) {
                      return (
                        <div className="result-item" key={`empty-${index}`}>
                          <div className="slot-state slot-waiting">
                            <i className="fa-regular fa-image" style={{ fontSize: "1.1rem", opacity: 0.5 }} />
                            画像未生成
                            <span className="slot-strength">
                              {mode === "removal"
                                ? "マスク領域の修復"
                                : `メイク ${["弱", "弱", "強", "強"][index]}`}
                            </span>
                          </div>
                        </div>
                      );
                    }

                    const label =
                      mode === "removal"
                        ? "マスク領域の修復"
                        : `${strengthLabel(slot.makeupStrength, slots)} - パターン${slot.variant === 1 ? "A" : "B"}`;

                    // どのプロバイダが作ったか（フォールバックした場合は経緯も）
                    const providerBadge = slot.provider ? (
                      <span className={`provider-badge ${slot.provider}`}>
                        {slot.provider === "openai" ? "OpenAI" : "Google"}
                      </span>
                    ) : null;
                    // 除去のとき、どちらの方式で作られたかを示す。
                    // inpaint は「マスク外は不変」が仕組みで担保されるが、
                    // semantic_mask にはその保証が無い。ここを黙っていると誤読される。
                    const methodBadge =
                      mode === "removal" && slot.editMethod ? (
                        <span
                          className={`provider-badge ${slot.editMethod === "inpaint" ? "openai" : "fallback"}`}
                          title={
                            slot.editMethod === "inpaint"
                              ? "マスク画像を API へ渡す方式。マスク外は変更されません"
                              : "目印つき画像と文章で範囲を伝える方式。マスク外が変わらない保証はありません"
                          }
                        >
                          {slot.editMethod === "inpaint" ? "マスク指定" : "範囲を説明"}
                        </span>
                      ) : null;

                    const fallbackBadge = slot.attemptedProvider ? (
                      <span className="provider-badge fallback" title="先に試して失敗したプロバイダ">
                        {slot.attemptedProvider === "openai" ? "OpenAI" : "Google"}
                        {slot.attemptedErrorKind === "policy" ? " 拒否" : " 失敗"} →
                      </span>
                    ) : null;

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
                            <span className="slot-providers">
                              {fallbackBadge}
                              {providerBadge}
                              {methodBadge}
                            </span>
                            {slot.errorKind === "policy" && (
                              <span className="slot-reason">
                                {mode === "removal"
                                  ? "マスク編集は OpenAI 専用のため、Google へ回せません"
                                  : "同じ内容を言い換えて再投入することはしません"}
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
                        <img
                          src={slot.url ?? ""}
                          alt={label}
                          title="タップで拡大"
                          onClick={(e) => {
                            e.stopPropagation();
                            openZoom(slot.slot);
                          }}
                        />
                        {/* ★ 2 段に分ける。1 段に詰めると狭い画面でラベルが 1 文字ずつ縦に折れ、
                            バッジがボタンに重なった（実際にそうなった）。
                            上段＝何の候補か（ラベル・プロバイダ）、下段＝操作ボタン。 */}
                        <div className="result-actions">
                          <div className="result-meta">
                            <span className="result-badge">{label}</span>
                            {fallbackBadge}
                            {providerBadge}
                            {methodBadge}
                          </div>
                          <div className="result-buttons">
                            <button
                              className="action-icon-btn"
                              title="拡大して見る"
                              aria-label="拡大して見る"
                              onClick={(e) => {
                                e.stopPropagation();
                                openZoom(slot.slot);
                              }}
                            >
                              <i className="fa-solid fa-magnifying-glass-plus" />
                              <span className="action-label">拡大</span>
                            </button>
                            <button
                              className="action-icon-btn"
                              title="ダウンロード"
                              aria-label="ダウンロード"
                              onClick={(e) => {
                                e.stopPropagation();
                                saveImage(slot);
                              }}
                            >
                              <i className="fa-solid fa-floppy-disk" />
                              <span className="action-label">保存</span>
                            </button>
                            {/* 確定（仕様書 STEP 5）：高解像度で作り直して Drive へ保存する。
                                実費がかかるので、押す前に金額を確認させる。 */}
                            <button
                              className={`action-icon-btn confirm${confirmClass(finalImage, slot.slot)}`}
                              title={confirmTitle(finalImage, slot.slot, session)}
                              aria-label="この 1 枚で確定"
                              disabled={confirming}
                              onClick={(e) => {
                                e.stopPropagation();
                                void confirmSelection(slot);
                              }}
                            >
                              {confirming ? (
                                <i className="fa-solid fa-spinner fa-spin" />
                              ) : isConfirmed(finalImage, slot.slot) ? (
                                <i className="fa-solid fa-circle-check" />
                              ) : (
                                <i className="fa-solid fa-star" />
                              )}
                              <span className="action-label">
                                {isConfirmed(finalImage, slot.slot) ? "確定済" : "確定"}
                              </span>
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* ── 確定画像（仕様書 STEP 5）── */}
            {finalImage && (
              <div className={`final-panel${finalImage.status === "failed" ? " failed" : ""}`}>
                <div className="final-head">
                  <i className="fa-solid fa-star" />
                  <span>
                    確定画像（候補{finalImage.sourceSlot + 1}を{" "}
                    {finalImage.resolution.toUpperCase()} で作り直したもの）
                  </span>
                </div>

                {finalImage.status === "failed" ? (
                  <div className="final-body">
                    <p className="final-error">
                      確定画像を作れませんでした
                      {finalImage.errorKind === "policy" && "（内容の判定により断られました）"}。
                      <br />
                      {finalImage.errorMessage}
                    </p>
                  </div>
                ) : finalImage.status !== "succeeded" ? (
                  <div className="final-body">
                    <p>高解像度で作り直しています…</p>
                  </div>
                ) : (
                  <div className="final-body">
                    {finalImage.url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={finalImage.url} alt="確定画像" className="final-thumb" />
                    )}
                    <div className="final-meta">
                      <div>
                        {finalImage.provider && PROVIDER_LABEL_SHORT[finalImage.provider]}
                        {finalImage.costUsd !== null &&
                          ` ／ 実費 $${finalImage.costUsd.toFixed(3)}`}
                        {finalImage.latencyMs !== null &&
                          ` ／ ${(finalImage.latencyMs / 1000).toFixed(1)} 秒`}
                      </div>

                      {/* ★ Drive 未同期を「失敗」と読ませない。
                          画像は Supabase 側に残っており、あとから自動で再送される（仕様書 4.7.2）。 */}
                      <div className="final-drive">
                        <button type="button" className="chat-mini-btn" onClick={downloadFinal}>
                          <i className="fa-solid fa-floppy-disk" /> {finalImage.resolution.toUpperCase()} をダウンロード
                        </button>
                      </div>
                      <div className="final-drive">
                        {!session?.driveEnabled ? (
                          <span className="final-drive-off">
                            Drive 保存は管理者設定でオフです
                          </span>
                        ) : finalImage.driveStatus === "synced" && finalImage.driveViewUrl ? (
                          <a
                            href={finalImage.driveViewUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="final-drive-link"
                          >
                            <i className="fa-brands fa-google-drive" /> Drive に保存済み（開く）
                          </a>
                        ) : finalImage.driveStatus === "failed" ? (
                          <span className="final-drive-pending">
                            Drive 未同期（画像は保存されています。あとから自動で再送します）
                          </span>
                        ) : (
                          <span className="final-drive-pending">Drive へ送信中…</span>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

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
                    key={message.stepId ?? index}
                    className={`msg ${message.role === "warn" ? "system-warn" : message.role}`}
                  >
                    {message.role === "warn" && <i className="fa-solid fa-triangle-exclamation" />}{" "}
                    {message.text}
                    {message.image && (
                      <div className="chat-result">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={message.image}
                          alt="修正結果"
                          className="chat-thumb"
                          onClick={() => openZoomImage(message.image!, "修正結果")}
                        />
                        {(() => {
                          const step = edits.find((s) => s.id === message.stepId);
                          if (!step || step.status !== "succeeded") return null;
                          const confirmed = isCurrentFinal({ slot: rootSlotOf(step), stepId: step.id });
                          return (
                            <div className="chat-result-actions">
                              <button type="button" className="chat-mini-btn" onClick={() => downloadEdit(step)}>
                                <i className="fa-solid fa-floppy-disk" /> ダウンロード
                              </button>
                              <button
                                type="button"
                                className={`chat-mini-btn confirm${confirmed ? " done" : ""}`}
                                disabled={confirming}
                                onClick={() => void confirmEdit(step)}
                              >
                                <i className={confirmed ? "fa-solid fa-circle-check" : "fa-solid fa-star"} />{" "}
                                {confirmed ? "確定済み" : "この結果で確定"}
                              </button>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {/* 次の指示が何に適用されるかを、送る前に見せる（逐次か原本からか） */}
              {jobId && selectedSlot !== null && slots.some((s) => s.status === "succeeded") && (
                <div className="chat-base-hint">
                  {(() => {
                    const base = editBase();
                    return base.kind === "step"
                      ? `次の指示は「修正 ${base.stepNo} 回目の結果」に重ねて適用します。別の候補を選ぶと、その候補の原本からやり直せます。`
                      : `次の指示は「候補${base.slot + 1}の原本」に適用します。`;
                  })()}
                </div>
              )}
              <div className="chat-input-area">
                <input
                  type="text"
                  placeholder="選択中の候補への部分修正指示を入力..."
                  value={chatInput}
                  disabled={editing}
                  maxLength={300}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) void sendChatMessage();
                  }}
                />
                <button onClick={() => void sendChatMessage()} disabled={editing}>
                  {editing ? "生成中…" : "送信"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>


      {/* ── 修正結果の拡大表示 ── */}
      {zoomImage && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`${zoomImage.label} の拡大表示`}
          onClick={() => history.back()}
        >
          <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
            <span className="lightbox-title">{zoomImage.label}</span>
            <button
              className="lightbox-btn close"
              onClick={(e) => {
                e.stopPropagation();
                history.back();
              }}
              aria-label="閉じる"
              title="閉じる"
            >
              <i className="fa-solid fa-xmark" /> 閉じる
            </button>
          </div>
          <div className="lightbox-body">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={zoomImage.url} alt={zoomImage.label} onClick={(e) => e.stopPropagation()} />
          </div>
        </div>
      )}

      {/* ── 拡大表示 ──
          閉じる手段を 4 つ用意する：× ボタン／背景タップ／Esc／端末の戻る。
          モバイルで「戻れない」が起きたのが、この機能を足した理由。 */}
      {zoomSlot !== null &&
        (() => {
          const slot = slots.find((s) => s.slot === zoomSlot);
          if (!slot?.url) return null;
          const label =
            mode === "removal"
              ? "マスク領域の修復"
              : `${strengthLabel(slot.makeupStrength, slots)} - パターン${slot.variant === 1 ? "A" : "B"}`;

          return (
            <div
              className="lightbox"
              role="dialog"
              aria-modal="true"
              aria-label={`${label} の拡大表示`}
              onClick={() => history.back()}
            >
              <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
                <span className="lightbox-title">
                  候補{slot.slot + 1}　{label}
                  {slot.provider && `　／　${PROVIDER_LABEL_SHORT[slot.provider]}`}
                </span>

                <button
                  className="lightbox-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    saveImage(slot);
                  }}
                  title="この画像を保存する"
                >
                  <i className="fa-solid fa-floppy-disk" /> ダウンロード
                </button>

                <button
                  className="lightbox-btn"
                  disabled={confirming}
                  onClick={(e) => {
                    e.stopPropagation();
                    void confirmSelection(slot);
                  }}
                  title={confirmTitle(finalImage, slot.slot, session)}
                >
                  <i className="fa-solid fa-star" />{" "}
                  {isConfirmed(finalImage, slot.slot) ? "確定済み" : "この 1 枚で確定"}
                </button>

                <button
                  className="lightbox-btn close"
                  onClick={(e) => {
                    e.stopPropagation();
                    history.back();
                  }}
                  aria-label="閉じる"
                  title="閉じる"
                >
                  <i className="fa-solid fa-xmark" /> 閉じる
                </button>
              </div>

              {/* ★ 閉じる処理は最外の .lightbox にだけ置く。
                  ここにも置くとイベントが伝播して history.back() が 2 回走り、
                  拡大表示だけでなくアプリごと前のページへ戻ってしまう。 */}
              <div className="lightbox-body">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={slot.url}
                  alt={label}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>

              <p className="lightbox-hint">
                画像の外側をタップするか、Esc キー・端末の戻るでも閉じられます
              </p>
            </div>
          );
        })()}
    </div>
  );
}
