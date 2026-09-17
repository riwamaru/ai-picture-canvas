/**
 * プロンプト構築（純関数）。
 *
 * ★ 本実装へ移設する層（指示書 9.2「プロンプト構築のロジック＝実運用のテンプレートの原型」）。
 *
 * 【設計の核心：無効カテゴリを型で排除する】
 *
 * 機能仕様書 2.2（B-1）：
 *   「無効に設定されたカテゴリの情報（参考画像・自由入力テキスト・テンプレート指示）は、
 *     プロンプト構築の対象から除外し、API リクエストに含めない」
 *
 * これを実行時の if で守ると「enabled: false なのにテキストを渡してしまう」バグが書ける。
 * そこで PromptSpec は enabled フラグを持たず、
 *   キーが存在する ＝ 有効
 * という一意な表現にした。無効カテゴリを渡す方法が型として存在しないため、
 * 無効カテゴリの文字列が API へ届く経路がコンパイル時に消える。
 */

import {
  acceptsReferenceImages,
  CATEGORY_IDS,
  CATEGORY_LABEL_JA,
  PROCESS_KIND,
  REFERENCE_LIMIT,
  type CategoryId,
  type MakeupStrength,
} from "./categories";
import { promptHash } from "./hash";
import {
  IDENTITY_GUARD_INSTRUCTION,
  IDENTITY_GUARD_NOTE_JA,
  MAKEUP_STRENGTH_TEMPLATES,
  PRESERVE_PHRASES,
  PRESERVE_PHRASES_JA,
  TEMPLATE_VERSION,
  requireTemplate,
} from "./templates";
import {
  variantInstruction,
  variantSeedHint,
  type VariantIndex,
  type VariantStrategy,
} from "./variants";

export type CategoryInput = {
  /**
   * テンプレート ID。
   *
   * メイクでは指定しない（指示内容は makeupStrength で決まるため）。
   * メイク以外では必須。省略すると buildPrompt が落ちる
   * — 指定し忘れた条件が静かにプロンプトから抜け落ちるのを防ぐため。
   */
  readonly templateId?: string;
  /** ユーザーの自由入力。実運用では店舗スタッフが書く欄に相当する。 */
  readonly freeText?: string;
  /** 参考画像の枚数。実バイト列は runner が持つ（この層は画像を扱わない）。 */
  readonly referenceCount: number;
};

export type PromptSpec = {
  /**
   * ★ enabled フラグを持たない。キーの存在＝有効。
   *   無効カテゴリを渡す方法が型として存在しない。
   */
  readonly categories: Partial<Record<CategoryId, CategoryInput>>;
  readonly makeupStrength: MakeupStrength;
  readonly variant: VariantIndex;
  readonly variantStrategy: VariantStrategy;
};

export type BuiltPrompt = {
  /** API へ送る指示文の全文。 */
  readonly text: string;
  /** results.jsonl の promptHash。 */
  readonly hash: string;
  /** 有効カテゴリの一覧（記録用。無効カテゴリは含まれない）。 */
  readonly enabledCategories: readonly CategoryId[];
  /** 必要な参考画像の総枚数。runner が実際に添付する枚数と一致しなければならない。 */
  readonly referenceCount: number;
  /** マスク画像が必要か（種別 C が有効なとき）。 */
  readonly requiresMask: boolean;
  /** 監査用の日本語説明。API へは送らない。 */
  readonly noteJa: string;
  /** seed ヒント（現時点ではどのプロバイダも無視する）。 */
  readonly variantSeedHint: string;
  /**
   * テンプレートの版数。
   *
   * 本文を変えると promptHash が変わり、過去の記録と比較できなくなる。
   * どの版で測った結果かを追えるように記録へ残す。
   */
  readonly templateVersion: string;
};

export class PromptSpecError extends Error {
  constructor(message: string) {
    super(`[PROMPT] ${message}`);
    this.name = "PromptSpecError";
  }
}

/**
 * プロンプトを構築する。
 *
 * 出力順序を固定しているのは、同じ条件なら必ず同じ文字列になるようにするため
 * （promptHash が安定しないと禁止事項③の検出が誤作動する）。
 */
