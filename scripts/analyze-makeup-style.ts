/**
 * 複数の参考写真 → 1 本の「標準メイク」指示テンプレート（開発時に実行するスクリプト）。
 *
 * 委託者指示（2026-09-22）：
 *   「メイク参考画像を参考に、メイクの新プロンプトを作成してほしい」
 *   → 店舗 4 アカウントの投稿写真（121 枚）から共通するメイクの傾向を起こし、
 *     「キャバ嬢風メイク(標準)」として 1 つのプリセットにする。
 *
 * scripts/analyze-makeup-samples.ts（1 枚 → 1 テンプレート）との違い：
 *   こちらは **多数の写真 → 共通項 1 本**。写真ごとの解析は同じ方針で行い、
 *   最後にもう 1 回モデルへ渡して「個人差を除いた共通のメイク」に統合する。
 *
 * 流れ：
 *   1. `--dir` で写真のフォルダを渡す（複数可・再帰）
 *   2. 写真ごとに Gemini（文章モデル）がメイクの要素（ベース・目元・眉・頬・唇）を起こす
 *      顔が小さい／隠れている写真は `face_visibility` で除外候補にする
 *   3. 要素の一覧を Gemini に渡し、共通項だけを 1 本の英語指示文と日本語説明に統合する
 *   4. samples/makeup/style-analysis.<name>.json に記録を残し、統合案を画面に出す
 *   5. 人が読んで直し、templates.demo.ts に載せる（このスクリプトは TS を書き出さない）
 *
 * ★ 写真は生成 API へ送らない。本番に載るのは統合した指示文だけ。
 * ★ 解析の指示は「メイクだけを記述する」ことに限る（analyze-makeup-samples.ts と同じ）。
 * ★ 写真は git に入れない。入るのは記録の JSON（文字だけ）。
 *
 * 使い方：
 *   npm run makeup:style -- --dir "<写真フォルダ>" [--dir ...] --name kyabajo_standard
 *   npm run makeup:style -- ... --dry-run     … API を呼ばず、記録から統合案を印字するだけ
 *   npm run makeup:style -- ... --force       … 全部解析し直す
 *   npm run makeup:style -- ... --resynth     … 写真の解析は記録を使い、統合だけやり直す
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { pocFetch, pickNumber, pickString } from "../src/lib/vendor/providers/http";
import { InfraError, PolicyError } from "../src/lib/vendor/providers/errors";
import { costFromTextUsage } from "../src/lib/vendor/providers/pricing";

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..");
const SAMPLE_DIR = path.join(ROOT, "samples", "makeup");

/** 解析に使うモデル（画像 → 文章。画像は作らない）。analyze-makeup-samples.ts と同じ。 */
const MODEL = {
  provider: "google",
  modelId: "gemini-3.8-flash",
  endpoint: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
} as const;

const TIMEOUT_MS = 120_000;
const CONCURRENCY = 3;
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

// ---------------------------------------------------------------------------
// 1 枚ごとの解析
// ---------------------------------------------------------------------------

const PER_IMAGE_PROMPT =
  "You are a professional makeup artist making a makeup chart from a photo. " +
  "Look at the makeup on the main person in this photo and describe ONLY the makeup.\n\n" +
  "Rules:\n" +
  "- Describe the makeup only: base/skin finish, eyeshadow (colors, placement, finish), eyeliner (shape, length, color), lashes, brows (shape, thickness, color), cheeks (blush color/placement, contour, highlight), lips (color, finish, shape/overline).\n" +
  "- Do NOT describe the person: no face shape, features, age, body, ethnicity, hair, clothing, background, or pose.\n" +
  "- Do NOT use words about attractiveness or sexuality. Keep the tone technical, like a makeup chart.\n" +
  "- `face_visibility`: clear = face is large and sharp enough to judge makeup; small = face is visible but too small or blurry to judge details; obscured = face hidden, cropped, heavily filtered, or not a photo of a person.\n" +
  "- If face_visibility is not clear, still fill the elements with your best reading but keep them short.\n" +
  "- `intensity` is your judgement of overall coverage: light / medium / strong.\n" +
  "- If there are several people, describe the one whose face is largest.";

