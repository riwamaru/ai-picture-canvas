/**
 * 実運用の指示テンプレートの原型。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 【規範】このカタログを編集する人へ
 *
 * 本カタログは、実運用で店舗スタッフが画面から選ぶ選択肢の写しである。
 *
 * PoC 実装指示書 2 章 禁止事項②：
 *   「拒否率の計測は、実運用で想定される指示テンプレートのみを用いて行う。
 *     安全性判定の限界を探る目的での入力（際どい表現を試す、フィルタを
 *     回避する言い換えを試す等）は行わない。計測したいのは
 *     『通常業務でどれくらい弾かれるか』であって、フィルタの穴ではない。」
 *
 * したがって、以下を追加してはならない：
 *   × 安全性判定の限界を探る目的の文言
 *   × フィルタ回避を意図した言い換え
 *   × 実運用のスタッフが選ばないような特殊な表現
 *
 * また、拒否されたテンプレートの文言を変えて再投入してはならない（禁止事項③）。
 * runner/guard.ts の assertNoPolicyReword() が機械的に検出して中断する。
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 【指示文を英語にしている理由】
 * 画像編集モデルの指示追従は英語のほうが安定する。本 PoC の第一の測定対象は
 * T-01（本人性が保たれるか）であり、そこにプロンプト言語という別の変数を
 * 混ぜたくない。日本語話者が内容を監査できるよう noteJa に等価な説明を置く
 * （機能仕様書 4.5.3「提示する表現をあらかじめ自社で検証・管理できる」に対応）。
 * 拒否率に不自然な偏りが出た場合は、言語も見直す変数として扱う。
 *
 * ★ 本実装へ移設する層。依存を持たない。
 */

import type { CategoryId, MakeupStrength } from "./categories";
import { DEMO_TEMPLATES } from "./templates.demo";

export type Template = {
  readonly id: string;
  readonly categoryId: CategoryId;
  /** 画面に出す選択肢名（店舗スタッフが見る文字列）。 */
  readonly labelJa: string;
  /** API へ送る指示文。 */
  readonly instruction: string;
  /** instruction と等価な日本語の説明。監査用であり API へは送らない。 */
  readonly noteJa: string;
};

/**
 * 全体に必ず付与する制約。
 *
 * 本システムの中核は「本人性を保ったままの画像編集」であり（機能仕様書 1.1）、
 * 本人性の保持は「プロダクトとして成立するための最低条件」である。
 * したがって全カテゴリ共通で、顔の造作を変えないことを毎回明示する。
 */
export const IDENTITY_GUARD_INSTRUCTION =
  "Edit the provided photograph of this person. Preserve the person's facial identity exactly: " +
  "keep the same face shape, jawline, eye shape and spacing, nose, mouth, and skin tone. " +
  "Do not replace the person, do not beautify or reshape facial features, and do not change age or body proportions. " +
  "The result must be recognizable as the same individual. " +
  // ★ 「宣材写真を出力せよ」で終えると、モデルは撮り直しの依頼と解釈する。
  //   2026-08-16 の実測では、姿勢・画角どころか衣装と背景まで変わった
  //   （黒いドレス＋寝室 → スーツ＋書棚）。編集であることを明示して閉じる。
  "Return the same photograph with only the specified edits applied.";

export const IDENTITY_GUARD_NOTE_JA =
  "元画像の人物を編集する。顔の造作（輪郭・目の形と間隔・鼻・口・肌の色）を厳密に保持し、" +
  "人物の差し替え・美化・造作の変形・年齢や体型の変更を行わない。" +
  "同一人物と判別できること。指定した編集だけを適用し、元の写真をそのまま返す。";

/**
 * 変更しないものを明示するための語。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【なぜ必要か — 2026-08-16 の実測】
 *
 * 従来は「有効なカテゴリの指示を並べる」だけで、**無効なカテゴリについて
 * 「変えるな」と言っていなかった。** 仕様書 2.2・B-1 は無効カテゴリの情報を
 * 送らないことを求めており、それは守っていたが、
 * 「送らない」と「変えないよう指示する」は別である。
 *
 * その結果、S-01（メイクのみ変更）で次が起きた。
 *
 *   3 枚とも姿勢・画角が変わった
 *   1 枚は衣装と背景まで変わった（黒いドレス＋寝室 → スーツ＋書棚）
 *
 * モデルは「元画像を参考にした宣材写真の生成」として扱っていた。
 * シナリオ定義（メイクのみ変更）と食い違う。
 * ═══════════════════════════════════════════════════════════════
 */
