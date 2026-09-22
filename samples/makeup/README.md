# メイクの見本写真（開発時に解析してテンプレートへ起こす）

ここに店舗のメイク見本写真を置いて `npm run makeup:analyze` を実行すると、
Gemini が写真を読んでメイクの指示文（英語）と説明（日本語）を起こし、
`src/lib/vendor/prompts/templates.makeup-samples.ts` に書き出す。
デプロイすると加工画面のメイクカード「テンプレートから選択」に並ぶ。

## ファイル名の規則

```
01_大人ナチュラル.jpg
02_華やかレッドリップ.png
```

- 先頭 2 桁が ID（`makeup.sample_01`）になる。**後から番号を変えない**（記録との対応が切れる）
- `_` のあとが画面に出る名前（40 文字まで）
- JPEG / PNG / WebP

## 手順

1. 写真を置く
2. `npm run makeup:analyze`（1 枚あたり $0.01 未満・約 10 秒）
3. 画面に出る「確認用」の英語と日本語を読み、直したければ `analysis.json` の `instruction` / `noteJa` を直す
4. `npm run makeup:analyze -- --dry-run` で書き出し直す（API は呼ばない）
5. `templates.makeup-samples.ts` をコミットしてデプロイ

写真が同じなら再実行しても API は呼ばれない（`analysis.json` の記録を使う）。
全部解析し直すときは `-- --force`（人が直した文言は上書きされる）。

## 入れないもの

- 写真は git に入れない（`.gitignore` 済み）。人物写真になり得るため
- 写真は生成 API へも送らない。本番に載るのは起こした指示文だけ

---

## 複数の写真から「共通のメイク」を 1 本に起こす（`npm run makeup:style`）

上の `makeup:analyze` は写真 1 枚 → テンプレート 1 つ。
こちらは **多数の写真 → 共通項 1 本**（例: 店舗の投稿写真 121 枚 → 「キャバ嬢風メイク(標準)」）。

```bash
npm run makeup:style -- --dir "/path/to/写真フォルダA" --dir "/path/to/写真フォルダB" --name kyabajo_standard
```

- 写真ごとにメイクの要素を起こし（顔が小さい・隠れている写真は `face_visibility` で除外）、
  最後にもう 1 回モデルへ渡して「個人差を除いた共通のメイク」に統合する
- 記録は `style-analysis.<name>.json`（写真ごとの要素・統合案・費用）。写真は git に入れない
- 費用の目安: 1 枚 $0.003・統合 $0.02（121 枚で $0.37）
- `--dry-run` … API を呼ばず記録から統合案を印字 ／ `--resynth` … 統合だけやり直す ／ `--force` … 全部解析し直す

**このスクリプトは TS を書き出さない。** 統合案を人が読んで直し、
`src/lib/vendor/prompts/templates.demo.ts` のメイク欄に載せる（PoC の S-13 で検証してから）。

### 2026-09-22 の実績: キャバ嬢風メイク(標準)

| 項目 | 値 |
| --- | --- |
| 入力 | 店舗 4 アカウントの投稿写真 121 枚（`メイク変更/メイク参考画像/`） |
| 統合の根拠 | 顔がはっきり写った 84 枚（4 アカウントすべてを含む）。小さい 24・隠れている 12 は除外、1 枚は安全性判定で拒否 |
| 濃さ | 84 枚すべて medium 判定 → 強度「強（medium）」との組み合わせが基準 |
| 人が直した点 | 「porcelain（白い肌）」→「本人の肌色のまま」／人物の印象語（doll-like）を削除 |
| 記録 | `style-analysis.kyabajo_standard.json` |
| 本番 | `templates.demo.ts` の `makeup.kyabajo_standard` |