const PER_IMAGE_SCHEMA = {
  type: "OBJECT",
  properties: {
    face_visibility: { type: "STRING", enum: ["clear", "small", "obscured"] },
    intensity: { type: "STRING", enum: ["light", "medium", "strong"] },
    elements: {
      type: "OBJECT",
      properties: {
        base: { type: "STRING" },
        eyes: { type: "STRING" },
        brows: { type: "STRING" },
        cheeks: { type: "STRING" },
        lips: { type: "STRING" },
      },
      required: ["base", "eyes", "brows", "cheeks", "lips"],
    },
  },
  required: ["face_visibility", "intensity", "elements"],
} as const;

type Elements = Record<"base" | "eyes" | "brows" | "cheeks" | "lips", string>;

type ImageAnalysis = {
  faceVisibility: "clear" | "small" | "obscured";
  intensity: "light" | "medium" | "strong";
  elements: Elements;
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
  latencyMs: number;
};

type Usage = { inputTokens: number; outputTokens: number };

async function callGemini(
  parts: unknown[],
  schema: unknown,
  apiKey: string,
): Promise<{ parsed: Record<string, unknown>; usage: Usage; costUsd: number; latencyMs: number }> {
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.2 },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = performance.now();
  let response;
  try {
    response = await pocFetch(
      MODEL.endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
      },
      controller.signal,
      MODEL.modelId,
    );
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Math.round(performance.now() - startedAt);

  if (!response.ok) {
    const message = pickString(response.json, "error", "message") ?? response.rawBody.slice(0, 300);
    throw new InfraError(`http_${response.status}`, MODEL.modelId, `HTTP ${response.status}: ${message}`);
  }
  const blockReason = pickString(response.json, "promptFeedback", "blockReason");
  if (blockReason) {
    throw new PolicyError(`block_${blockReason.toLowerCase()}`, MODEL.modelId, blockReason, `安全性判定で拒否されました: ${blockReason}`);
  }
  const finishReason = pickString(response.json, "candidates", "0", "finishReason");
  if (finishReason && !["STOP", "MAX_TOKENS"].includes(finishReason.toUpperCase())) {
    throw new PolicyError(`finish_${finishReason.toLowerCase()}`, MODEL.modelId, finishReason, `解析が安全性判定で中断されました: ${finishReason}`);
  }
  const text = pickString(response.json, "candidates", "0", "content", "parts", "0", "text");
  if (!text) throw new InfraError("empty_response", MODEL.modelId, "解析結果が空でした。");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new InfraError("bad_json", MODEL.modelId, "解析結果を JSON として読めませんでした。");
  }
  const usage = {
    inputTokens: pickNumber(response.json, "usageMetadata", "promptTokenCount") ?? 0,
    outputTokens:
      (pickNumber(response.json, "usageMetadata", "candidatesTokenCount") ?? 0) +
      (pickNumber(response.json, "usageMetadata", "thoughtsTokenCount") ?? 0),
  };
  return { parsed, usage, costUsd: costFromTextUsage(MODEL.provider, MODEL.modelId, usage), latencyMs };
}