export const PRESERVE_PHRASES: Readonly<Record<CategoryId, string>> = Object.freeze({
  makeup: "the existing makeup",
  background: "the background, setting, and everything behind the person",
  costume: "the clothing, garments, and accessories",
  hair: "the hairstyle, hair length, and hair color",
  // 構図はポーズカテゴリに含める。ポーズ変更が有効なときだけ動かしてよい。
  pose: "the pose, body position, framing, crop, camera angle, and distance",
  mood: "the lighting, color grading, and overall atmosphere",
  tattoo_removal: "any tattoos, marks, or blemishes on the skin",
});

export const PRESERVE_PHRASES_JA: Readonly<Record<CategoryId, string>> = Object.freeze({
  makeup: "現在のメイク",
  background: "背景・空間・人物の後ろにあるもの",
  costume: "衣装・小物",
  hair: "髪型・髪の長さ・髪色",
  pose: "姿勢・体の向き・画角・トリミング・カメラ位置・距離",
  mood: "照明・色調・全体の雰囲気",
  tattoo_removal: "肌のタトゥー・傷・シミ",
});

/**
 * テンプレートの版数。
 *
 * プロンプト本文を変えると promptHash が変わり、過去の記録と比較できなくなる。
 * 版数を記録に残して「どの版で測った結果か」を後から追えるようにする。
 *
 * v1 … 初版
 * v2 … 2026-08-16。無効カテゴリの保持を明示し、「宣材写真を出力せよ」で
 *      終える文を「指定した編集だけを適用して同じ写真を返せ」に変更した。
 *      → 構図は保たれたが（平均画素差 95.7 → 3.0）、**何も変わらなくなった**。
 *        顔を拡大してもメイクが適用されていない。保持の指示を先に長く置いたため、
 *        モデルが最も安全な行動＝そのまま返す、を選んだと考えられる。
 * v3 … 2026-08-16。並び順を変更。「何を変えるか」を先頭に、「それ以外は保つ」を
 *      後に、本人性の保持を最後に置く。変更内容には
 *      「結果にはっきり見えていること」を付ける。
 */
export const TEMPLATE_VERSION = "v3";

/** メイク強度ごとの指示。6 枚の差異を作る 1 つ目の軸（機能仕様書 2.2.2）。 */
export const MAKEUP_STRENGTH_TEMPLATES: Readonly<
  Record<MakeupStrength, { instruction: string; noteJa: string }>
> = Object.freeze({
  weak: Object.freeze({
    instruction:
      "Apply light, natural makeup: sheer base, soft neutral eyeshadow, thin eyeliner, and a subtle lip tint.",
    noteJa:
      "薄付きの自然なメイク。ベースは軽く、ニュートラルなアイシャドウ、細いアイライン、控えめなリップ。",
  }),
  medium: Object.freeze({
    instruction:
      "Apply moderate, polished makeup: even base, defined eyeshadow with soft gradation, clear eyeliner, groomed brows, and a clear lip color.",
    noteJa:
      "中程度の整ったメイク。均一なベース、グラデーションのあるアイシャドウ、明確なアイライン、整えた眉、はっきりしたリップ。",
  }),
  strong: Object.freeze({
    instruction:
      "Apply strong, glamorous evening makeup: full coverage base, deep shimmering eyeshadow, pronounced eyeliner and lashes, contoured cheeks, and a vivid lip color.",
    noteJa:
      "濃いめの華やかな夜向けメイク。カバー力のあるベース、深みとツヤのあるアイシャドウ、強調したアイラインとまつげ、シェーディング、鮮やかなリップ。",
  }),
});

/**
 * カテゴリ別のテンプレートカタログ。
 * Object.freeze により実行時の書き換えを防ぐ（テンプレートが動的に変わると監査できない）。
 */
