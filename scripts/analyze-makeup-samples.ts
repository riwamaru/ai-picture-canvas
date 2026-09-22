/**
 * メイクの見本写真 → 指示テンプレート（開発時に実行するスクリプト）。
 *
 * 委託者指示（2026-09-21）：
 *   「既存の画像を学習してプロンプトをブラッシュアップしたい」
 *   「システム内に機能を盛り込むのではなく、開発段階でこの作業を行って、
 *     実際の環境に新しいプロンプトを反映させる方式で」
 *
 * 流れ：
 *   1. 店舗の見本写真を samples/makeup/ に置く（ファイル名が選択肢の名前になる）
 *   2. `npm run makeup:analyze` を実行する
 *      → Gemini（文章モデル）が写真を読み、メイクの要素（ベース・目元・眉・頬・唇）を
 *        英語の指示文と日本語の説明に起こす
 *      → src/lib/vendor/prompts/templates.makeup-samples.ts を書き出す
 *      → samples/makeup/analysis.json に解析の記録（要素・トークン数・費用）を残す
 *   3. 書き出された指示文と日本語を人が読んで直す（直した内容は analysis.json にも反映すること。
 *      次回の実行で写真が同じなら analysis.json の値が使われ、API は呼ばれない）
 *   4. デプロイすると、加工画面のメイクカード「テンプレートから選択」に並ぶ
 *
 * ★ 見本の写真は生成 API へ送らない。本番に載るのは起こした指示文だけ。
 *   写真は git にも入れない（samples/makeup/ は .gitignore 済み。記録の JSON と生成 TS だけが入る）。
 *
 * ★ 解析の指示は「メイクだけを記述する」ことに限る。人物の造作・体型・年齢・
 *   露出などを書かせない。書かれても生成側の共通制約（本人性の保持）が最後に付くが、
 *   そもそも文に含めない。起こした文は人が読んでから本番へ載せる
 *   （仕様書 4.5.3「提示する表現をあらかじめ自社で検証・管理できる」）。
 *
 * 使い方：
 *   npm run makeup:analyze                 … 未解析（写真が変わった）ぶんだけ API を呼ぶ
 *   npm run makeup:analyze -- --force      … 全部解析し直す（人が直した文言は上書きされる）
 *   npm run makeup:analyze -- --dry-run    … API を呼ばず、いまの記録からファイルを書き出すだけ
 *
 * ファイル名の規則：  NN_名前.jpg   例) 01_大人ナチュラル.jpg
 *   → id: makeup.sample_01 ／ 画面の名前: 大人ナチュラル
 *   NN（2 桁）が無いファイルは並び順で番号を振る。番号は ID になるので、後から変えない。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
const RECORD_PATH = path.join(SAMPLE_DIR, "analysis.json");
const OUTPUT_PATH = path.join(ROOT, "src", "lib", "vendor", "prompts", "templates.makeup-samples.ts");

/**
 * 解析に使うモデル（画像 → 文章。画像は作らない）。
 * 2026-09-21 のモデル一覧（GET /v1beta/models）で確認した ID。単価は providers/pricing.ts。
 */
const MODEL = {
  provider: "google",
  modelId: "gemini-3.8-flash",
  endpoint: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
} as const;

const TIMEOUT_MS = 120_000;
const INSTRUCTION_MAX = 600;
const NOTE_MAX = 400;

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * 解析の指示。出力は JSON で固定する（responseSchema）。
 * 自由文で返させると「この人は…」と人物の説明が混ざりやすい。
 */
const ANALYSIS_PROMPT =
  "You are a professional makeup artist writing an instruction for an image-editing model. " +
  "Look at the makeup in this sample photo and describe ONLY the makeup, so that the same makeup can be applied to a different person's photo.\n\n" +
  "Rules:\n" +
  "- Describe the makeup only: base/skin finish, eyeshadow (colors, placement, finish), eyeliner, lashes, brows (shape, thickness), cheeks (blush color/placement, contour, highlight), lips (color, finish, shape).\n" +
  "- Do NOT describe the person: no face shape, features, age, body, ethnicity, hair, clothing, background, or pose.\n" +
  "- Do NOT use words about attractiveness or sexuality. Keep the tone technical, like a makeup chart.\n" +
  '- `instruction` must be one paragraph in English starting with "Makeup style:" followed by a short style name, then the concrete elements. About 60-110 words. Use only the makeup products\' colors and placements; use the phrase "Apply" or "Add" for each element.\n' +
  "- `note_ja` is a faithful Japanese translation of `instruction` for staff who do not read English.\n" +
  "- `intensity` is your judgement of overall coverage: light / medium / strong.";

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    style_name: { type: "STRING" },
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
    instruction: { type: "STRING" },
    note_ja: { type: "STRING" },
  },
  required: ["style_name", "intensity", "elements", "instruction", "note_ja"],
} as const;