const str = (v: unknown, max = 1000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function toElements(raw: unknown): Elements {
  const e = (raw ?? {}) as Record<string, unknown>;
  return { base: str(e.base), eyes: str(e.eyes), brows: str(e.brows), cheeks: str(e.cheeks), lips: str(e.lips) };
}

async function analyzeImage(png: Buffer, apiKey: string): Promise<ImageAnalysis> {
  const { parsed, usage, costUsd, latencyMs } = await callGemini(
    [{ inline_data: { mime_type: "image/png", data: png.toString("base64") } }, { text: PER_IMAGE_PROMPT }],
    PER_IMAGE_SCHEMA,
    apiKey,
  );
  const vis = ["clear", "small", "obscured"].includes(String(parsed.face_visibility))
    ? (parsed.face_visibility as ImageAnalysis["faceVisibility"])
    : "small";
  const intensity = ["light", "medium", "strong"].includes(String(parsed.intensity))
    ? (parsed.intensity as ImageAnalysis["intensity"])
    : "medium";
  return { faceVisibility: vis, intensity, elements: toElements(parsed.elements), usage, costUsd, latencyMs };
}

// ---------------------------------------------------------------------------
// 統合（共通項 → 1 本の指示文）
// ---------------------------------------------------------------------------

const SYNTHESIS_PROMPT =
  "You are a professional makeup artist writing ONE instruction for an image-editing model. " +
  "Below are makeup charts read from many photos of different people who all belong to the same venue and share a house makeup style. " +
  "Find the COMMON DENOMINATOR — the elements that appear in most charts — and write a single instruction that reproduces that shared style on a different person's photo.\n\n" +
  "Rules:\n" +
  "- Include only elements that recur across most charts. Put things that vary from person to person (e.g. lip color splitting between red and pink) into `variance_notes`, not into the instruction; if a majority exists, use the majority.\n" +
  "- Describe the makeup only: base/skin finish, eyeshadow, eyeliner, lashes, brows, cheeks (blush/contour/highlight), lips. Do NOT describe the person: no face shape, features, age, body, ethnicity, hair, clothing, background, pose.\n" +
  "- Do NOT use words about attractiveness or sexuality. Keep the tone technical, like a makeup chart.\n" +
  '- `instruction` must be one paragraph in English starting with "Makeup style:" followed by a short style name, then the concrete elements in this order: base, eyes (shadow, liner, lashes), brows, cheeks, lips. About 80-130 words. Use "Apply" or "Add" for each element. Use only the makeup products\' colors, placements and finishes.\n' +
  "- `note_ja` is a faithful Japanese translation of `instruction` for staff who do not read English.\n" +
  "- `common_elements` summarises, per element, what the majority of charts share (one short sentence each).\n" +
  "- `variance_notes` lists what differs between people and was therefore left out or reduced to the majority.\n" +
  "- `intensity` is the overall coverage of the shared style: light / medium / strong.\n\n" +
  "Charts:\n";

const SYNTHESIS_SCHEMA = {
  type: "OBJECT",
  properties: {
    style_name: { type: "STRING" },
    intensity: { type: "STRING", enum: ["light", "medium", "strong"] },
    common_elements: {
      type: "OBJECT",
      properties: {
        base: { type: "STRING" },
        eyes: { type: "STRING" },
        brows: { type: "STRING" },
        cheeks: { type: "STRING" },
        lips: { type: "STRING" },
      },
      required: ["base", "eyes", "brows", "cheeks", "lips"],
    },
    variance_notes: { type: "ARRAY", items: { type: "STRING" } },
    instruction: { type: "STRING" },
    note_ja: { type: "STRING" },
  },
  required: ["style_name", "intensity", "common_elements", "variance_notes", "instruction", "note_ja"],
} as const;

type Synthesis = {
  styleName: string;
  intensity: "light" | "medium" | "strong";
  commonElements: Elements;
  varianceNotes: string[];
  instruction: string;
  noteJa: string;
  /** 統合に使った写真の数（face_visibility が clear のもの）。 */
  basedOn: number;
  usage: Usage;
  costUsd: number;
  latencyMs: number;
  synthesizedAt: string;
};

async function synthesize(charts: ImageRecord[], apiKey: string): Promise<Synthesis> {
  const text =
    SYNTHESIS_PROMPT +
    charts
      .map(
        (r, i) =>
          `#${i + 1} (intensity: ${r.analysis.intensity})\n` +
          `  base: ${r.analysis.elements.base}\n` +
          `  eyes: ${r.analysis.elements.eyes}\n` +
          `  brows: ${r.analysis.elements.brows}\n` +
          `  cheeks: ${r.analysis.elements.cheeks}\n` +
          `  lips: ${r.analysis.elements.lips}`,
      )
      .join("\n\n");
  const { parsed, usage, costUsd, latencyMs } = await callGemini([{ text }], SYNTHESIS_SCHEMA, apiKey);
  const instruction = str(parsed.instruction, 900);
  if (!instruction) throw new InfraError("no_instruction", MODEL.modelId, "統合結果に指示文がありませんでした。");
  const intensity = ["light", "medium", "strong"].includes(String(parsed.intensity))
    ? (parsed.intensity as Synthesis["intensity"])
    : "medium";
  const notes = Array.isArray(parsed.variance_notes) ? parsed.variance_notes.map((n) => str(n, 300)).filter(Boolean) : [];
  return {
    styleName: str(parsed.style_name, 80),
    intensity,
    commonElements: toElements(parsed.common_elements),
    varianceNotes: notes,
    instruction,
    noteJa: str(parsed.note_ja, 600),
    basedOn: charts.length,
    usage,
    costUsd,
    latencyMs,
    synthesizedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 記録
// ---------------------------------------------------------------------------

type ImageRecord = {
  /** 写真のパス（--dir からの相対）。 */
  file: string;
  imageSha256: string;
  analysis: ImageAnalysis;
  analyzedAt: string;
};

type RecordFile = {
  note: string;
  name: string;
  model: string;
  dirs: string[];
  images: ImageRecord[];
  synthesis: Synthesis | null;
};

function recordPath(name: string) {
  return path.join(SAMPLE_DIR, `style-analysis.${name}.json`);
}

function loadRecords(name: string): RecordFile {
  const p = recordPath(name);
  if (!existsSync(p)) return { note: "", name, model: MODEL.modelId, dirs: [], images: [], synthesis: null };
  return JSON.parse(readFileSync(p, "utf8")) as RecordFile;
}

function saveRecords(file: RecordFile) {
  file.note =
    "複数の参考写真から共通のメイクを起こした記録。images は写真ごとの解析、synthesis が統合案。" +
    "本番に載せる文言は人が読んで直し、templates.demo.ts に書く（このファイルは根拠として残す）。写真そのものは git に入れない。";
  mkdirSync(SAMPLE_DIR, { recursive: true });
  writeFileSync(recordPath(file.name), JSON.stringify(file, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// 入力
// ---------------------------------------------------------------------------

function listImages(dirs: string[]): { file: string; abs: string }[] {
  const out: { file: string; abs: string }[] = [];
  const walk = (base: string, dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue;
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) {
        walk(base, abs);
      } else if (IMAGE_EXT.has(path.extname(name).toLowerCase())) {
        out.push({ file: path.join(path.basename(base), path.relative(base, abs)), abs });
      }
    }
  };
  for (const d of dirs) walk(d, d);
  return out;
}

function parseArgs(argv: string[]) {
  const dirs: string[] = [];
  let name = "kyabajo_standard";
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--dir") dirs.push(path.resolve(argv[++i] ?? ""));
    else if (a === "--name") name = argv[++i] ?? name;
    else if (a.startsWith("--")) flags.add(a);
    else throw new Error(`引数の形式が不正です: ${a}`);
  }
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`--name は英小文字・数字・_ のみ: ${name}`);
  return { dirs, name, force: flags.has("--force"), dryRun: flags.has("--dry-run"), resynth: flags.has("--resynth") };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const { dirs, name, force, dryRun, resynth } = parseArgs(process.argv.slice(2));
  const recordFile = loadRecords(name);
  const useDirs = dirs.length > 0 ? dirs : recordFile.dirs;
  if (useDirs.length === 0) throw new Error("--dir <写真フォルダ> を指定してください。");
  for (const d of useDirs) {
    if (!existsSync(d)) throw new Error(`フォルダがありません: ${d}`);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey && !dryRun) {
    throw new Error("GEMINI_API_KEY が未設定です（.env.local を読み込むか、環境変数で渡してください）。");
  }

  const images = listImages(useDirs);
  if (images.length === 0) throw new Error("写真がありません。");
  console.log(`写真 ${images.length} 枚（${useDirs.map((d) => path.basename(d)).join(", ")}）`);

  const byFile = new Map(recordFile.images.map((r) => [r.file, r]));
  let calls = 0;
  let spentUsd = 0;

  // ── 写真ごとの解析（並列 CONCURRENCY） ──
  const analyzed = await mapLimit(images, CONCURRENCY, async (img): Promise<ImageRecord | null> => {
    const raw = readFileSync(img.abs);
    const sha = createHash("sha256").update(raw).digest("hex");
    const existing = byFile.get(img.file);
    if (existing && existing.imageSha256 === sha && !force) {
      console.log(`= ${img.file}  （記録を再利用・${existing.analysis.faceVisibility}）`);
      return existing;
    }
    if (dryRun) {
      console.log(`! ${img.file}  （未解析。--dry-run のためスキップ）`);
      return existing ?? null;
    }
    // 長辺 1024 に収めてから送る（解析には十分。トークンを無駄にしない）
    const png = await sharp(raw)
      .rotate()
      .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
    try {
      const analysis = await analyzeImage(png, apiKey!);
      calls += 1;
      spentUsd += analysis.costUsd;
      console.log(
        `> ${img.file}  ${(analysis.latencyMs / 1000).toFixed(1)} 秒・$${analysis.costUsd.toFixed(4)}・${analysis.faceVisibility}・${analysis.intensity}`,
      );
      return { file: img.file, imageSha256: sha, analysis, analyzedAt: new Date().toISOString() };
    } catch (error) {
      const kind = error instanceof PolicyError ? "拒否" : "失敗";
      console.log(`x ${img.file}  ${kind}: ${error instanceof Error ? error.message : String(error)}`);
      return existing ?? null;
    }
  });

  recordFile.dirs = useDirs;
  recordFile.model = MODEL.modelId;
  recordFile.images = analyzed.filter((r): r is ImageRecord => r !== null);
  saveRecords(recordFile);

  const clear = recordFile.images.filter((r) => r.analysis.faceVisibility === "clear");
  const counts = { clear: clear.length, small: 0, obscured: 0 };
  for (const r of recordFile.images) if (r.analysis.faceVisibility !== "clear") counts[r.analysis.faceVisibility] += 1;
  console.log("");
  console.log(`解析済み ${recordFile.images.length} 枚（clear ${counts.clear} / small ${counts.small} / obscured ${counts.obscured}）`);

  // ── 統合 ──
  const needSynth = clear.length > 0 && (!recordFile.synthesis || resynth || force || calls > 0);
  if (needSynth && !dryRun) {
    if (clear.length < 5) {
      console.log(`⚠️ 顔がはっきり写った写真が ${clear.length} 枚しかありません。統合の信頼性は低くなります。`);
    }
    process.stdout.write(`統合中（${clear.length} 枚の解析を 1 本に）…`);
    const synthesis = await synthesize(clear, apiKey!);
    calls += 1;
    spentUsd += synthesis.costUsd;
    console.log(`  ${(synthesis.latencyMs / 1000).toFixed(1)} 秒・$${synthesis.costUsd.toFixed(4)}`);
    recordFile.synthesis = synthesis;
    saveRecords(recordFile);
  }

  console.log("");
  console.log(`API 呼び出し ${calls} 回・$${spentUsd.toFixed(4)}`);
  console.log(`記録: ${path.relative(ROOT, recordPath(name))}`);

  const s = recordFile.synthesis;
  if (!s) {
    console.log("統合案はまだありません（--dry-run を外して実行してください）。");
    return;
  }
  console.log("");
  console.log(`── 統合案（${s.basedOn} 枚から・濃さの目安: ${s.intensity}／${s.styleName}） ──`);
  console.log(`EN: ${s.instruction}`);
  console.log(`JA: ${s.noteJa}`);
  console.log("");
  console.log("共通項:");
  for (const [k, v] of Object.entries(s.commonElements)) console.log(`  ${k}: ${v}`);
  console.log("個人差として外したもの:");
  for (const v of s.varianceNotes) console.log(`  - ${v}`);
  console.log("");
  console.log("※ この文言は人が読んで直してから templates.demo.ts に載せる。");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