export const TEMPLATES: readonly Template[] = Object.freeze([
  // ── 背景（種別 B・参考画像あり） ──
  Object.freeze({
    id: "background.studio_gray",
    categoryId: "background" as CategoryId,
    labelJa: "スタジオ（グレー背景）",
    instruction:
      "Replace the background with a clean seamless studio backdrop in neutral gray, evenly lit, with no props or text.",
    noteJa:
      "背景をニュートラルグレーのシームレスなスタジオ背景に差し替える。均一な照明。小物や文字は入れない。",
  }),
  Object.freeze({
    id: "background.interior_lounge",
    categoryId: "background" as CategoryId,
    labelJa: "店内ラウンジ風",
    instruction:
      "Replace the background with an elegant, softly lit lounge interior with warm indirect lighting and a shallow depth of field.",
    noteJa:
      "背景を上品でやわらかい照明のラウンジ内装に差し替える。暖色の間接照明、浅い被写界深度。",
  }),
  Object.freeze({
    id: "background.night_city_bokeh",
    categoryId: "background" as CategoryId,
    labelJa: "夜景ボケ",
    instruction:
      "Replace the background with a night cityscape rendered as soft out-of-focus bokeh lights.",
    noteJa: "背景を夜の街並みのボケ光に差し替える。",
  }),

  // ── 衣装（種別 B・参考画像あり） ──
  Object.freeze({
    id: "costume.formal_dress",
    categoryId: "costume" as CategoryId,
    labelJa: "フォーマルドレス",
    instruction:
      "Change the outfit to an elegant, modest formal evening dress with clean lines. Keep the neckline conservative.",
    noteJa: "衣装を上品で露出の少ないフォーマルなイブニングドレスに変更する。襟元は控えめにする。",
  }),
  Object.freeze({
    id: "costume.business_casual",
    categoryId: "costume" as CategoryId,
    labelJa: "きれいめカジュアル",
    instruction:
      "Change the outfit to neat business-casual attire: a well-fitted blouse with a tailored jacket.",
    noteJa:
      "衣装をきれいめのビジネスカジュアルに変更する。体に合ったブラウスとテーラードジャケット。",
  }),
  Object.freeze({
    id: "costume.seasonal_knit",
    categoryId: "costume" as CategoryId,
    labelJa: "季節物（ニット）",
    instruction: "Change the outfit to a soft, well-fitted knit top in a muted seasonal color.",
    noteJa: "衣装を落ち着いた季節色のやわらかいニットトップスに変更する。",
  }),

  // ── 髪型（種別 B・参考画像あり） ──
  Object.freeze({
    id: "hair.long_straight",
    categoryId: "hair" as CategoryId,
    labelJa: "ロングストレート",
    instruction:
      "Change the hairstyle to long, straight, glossy hair falling past the shoulders. Keep the natural hairline and the same hair color unless a reference image indicates otherwise.",
    noteJa:
      "髪型を肩より長いツヤのあるロングストレートに変更する。生え際は自然に保ち、参考画像の指定が無ければ髪色は変えない。",
  }),
  Object.freeze({
    id: "hair.loose_curls",
    categoryId: "hair" as CategoryId,
    labelJa: "ゆるふわカール",
    instruction:
      "Change the hairstyle to soft loose curls with volume around the shoulders. Keep the natural hairline.",
    noteJa: "髪型を肩まわりにボリュームのあるゆるいカールに変更する。生え際は自然に保つ。",
  }),
  Object.freeze({
    id: "hair.updo",
    categoryId: "hair" as CategoryId,
    labelJa: "アップスタイル",
    instruction:
      "Change the hairstyle to a neat updo with a few loose strands framing the face. Keep the natural hairline.",
    noteJa:
      "髪型を顔まわりに少し毛束を残した清潔感のあるアップスタイルに変更する。生え際は自然に保つ。",
  }),

  // ── ポーズ（種別 B・参考画像あり） ──
  Object.freeze({
    id: "pose.standing_front",
    categoryId: "pose" as CategoryId,
    labelJa: "正面立ち",
    instruction:
      "Adjust the pose to a relaxed standing posture facing the camera, shoulders level, hands resting naturally.",
    noteJa: "ポーズをカメラ正面のリラックスした立ち姿に調整する。肩は水平、手は自然に下ろす。",
  }),
  Object.freeze({
    id: "pose.seated_three_quarter",
    categoryId: "pose" as CategoryId,
    labelJa: "斜め座り",
    instruction:
      "Adjust the pose to a seated posture turned three-quarters toward the camera, with an upright back.",
    noteJa: "ポーズをカメラに対して斜め 45 度の座り姿に調整する。背筋は伸ばす。",
  }),
  Object.freeze({
    id: "pose.upper_body_closeup",
    categoryId: "pose" as CategoryId,
    labelJa: "上半身寄り",
    instruction:
      "Reframe to an upper-body composition from the chest up, keeping the head fully in frame.",
    noteJa: "構図を胸から上の上半身寄りにする。頭部は画面内に収める。",
  }),

  // ── 雰囲気（種別 A・指示のみ） ──
  Object.freeze({
    id: "mood.bright_clean",
    categoryId: "mood" as CategoryId,
    labelJa: "明るく清潔感",
    instruction:
      "Set the overall mood to bright and clean: soft even lighting, high key, neutral white balance.",
    noteJa:
      "全体の雰囲気を明るく清潔感のあるものにする。やわらかく均一な照明、ハイキー、ニュートラルなホワイトバランス。",
  }),
  Object.freeze({
    id: "mood.warm_calm",
    categoryId: "mood" as CategoryId,
    labelJa: "落ち着いた暖色",
    instruction:
      "Set the overall mood to warm and calm: gentle warm lighting with soft shadows and low contrast.",
    noteJa: "全体の雰囲気を落ち着いた暖色にする。やわらかい暖色照明、緩やかな影、低コントラスト。",
  }),
  Object.freeze({
    id: "mood.cool_elegant",
    categoryId: "mood" as CategoryId,
    labelJa: "クールで上品",
    instruction:
      "Set the overall mood to cool and elegant: slightly cool white balance, controlled contrast, refined highlights.",
    noteJa:
      "全体の雰囲気をクールで上品にする。やや寒色寄りのホワイトバランス、抑えたコントラスト、整ったハイライト。",
  }),

  // ── タトゥー除去（種別 C・マスク指定） ──
  // 機能仕様書 F-15：「ユーザーが指定したマスク領域のみを修復する。マスク外の領域は変更しない」
  Object.freeze({
    id: "tattoo_removal.skin_restore",
    categoryId: "tattoo_removal" as CategoryId,
    labelJa: "肌を自然に復元",
    instruction:
      "Within the masked region only, remove the tattoo and reconstruct clean, natural skin that matches the surrounding skin tone, texture, and lighting. " +
      "Do not modify anything outside the masked region. Do not alter the face, hair, clothing, or background.",
    noteJa:
      "マスク領域内のみ、タトゥーを除去し、周囲の肌の色・質感・光の当たり方に合う自然な肌を再構成する。" +
      "マスク領域外は一切変更しない。顔・髪・衣装・背景を変えない。",
  }),
]);