type Analysis = {
  styleName: string;
  intensity: "light" | "medium" | "strong";
  elements: Record<"base" | "eyes" | "brows" | "cheeks" | "lips", string>;
  instruction: string;
  noteJa: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
  latencyMs: number;
};

async function analyze(png: Buffer, apiKey: string): Promise<Analysis> {
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { inline_data: { mime_type: "image/png", data: png.toString("base64") } },
          { text: ANALYSIS_PROMPT },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.2,
    },
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
    throw new PolicyError(`block_${blockReason.toLowerCase()}`, MODEL.modelId, blockReason, `写真が安全性判定で拒否されました: ${blockReason}`);
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
  const elements = (parsed.elements ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max = 1000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const instruction = str(parsed.instruction, INSTRUCTION_MAX);
  if (!instruction) throw new InfraError("no_instruction", MODEL.modelId, "解析結果に指示文がありませんでした。");

  const usage = {
    inputTokens: pickNumber(response.json, "usageMetadata", "promptTokenCount") ?? 0,
    outputTokens:
      (pickNumber(response.json, "usageMetadata", "candidatesTokenCount") ?? 0) +
      (pickNumber(response.json, "usageMetadata", "thoughtsTokenCount") ?? 0),
  };
  const intensity = ["light", "medium", "strong"].includes(String(parsed.intensity))
    ? (parsed.intensity as Analysis["intensity"])
    : "medium";

  return {
    styleName: str(parsed.style_name, 80),
    intensity,
    elements: {
      base: str(elements.base),
      eyes: str(elements.eyes),
      brows: str(elements.brows),
      cheeks: str(elements.cheeks),
      lips: str(elements.lips),
    },
    instruction,
    noteJa: str(parsed.note_ja, NOTE_MAX),
    model: MODEL.modelId,
    usage,
    costUsd: costFromTextUsage(MODEL.provider, MODEL.modelId, usage),
    latencyMs,
  };
}

// ---------------------------------------------------------------------------
// 記録（analysis.json）
// ---------------------------------------------------------------------------

type Record_ = {
  /** 写真のファイル名（samples/makeup/ 内）。 */
  file: string;
  /** 写真の SHA-256。変わっていなければ再解析しない。 */
  imageSha256: string;
  id: string;
  labelJa: string;
  analysis: Analysis;
  analyzedAt: string;
};

type RecordFile = {
  note: string;
  model: string;
  records: Record_[];
};

function loadRecords(): RecordFile {
  if (!existsSync(RECORD_PATH)) return { note: "", model: MODEL.modelId, records: [] };
  return JSON.parse(readFileSync(RECORD_PATH, "utf8")) as RecordFile;
}

