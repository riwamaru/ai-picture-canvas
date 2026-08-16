/**
 * 確定 UI（index.html）の選択肢に対応するテンプレート。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【なぜ別ファイルなのか】
 *
 * templates.ts は PoC（../../../../poc/prompts/templates.ts）からの移植であり、
 * 中身を書き換えると PoC 側との差分が追えなくなる。
 * そこで PoC 由来の定義には触れず、確定 UI の選択肢だけをここに足して
 * templates.ts の TEMPLATES へ連結する。
 *
 * 【instruction の書き方】
 *
 * PoC の既存テンプレートと同じ方針に揃えてある：
 *   - 英語で書く（API へ送る文であるため）
 *   - 「何を変えるか」だけを述べ、「それ以外を保つ」は buildPrompt が後段で付ける
 *   - 人物の造作に触れる語を入れない（本人性の保持は共通制約が担う）
 *
 * ★ 自由入力ではない。ここに無い指示文は API へ届かない
 *   （PoC 実装指示書 2 章 禁止事項②の趣旨をこちらでも保つ）。
 * ═══════════════════════════════════════════════════════════════
 */

import type { CategoryId } from "./categories";
import type { Template } from "./templates";

export const DEMO_TEMPLATES: readonly Template[] = Object.freeze([
  // ── メイク（確定 UI にはメイクのテンプレート選択がある） ──
  Object.freeze({
    id: "makeup.natural_skin",
    categoryId: "makeup" as CategoryId,
    labelJa: "ナチュラル美肌",
    instruction:
      "Makeup style: natural, bare-skin finish. Even out the skin texture with a light matte base, soft neutral-beige eyeshadow, thin natural brows, and a sheer nude-pink lip.",
    noteJa:
      "素肌感のあるナチュラルメイク。軽いマットベースで肌を整え、ニュートラルベージュのアイシャドウ、細めの自然な眉、透け感のあるヌードピンクのリップ。",
  }),
  Object.freeze({
    id: "makeup.party_glam",
    categoryId: "makeup" as CategoryId,
    labelJa: "華やかパーティーメイク",
    instruction:
      "Makeup style: glamorous evening look. Add a luminous base with subtle highlighter, defined smoky eyeshadow with shimmer, winged eyeliner, volumized lashes, and a rich red lip.",
    noteJa:
      "華やかな夜向けメイク。ツヤのあるベースに控えめなハイライト、締め色を効かせたラメ入りスモーキーアイ、跳ね上げアイライン、ボリュームまつげ、深みのある赤リップ。",
  }),
  Object.freeze({
    id: "makeup.korean_trend",
    categoryId: "makeup" as CategoryId,
    labelJa: "トレンド韓国風メイク",
    instruction:
      "Makeup style: Korean trend look. Add a dewy glass-skin base, straight soft brows, coral-pink blush placed high on the cheeks, gradient inner-to-outer lip in coral, and glossy lips.",
    noteJa:
      "韓国風トレンドメイク。みずみずしいツヤ肌ベース、平行のやわらかい眉、頬の高い位置にコーラルピンクのチーク、内側から外へのグラデーションリップ、ツヤのある唇。",
  }),

  // ── 背景 ──
  Object.freeze({
    id: "background.luxury_lounge",
    categoryId: "background" as CategoryId,
    labelJa: "高級ラウンジ",
    instruction:
      "Replace the background with an upscale members' lounge interior: dark wood paneling, marble surfaces, warm indirect lighting, and a shallow depth of field.",
    noteJa:
      "背景を高級ラウンジの内装に差し替える。ダークウッドの壁面、大理石、暖色の間接照明、浅い被写界深度。",
  }),
  Object.freeze({
    id: "background.bright_cafe",
    categoryId: "background" as CategoryId,
    labelJa: "明るいカフェ風",
    instruction:
      "Replace the background with a bright, airy cafe interior lit by soft daylight from large windows, with light wood and plants softly out of focus.",
    noteJa:
      "背景を明るく開放的なカフェの内装に差し替える。大きな窓からのやわらかい自然光、明るい木材と観葉植物をぼかして配置。",
  }),
  Object.freeze({
    id: "background.neon_night",
    categoryId: "background" as CategoryId,
    labelJa: "夜のネオン街",
    instruction:
      "Replace the background with a night street scene lit by colorful neon signage, rendered as soft out-of-focus bokeh.",
    noteJa: "背景を色とりどりのネオンが灯る夜の街に差し替える。光はやわらかいボケとして描く。",
  }),
  Object.freeze({
    id: "background.gothic_studio",
    categoryId: "background" as CategoryId,
    labelJa: "ゴシック調スタジオ",
    instruction:
      "Replace the background with a gothic studio set: deep burgundy velvet drapery, ornate dark frames, and low-key dramatic lighting.",
    noteJa:
      "背景をゴシック調のスタジオセットに差し替える。深いバーガンディのベルベット、装飾的な暗色の額縁、ローキーで劇的な照明。",
  }),

  // ── 衣装 ──
  Object.freeze({
    id: "costume.formal_suit",
    categoryId: "costume" as CategoryId,
    labelJa: "フォーマルスーツ",
    instruction:
      "Change the outfit to a tailored formal suit with clean lines and a conservative neckline.",
    noteJa: "衣装を仕立ての良いフォーマルスーツに変更する。すっきりしたラインで襟元は控えめにする。",
  }),
  Object.freeze({
    id: "costume.casual_shirt",
    categoryId: "costume" as CategoryId,
    labelJa: "カジュアルシャツ",
    instruction:
      "Change the outfit to a relaxed, well-fitted casual shirt in a plain color, worn neatly.",
    noteJa: "衣装を無地のリラックスしたカジュアルシャツに変更する。きちんと着崩さずに着る。",
  }),
  Object.freeze({
    id: "costume.party_dress",
    categoryId: "costume" as CategoryId,
    labelJa: "パーティードレス",
    instruction:
      "Change the outfit to an elegant party dress with a modest neckline and a refined silhouette.",
    noteJa: "衣装を上品なパーティードレスに変更する。襟元は控えめにし、洗練されたシルエットにする。",
  }),
  Object.freeze({
    id: "costume.kimono",
    categoryId: "costume" as CategoryId,
    labelJa: "和装（着物）",
    instruction:
      "Change the outfit to a traditional Japanese kimono worn correctly, with the left panel over the right, a properly tied obi, and a modest collar.",
    noteJa:
      "衣装を伝統的な着物に変更する。左前（左の身頃を上）に正しく着付け、帯を結び、襟元は控えめにする。",
  }),

  // ── 髪型 ──
  Object.freeze({
    id: "hair.soft_waves",
    categoryId: "hair" as CategoryId,
    labelJa: "ゆるふわ巻き髪",
    instruction: "Change the hairstyle to soft, loose waves with natural volume and movement.",
    noteJa: "髪型をゆるくやわらかいウェーブに変更する。自然なボリュームと動きを出す。",
  }),
  Object.freeze({
    id: "hair.straight_long",
    categoryId: "hair" as CategoryId,
    labelJa: "ストレートロング",
    instruction: "Change the hairstyle to sleek, straight long hair with a smooth, glossy finish.",
    noteJa: "髪型をなめらかなストレートロングに変更する。ツヤのある仕上がりにする。",
  }),
  Object.freeze({
    id: "hair.updo_style",
    categoryId: "hair" as CategoryId,
    labelJa: "アップスタイル",
    instruction:
      "Change the hairstyle to a neatly gathered updo, with the hair pinned up and a clean hairline.",
    noteJa: "髪型をきれいにまとめたアップスタイルに変更する。髪を上げて生え際を整える。",
  }),
  Object.freeze({
    id: "hair.half_up",
    categoryId: "hair" as CategoryId,
    labelJa: "ハーフアップ",
    instruction:
      "Change the hairstyle to a half-up style: the upper section gathered at the back, the lower section left down.",
    noteJa: "髪型をハーフアップに変更する。上半分を後ろでまとめ、下は下ろしたままにする。",
  }),

  // ── ポーズ ──
  Object.freeze({
    id: "pose.front_standing",
    categoryId: "pose" as CategoryId,
    labelJa: "正面立ち姿",
    instruction:
      "Change the pose to a standing full-front posture, shoulders square to the camera, arms relaxed at the sides.",
    noteJa: "ポーズを正面向きの立ち姿に変更する。肩をカメラに正対させ、腕は自然に下ろす。",
  }),
  Object.freeze({
    id: "pose.turn_back",
    categoryId: "pose" as CategoryId,
    labelJa: "斜め振り返り",
    instruction:
      "Change the pose to a three-quarter stance with the body angled away and the head turned back toward the camera.",
    noteJa: "ポーズを斜めに構えた振り返りに変更する。体は斜めに向け、顔だけカメラへ戻す。",
  }),
  Object.freeze({
    id: "pose.seated_sofa",
    categoryId: "pose" as CategoryId,
    labelJa: "ソファーに腰掛け",
    instruction:
      "Change the pose to seated on a sofa, upright posture with hands resting naturally.",
    noteJa: "ポーズをソファーに腰掛けた姿に変更する。背筋を伸ばし、手は自然に置く。",
  }),

  // ── 雰囲気 ──
  Object.freeze({
    id: "mood.cinematic_luxury",
    categoryId: "mood" as CategoryId,
    labelJa: "シネマティック（高級感）",
    instruction:
      "Set the overall mood to cinematic and upscale: controlled contrast, slightly desaturated cool shadows, warm key light, and a filmic tonal roll-off.",
    noteJa:
      "全体の雰囲気をシネマティックで高級感のあるものにする。コントラストを抑制し、影は彩度を落とした寒色、キーライトは暖色、階調はフィルム的になだらかに落とす。",
  }),
  Object.freeze({
    id: "mood.soft_cute",
    categoryId: "mood" as CategoryId,
    labelJa: "ふんわり（可愛く）",
    instruction:
      "Set the overall mood to soft and sweet: bright airy exposure, gentle low contrast, warm pastel tones, and diffused lighting.",
    noteJa:
      "全体の雰囲気をふんわりと可愛らしくする。明るく軽い露出、やわらかい低コントラスト、暖色のパステル調、拡散した照明。",
  }),
  Object.freeze({
    id: "mood.cool_stylish",
    categoryId: "mood" as CategoryId,
    labelJa: "クール＆スタイリッシュ",
    instruction:
      "Set the overall mood to cool and stylish: crisp contrast, cool-toned color grading, and clean directional lighting with defined shadows.",
    noteJa:
      "全体の雰囲気をクールでスタイリッシュにする。シャープなコントラスト、寒色寄りのカラーグレーディング、輪郭のはっきりした指向性のある照明。",
  }),

  // ── 除去（確定 UI の「除去対象の種類」に対応） ──
  Object.freeze({
    id: "tattoo_removal.tattoo",
    categoryId: "tattoo_removal" as CategoryId,
    labelJa: "タトゥー・刺青",
    instruction:
      "Within the masked region only, remove the tattoo and reconstruct clean skin that matches the surrounding color, texture, and lighting. Do not alter anything outside the mask.",
    noteJa:
      "マスク領域内のみ、タトゥーを除去し、周囲の肌の色・質感・光の当たり方に合う自然な肌を再構成する。マスク領域外は一切変更しない。",
  }),
  Object.freeze({
    id: "tattoo_removal.scar",
    categoryId: "tattoo_removal" as CategoryId,
    labelJa: "傷跡・アザ",
    instruction:
      "Within the masked region only, remove the scar or bruise and reconstruct clean skin that matches the surrounding color, texture, and lighting. Do not alter anything outside the mask.",
    noteJa:
      "マスク領域内のみ、傷跡やアザを除去し、周囲の肌の色・質感・光の当たり方に合う自然な肌を再構成する。マスク領域外は一切変更しない。",
  }),
  Object.freeze({
    id: "tattoo_removal.accessory",
    categoryId: "tattoo_removal" as CategoryId,
    labelJa: "ピアス・アクセサリー",
    instruction:
      "Within the masked region only, remove the piercing or accessory and reconstruct the underlying skin or fabric so it matches the surrounding color, texture, and lighting. Do not alter anything outside the mask.",
    noteJa:
      "マスク領域内のみ、ピアスやアクセサリーを除去し、その下の肌や布地を周囲に合わせて再構成する。マスク領域外は一切変更しない。",
  }),
  Object.freeze({
    id: "tattoo_removal.background_object",
    categoryId: "tattoo_removal" as CategoryId,
    labelJa: "背景の写り込み物",
    instruction:
      "Within the masked region only, remove the unwanted object and reconstruct the background behind it so it matches the surrounding color, texture, and lighting. Do not alter anything outside the mask.",
    noteJa:
      "マスク領域内のみ、不要な写り込み物を除去し、その背後の背景を周囲に合わせて再構成する。マスク領域外は一切変更しない。",
  }),
]);