/** カテゴリの既定テンプレート（シナリオ定義が明示しない場合に使う）。 */
export const DEFAULT_TEMPLATE_ID: Partial<Record<CategoryId, string>> = Object.freeze({
  background: "background.studio_gray",
  costume: "costume.formal_dress",
  hair: "hair.long_straight",
  pose: "pose.standing_front",
  mood: "mood.bright_clean",
  tattoo_removal: "tattoo_removal.skin_restore",
});

/**
 * ★ デモ環境での追加分（PoC には無い）。
 *
 * 確定 UI（index.html）の選択肢は、PoC が用意したカタログとは別物である。
 * 上の TEMPLATES は PoC からの移植なのでそのまま残し、
 * 確定 UI 側の選択肢を templates.demo.ts に置いて、ここで連結する。
 * 検索・検証（requireTemplate）は両方を対象にする。
 */
const ALL_TEMPLATES: readonly Template[] = Object.freeze([...TEMPLATES, ...DEMO_TEMPLATES]);

const BY_ID = new Map(ALL_TEMPLATES.map((t) => [t.id, t]));

export function findTemplate(id: string): Template | undefined {
  return BY_ID.get(id);
}

/**
 * テンプレートを取得する。存在しない ID は黙って無視せず落とす
 * （プロンプトから条件が静かに抜け落ちるのを防ぐ）。
 */
export function requireTemplate(id: string): Template {
  const template = BY_ID.get(id);
  if (!template) {
    throw new Error(
      `[PROMPT] 未登録のテンプレート ID です: ${id}\n` +
        `         prompts/templates.ts の TEMPLATES に定義を追加してください。`,
    );
  }
  return template;
}

export function templatesForCategory(categoryId: CategoryId): readonly Template[] {
  return ALL_TEMPLATES.filter((t) => t.categoryId === categoryId);
}

/** 指示テンプレート一式（S-11 の拒否率計測で全テンプレートを通すために使う）。 */
export function allTemplateIds(): readonly string[] {
  return ALL_TEMPLATES.map((t) => t.id);
}