function saveRecords(file: RecordFile) {
  file.note =
    "メイク見本の解析記録。instruction / noteJa は人が直してよい（直した値がテンプレートに書き出される）。" +
    "写真を差し替えると imageSha256 が変わり、次回の実行で解析し直される。";
  writeFileSync(RECORD_PATH, JSON.stringify(file, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// 入力ファイルの並びと ID
// ---------------------------------------------------------------------------

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function listSamples(): { file: string; id: string; labelJa: string }[] {
  const names = readdirSync(SAMPLE_DIR)
    .filter((n) => IMAGE_EXT.has(path.extname(n).toLowerCase()) && !n.startsWith("."))
    .sort((a, b) => a.localeCompare(b, "ja"));

  const used = new Set<string>();
  return names.map((file, index) => {
    const stem = path.basename(file, path.extname(file));
    const m = /^(\d{2})[_\-\s]+(.+)$/.exec(stem);
    const num = m ? m[1] : String(index + 1).padStart(2, "0");
    const labelJa = (m ? m[2] : stem).trim().slice(0, 40);
    const id = `makeup.sample_${num}`;
    if (used.has(id)) {
      throw new Error(`番号 ${num} が重複しています（${file}）。ファイル名の先頭 2 桁は一意にしてください。`);
    }
    used.add(id);
    return { file, id, labelJa };
  });
}

// ---------------------------------------------------------------------------
// 書き出し（templates.makeup-samples.ts）
// ---------------------------------------------------------------------------

function tsString(value: string): string {
  return JSON.stringify(value);
}

function renderTemplates(records: Record_[]): string {
  const entries = records
    .map(
      (r) =>
        `  // ${r.file}（濃さの目安: ${r.analysis.intensity}／${r.analysis.styleName}）\n` +
        `  Object.freeze({\n` +
        `    id: ${tsString(r.id)},\n` +
        `    categoryId: "makeup" as CategoryId,\n` +
        `    labelJa: ${tsString(r.labelJa)},\n` +
        `    instruction:\n      ${tsString(r.analysis.instruction)},\n` +
        `    noteJa:\n      ${tsString(r.analysis.noteJa)},\n` +
        `  }),`,
    )
    .join("\n");

  return (
    `/**\n` +
    ` * 店舗のメイク見本から起こしたテンプレート（自動生成・委託者指示 2026-09-21）。\n` +
    ` *\n` +
    ` * ★ このファイルは scripts/analyze-makeup-samples.ts が書き出す。直接編集しない。\n` +
    ` *   文言を直すときは samples/makeup/analysis.json の instruction / noteJa を直して\n` +
    ` *   \`npm run makeup:analyze -- --dry-run\` で書き出し直す。\n` +
    ` *\n` +
    ` * 見本の写真は生成 API へ送らない。本番に載るのはここに書かれた指示文だけ。\n` +
    ` * 指示文は Gemini（${MODEL.modelId}）が写真から起こし、人が読んで直したもの。\n` +
    ` * 既存の makeup.* テンプレートと同じ位置（強度の指示のあと）にプロンプトへ入る。\n` +
    ` *\n` +
    ` * 生成日時: ${new Date().toISOString()}\n` +
    ` */\n\n` +
    `import type { CategoryId } from "./categories";\n` +
    `import type { Template } from "./templates";\n\n` +
    `export const MAKEUP_SAMPLE_TEMPLATES: readonly Template[] = Object.freeze([\n` +
    `${entries}\n` +
    `]);\n`
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = new Set(process.argv.slice(2));
  const force = args.has("--force");
  const dryRun = args.has("--dry-run");

  if (!existsSync(SAMPLE_DIR)) {
    mkdirSync(SAMPLE_DIR, { recursive: true });
    console.log(`samples/makeup/ を作りました。見本写真（01_名前.jpg の形式）を置いてから再実行してください。`);
    return;
  }

  const samples = listSamples();
  if (samples.length === 0) {
    console.log(`samples/makeup/ に写真がありません。01_名前.jpg の形式で置いてください。`);
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey && !dryRun) {
    throw new Error("GEMINI_API_KEY が未設定です（.env.local を読み込むか、環境変数で渡してください）。");
  }

  const recordFile = loadRecords();
  const byFile = new Map(recordFile.records.map((r) => [r.file, r]));
  const next: Record_[] = [];
  let calls = 0;
  let spentUsd = 0;

  for (const sample of samples) {
    const raw = readFileSync(path.join(SAMPLE_DIR, sample.file));
    const sha = createHash("sha256").update(raw).digest("hex");
    const existing = byFile.get(sample.file);

    if (existing && existing.imageSha256 === sha && !force) {
      // 写真が同じ → 記録（人が直した文言を含む）をそのまま使う。API は呼ばない
      next.push({ ...existing, id: sample.id, labelJa: sample.labelJa });
      console.log(`= ${sample.file}  （記録を再利用）`);
      continue;
    }
    if (dryRun) {
      if (existing) {
        next.push({ ...existing, id: sample.id, labelJa: sample.labelJa });
        console.log(`~ ${sample.file}  （写真が変わっていますが --dry-run のため古い記録を使用）`);
      } else {
        console.log(`! ${sample.file}  （未解析。--dry-run のためスキップ）`);
      }
      continue;
    }

    // 長辺 1024 に収めてから送る（解析には十分。トークンを無駄にしない）
    const png = await sharp(raw)
      .rotate()
      .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();

    process.stdout.write(`> ${sample.file}  解析中…`);
    try {
      const analysis = await analyze(png, apiKey!);
      calls += 1;
      spentUsd += analysis.costUsd;
      next.push({
        file: sample.file,
        imageSha256: sha,
        id: sample.id,
        labelJa: sample.labelJa,
        analysis,
        analyzedAt: new Date().toISOString(),
      });
      console.log(`  ${(analysis.latencyMs / 1000).toFixed(1)} 秒・$${analysis.costUsd.toFixed(4)}・${analysis.intensity}`);
    } catch (error) {
      const kind = error instanceof PolicyError ? "拒否" : "失敗";
      console.log(`  ${kind}: ${error instanceof Error ? error.message : String(error)}`);
      if (existing) next.push({ ...existing, id: sample.id, labelJa: sample.labelJa });
    }
  }

  recordFile.model = MODEL.modelId;
  recordFile.records = next;
  saveRecords(recordFile);
  writeFileSync(OUTPUT_PATH, renderTemplates(next), "utf8");

  console.log("");
  console.log(`API 呼び出し ${calls} 回・$${spentUsd.toFixed(4)}`);
  console.log(`記録:       ${path.relative(ROOT, RECORD_PATH)}`);
  console.log(`テンプレート: ${path.relative(ROOT, OUTPUT_PATH)}（${next.length} 件）`);
  console.log("");
  console.log("── 確認用（日本語の説明。英語の指示文と食い違いが無いか読んでください） ──");
  for (const r of next) {
    console.log(`\n[${r.id}] ${r.labelJa}（${r.analysis.intensity}）`);
    console.log(`  EN: ${r.analysis.instruction}`);
    console.log(`  JA: ${r.analysis.noteJa}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
