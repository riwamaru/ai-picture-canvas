/**
 * マスク変換の能力を表すインターフェース（宣言のみ・実装を持たない）。
 *
 * 【なぜ interface だけをここに置くのか】
 *
 * PoC 実装指示書は EditRequest.maskImage を
 *   「白=再生成 / 黒=保持 のグレースケール PNG」
 * と定義している。一方 OpenAI の /v1/images/edits は
 *   「alpha チャンネルが編集対象を示す RGBA PNG」
 * を要求する（公式ドキュメント）。この変換はプロバイダ固有の知識なので
 * 本来アダプタの責務だが、変換には PNG のデコード・エンコードが必要で、
 * それは sharp に依存する。
 *
 * ところが指示書 4 章は providers/ 配下への画像処理の混入を禁じており、
 * eslint.config.mjs も providers/ からの sharp の import を落とす。
 *
 * そこで「何が必要か」の宣言だけをこの層に置き、実装（runner/image/mask.ts）を
 * createProvider() で注入する。これにより：
 *   - 変換の意味づけ（どちらの色が編集対象か）はアダプタ内に残る
 *   - sharp への依存は runner 側に留まる
 *   - 本実装へ移設する際、注入先を差し替えるだけで済む
 */

/** マスクの色の意味。config/models.json の maskSemantics に対応する。 */
export type MaskSemantics =
  /** alpha = 0（透明）の領域が編集対象。OpenAI 公式ドキュメントの記述。 */
  | "alpha_zero_is_edited"
  /** 白い領域が編集対象。グレースケールのまま送る。二次情報が述べる挙動。 */
  | "white_is_edited"
  /** マスク入力に対応しない（Google）。 */
  | "unsupported";

export interface MaskCodec {
  /**
   * 「白=再生成 / 黒=保持」のグレースケール PNG を、
   * 「alpha = 0 の領域が編集対象」の RGBA PNG へ変換する。
   *
   * 白（=再生成したい領域）を透明にし、黒（=保持したい領域）を不透明にする。
   * RGB 値には元画像ではなくマスクの階調をそのまま置く（API は alpha のみを見る）。
   */
  toAlphaMask(grayscaleMaskPng: Uint8Array): Promise<Uint8Array>;

  /** PNG / JPEG のサイズを読む。マスクと元画像の解像度一致検査に使う。 */
  probeSize(image: Uint8Array): Promise<{ width: number; height: number }>;
}

/**
 * マスク未対応のプロバイダへ注入するダミー。
 * 呼ばれたら設計上の誤りなので、静かに動くのではなく落とす。
 */
export const NO_MASK_CODEC: MaskCodec = {
  toAlphaMask() {
    return Promise.reject(
      new Error("このプロバイダはマスク編集に対応していません（MaskCodec が注入されていません）"),
    );
  },
  probeSize() {
    return Promise.reject(new Error("MaskCodec が注入されていません"));
  },
};