export function buildPrompt(spec: PromptSpec): BuiltPrompt {
  // CATEGORY_IDS の宣言順で走査する。Object.keys の順序に依存させない。
  const enabled = CATEGORY_IDS.filter((id) => spec.categories[id] !== undefined);

  // ★ デモ環境での変更点②（PoC からの差分）。
  //
  //   PoC はメイクを常に必須としていた（機能仕様書 2.2.1
  //   「メイクは必須カテゴリとし、弱・中・強の 3 段階それぞれについて 2 枚」）。
  //   PoC の S-05（タトゥー除去）も categories に makeup を含めている。
  //
  //   しかしこれは inpaint では正しくない。マスク編集ではプロンプトが
  //   **マスク領域の中身**を指示するため、肩のタトゥーを塗ったマスクに対して
  //   「メイクを変えろ」と言うと指示が破綻する。
  //
  //   除去専用モード（tattoo_removal だけが有効）に限り、メイク必須を免除する。
  //   それ以外は従来どおり必須のまま。
  const removalOnly = enabled.length === 1 && enabled[0] === "tattoo_removal";

  if (!enabled.includes("makeup") && !removalOnly) {
    throw new PromptSpecError("メイクは必須カテゴリです。categories.makeup を指定してください。");
  }

  const referenceCount = enabled.reduce((sum, id) => {
    const input = spec.categories[id];
    if (!input) return sum;
    if (input.referenceCount > 0 && !acceptsReferenceImages(id)) {
      throw new PromptSpecError(
        `${CATEGORY_LABEL_JA[id]}（${id}）は参考画像を受け付けません（処理種別 ${PROCESS_KIND[id]}）。`,
      );
    }
    if (input.referenceCount > REFERENCE_LIMIT.perCategory) {
      throw new PromptSpecError(
        `${CATEGORY_LABEL_JA[id]}（${id}）の参考画像が上限を超えています` +
          `（${input.referenceCount} 枚 / 上限 ${REFERENCE_LIMIT.perCategory} 枚）。`,
      );
    }
    return sum + input.referenceCount;
  }, 0);

  if (referenceCount > REFERENCE_LIMIT.perSession) {
    throw new PromptSpecError(
      `参考画像の合計が上限を超えています（${referenceCount} 枚 / 上限 ${REFERENCE_LIMIT.perSession} 枚）。`,
    );
  }

  const requiresMask = enabled.some((id) => PROCESS_KIND[id] === "C");

  // ── 指示文の組み立て ──
  //
  // ★ 並び順に意味がある（2026-08-16 の実測）。
  //   v2 では「保持せよ」を先に長々と述べ、変更内容を最後に置いた。
  //   結果、モデルは最も安全な行動＝**何も変えずに返す**を選んだ。
  //   元画像との平均画素差 3.0（再圧縮ノイズと同水準）で、
  //   顔を拡大してもメイクが適用されていなかった。
  //
  //   v1（保持の指示なし）は逆に全部作り直した（平均画素差 95.7）。
  //
  //   v3 では「何を変えるか」を先に、「それ以外は保つ」を後に置く。
  const lines: string[] = [];
  const notes: string[] = [];

  // メイク（必須・強度指定）。除去専用モードでは出さない。
  if (!removalOnly) {
    const makeup = MAKEUP_STRENGTH_TEMPLATES[spec.makeupStrength];
    lines.push(
      `Task — change the makeup on this person's face. ` +
        `The change must be clearly visible in the result: ${makeup.instruction}`,
    );
    notes.push(
      `変更内容（メイク・${spec.makeupStrength}）: ${makeup.noteJa}` +
        `／結果に変化がはっきり見えていること`,
    );
  }

  const makeupInput = spec.categories.makeup;

  // ★ デモ環境での変更点（PoC からの差分）。
  //
  //   PoC はここでメイクのテンプレート ID を拒否していた。
  //   「指示内容は makeupStrength で決まるので、受け取っても使えない」という理由である。
  //
  //   ところが確定 UI（index.html）のメイクカードには
  //   テンプレート選択（ナチュラル美肌／華やかパーティー／韓国風）と
  //   「弱・中・強 各 2 枚」の自動生成が **両方** ある。
  //   つまり確定仕様では、強度とスタイルは別の軸である。
  //
  //   そこで拒否をやめ、強度の指示のあとにスタイルの指示を重ねる。
  //   強度（どれくらい濃いか）→ スタイル（どういう方向性か）の順。
  if (makeupInput?.templateId !== undefined) {
    const template = requireTemplate(makeupInput.templateId);
    if (template.categoryId !== "makeup") {
      throw new PromptSpecError(
        `テンプレート ${template.id} はカテゴリ ${template.categoryId} 用です（指定: makeup）。`,
      );
    }
    lines.push(template.instruction);
    notes.push(`メイクの方向性: ${template.noteJa}`);
  }
  if (makeupInput?.freeText) {
    lines.push(`Additional makeup note: ${makeupInput.freeText}`);
    notes.push(`メイク自由入力: ${makeupInput.freeText}`);
  }

  // メイク以外の有効カテゴリ。宣言順で走査する。
  //
  // ★ デモ環境での変更点（委託者指示・2026-09-17。PoC からの差分）。
  //
  //   PoC はテンプレートを必須としていた。デモでは
  //     参考画像 ／ テンプレート ／ 自由記述 のどれか 1 つがあれば通す。
  //   さらに **参考画像があればそれを優先**する：
  //     - 参考画像の指示を先に置き、「主たる目標」と明示する
  //     - テンプレートは補助に格下げし、「食い違ったら参考画像に従え」と添える
  //   （先に置いた指示ほど効く、という 2026-08-16 の実測に合わせた並び）
  for (const id of enabled) {
    if (id === "makeup") continue;
    const input = spec.categories[id];
    if (!input) continue;

    const hasTemplate = input.templateId !== undefined;
    const hasReference = input.referenceCount > 0;
    const hasFreeText = Boolean(input.freeText);

    if (!hasTemplate && !hasReference && !hasFreeText) {
      throw new PromptSpecError(
        `${CATEGORY_LABEL_JA[id]}（${id}）は、テンプレート・参考画像・自由記述のどれか 1 つが必要です。`,
      );
    }

    const label = labelEn(id);

    if (hasReference) {
      lines.push(
        `${label}: match the provided reference image(s) for the ${label.toLowerCase()} — ` +
          `they are the primary visual target.`,
      );
      notes.push(
        `${CATEGORY_LABEL_JA[id]}: 参考画像 ${input.referenceCount} 枚を主たる目標として合わせる。`,
      );
    }

    if (hasTemplate) {
      const template = requireTemplate(input.templateId!);
      if (template.categoryId !== id) {
        throw new PromptSpecError(
          `テンプレート ${template.id} はカテゴリ ${template.categoryId} 用です（指定: ${id}）。`,
        );
      }
      if (hasReference) {
        lines.push(
          `${label} guidance (secondary to the reference images; if they conflict, follow the reference images): ` +
            template.instruction,
        );
        notes.push(`${CATEGORY_LABEL_JA[id]}の補助（参考画像と食い違えば参考画像を優先）: ${template.noteJa}`);
      } else {
        lines.push(`${label}: ${template.instruction}`);
        notes.push(`${CATEGORY_LABEL_JA[id]}: ${template.noteJa}`);
      }
    }

    if (hasFreeText) {
      lines.push(
        hasTemplate || hasReference
          ? `Additional ${label.toLowerCase()} note: ${input.freeText}`
          : `${label}: ${input.freeText}`,
      );
      notes.push(`${CATEGORY_LABEL_JA[id]}自由入力: ${input.freeText}`);
    }
  }

  // バリエーション（案 2 のときだけ追加される）
  const variant = variantInstruction(spec.variantStrategy, spec.variant);
  if (variant) {
    lines.push(`Variation: ${variant.instruction}`);
    notes.push(`バリエーション${spec.variant}: ${variant.noteJa}`);
  }

  // ── 変更しないものを、変更内容のあとに置く ──
  //
  // ★ 「送らない」と「変えるなと言う」は別である。
  //   無効カテゴリについて黙っていると、利用者が無効にしたはずのものが変わる。
  //   実測では S-01（メイクのみ）で姿勢・画角が全件変わり、
  //   1 枚は衣装と背景まで変わった。
  const preserved = CATEGORY_IDS.filter((id) => !enabled.includes(id));
  if (preserved.length > 0) {
    lines.push(
      `Apply the change above to the source photograph and nothing else. ` +
        `Keep exactly as-is: ${preserved.map((id) => PRESERVE_PHRASES[id]).join("; ")}. ` +
        `Do not re-compose, re-crop, re-frame, or re-shoot the scene.`,
    );
    notes.push(
      `上記の変更だけを元画像に適用する。それ以外は元のまま保つ` +
        `（${preserved.map((id) => PRESERVE_PHRASES_JA[id]).join("／")}）。` +
        `構図の作り直し・トリミング変更・撮り直しは行わない。`,
    );
  }

  // 本人性の保持は最後に置く（最後の指示ほど効きやすいため）
  lines.push(IDENTITY_GUARD_INSTRUCTION);
  notes.push(IDENTITY_GUARD_NOTE_JA);

  const text = lines.join("\n");

  // ハッシュは「同じ条件なら同じ値」になる必要があるので、
  // 生成文ではなく構造化した仕様からとる。改行や語順の微差に引きずられないため。
  const hash = promptHash({
    categories: Object.fromEntries(
      enabled.map((id) => [
        id,
        {
          templateId: spec.categories[id]?.templateId,
          freeText: spec.categories[id]?.freeText,
          referenceCount: spec.categories[id]?.referenceCount,
        },
      ]),
    ),
    makeupStrength: spec.makeupStrength,
    variant: spec.variant,
    variantStrategy: spec.variantStrategy,
  });

  return {
    text,
    hash,
    enabledCategories: enabled,
    referenceCount,
    requiresMask,
    noteJa: notes.join("\n"),
    variantSeedHint: variantSeedHint(spec.variantStrategy, spec.variant),
    templateVersion: TEMPLATE_VERSION,
  };
}

/** 指示文中のラベル。API へ送る文なので英語。 */
function labelEn(id: CategoryId): string {
  switch (id) {
    case "makeup":
      return "Makeup";
    case "background":
      return "Background";
    case "costume":
      return "Outfit";
    case "hair":
      return "Hairstyle";
    case "pose":
      return "Pose";
    case "mood":
      return "Mood";
    case "tattoo_removal":
      return "Masked retouch";
  }
}
