/**
 * 同一条件 2 枚のバリエーション方式。
 *
 * 機能仕様書 4.2.4（未確定・区分 A-2）に 2 案が併記されており、
 * どちらを採用するかは PoC（T-03）で決める。
 *
 * ★ 本実装では VariantStrategy として移設する。
 *   機能仕様書 4.2.4：「採用案はプロバイダ抽象化レイヤー側で吸収し、
 *   モデルごとの差異がアプリケーションコードへ漏れない構成とする」
 */

/**
 * - identical   … 案 1：同一のプロンプトを 2 回実行する
 * - micro_delta … 案 2：表情・構図・照明に軽微な差分指示を付与する
 */
export const VARIANT_STRATEGIES = ["identical", "micro_delta"] as const;
export type VariantStrategy = (typeof VARIANT_STRATEGIES)[number];

export type VariantIndex = 1 | 2;

/**
 * 案 2 の差分指示。
 *
 * ★ 乱択しない。固定の 2 セットとする。
 *   毎回変わると同じ条件での再実行ができず、S-06 との比較が成立しない。
 *
 * ★ 機能仕様書 4.2.4：
 *   「いずれの案でも、メイク強度・背景・衣装・髪型・ポーズなど、
 *     本来比較したい条件は変更してはならない」
 *   よってここで触れるのは表情・向き・照明の 3 点だけに限る。
 *   ポーズは種別 B のカテゴリとして別に指定されるため、ここでは扱わない。
 */
const MICRO_DELTAS: Readonly<Record<VariantIndex, { instruction: string; noteJa: string }>> =
  Object.freeze({
    1: Object.freeze({
      instruction:
        "Expression: a natural, gentle smile. Head angle: facing nearly straight toward the camera. Lighting: soft and diffused.",
      noteJa: "表情は自然な微笑み。顔の向きはほぼ正面。照明はやわらかく拡散した光。",
    }),
    2: Object.freeze({
      instruction:
        "Expression: calm and composed, lips closed. Head angle: turned slightly to one side. Lighting: slightly brighter with a little more contrast.",
      noteJa:
        "表情は落ち着いた口を閉じた表情。顔の向きはわずかに斜め。照明はやや明るくコントラストを少し強める。",
    }),
  });

/**
 * バリエーションごとの追加指示を返す。
 *
 * @returns 案 1 では null（プロンプトに何も足さない）
 */
export function variantInstruction(
  strategy: VariantStrategy,
  variant: VariantIndex,
): { instruction: string; noteJa: string } | null {
  if (strategy === "identical") return null;
  return MICRO_DELTAS[variant];
}

/**
 * seed ヒント。
 *
 * 【現状】OpenAI（gpt-image-2）も Google（gemini-3-pro-image）も seed 指定に対応しない。
 * よってこの値は実質的に使われない。
 * 機能仕様書 4.2.4 が「seed を指定できないモデルが存在するため、
 * seed 制御を前提とした共通仕様にはしない」としているのは正しかった。
 *
 * それでも値を作って渡すのは、ヒントを無視した事実を
 * variantSeedHintApplied: false として記録に残し、
 * 「案 1 の差分がモデル固有のゆらぎのみに依存している」ことを
 * 後から説明できるようにするため。
 */
export function variantSeedHint(strategy: VariantStrategy, variant: VariantIndex): string {
  return `${strategy}#${variant}`;
}

export function isVariantStrategy(value: string): value is VariantStrategy {
  return (VARIANT_STRATEGIES as readonly string[]).includes(value);
}
