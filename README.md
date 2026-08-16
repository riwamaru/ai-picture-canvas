# AI Canvas 体験用デモ環境（Vercel + Supabase）

**他の人が、自分の写真で試せるようにするための共有環境。**
ローカルの PoC 測定システム（[`../poc`](../poc)）とは別物であり、記録も API キーも分離してある。

---

## ⚠️ 最初に読む：なぜ PoC と分けたのか

`../poc` の `npm run studio` は、**任意画像のアップロードを意図的に受け付けない**。
[`poc/runner/studio.ts`](../poc/runner/studio.ts) の冒頭にそう書いてある（関所①隔離／PoC 実装指示書 3.2）:

> 素材はマニフェストに申告済みのものだけを扱う。ブラウザからの任意ファイルのアップロードは受け付けない。
> 受け付けると、権利区分が申告されていない画像が API へ渡る経路になる。

「他の人が任意の画像で試せる」ようにするということは、この前提を外すということである。
そこで **PoC の設計を緩めるのではなく、別環境を立てた。** 具体的には：

| PoC が持っていた担保 | デモ環境での代替 |
| --- | --- |
| マニフェストの `rights` 区分 | アップロード者の同意チェック（`jobs.rights_confirmed` に記録） |
| `127.0.0.1` のみ待ち受け | Supabase Auth の招待制（招待外は DB のトリガが拒否） |
| 起動時に人が `--max-images` を宣言 | `demo_limits` テーブル（利用者ごと／日次の上限） |
| プロセス内のカウンタ | `reserve_generation()` の行ロック（サーバーレスでも守れる） |
| `output/*/results.jsonl` | `jobs` テーブル（**PoC の記録には混ぜない**） |

**記録を混ぜていないことが重要である。** 混ぜると、判定基準の封印済みの母数（T-01 の 10 名）に
任意画像の試行が入り込み、`config/criteria.json` の判定が意味を失う。

そのまま引き継いだものもある：

- **プロンプト構築**（`src/lib/vendor/prompts/`）— PoC と同一。テンプレート版数 `v3`。
- **プロバイダ層**（`src/lib/vendor/providers/`）— 送信先ホストの allowlist もそのまま。
- **禁止事項②（安全性判定の限界を探る入力をしない）** — **自由入力欄を作っていない。**
  選べるのは `Object.freeze` された `TEMPLATES` の中身だけ。任意の画像は受け付けるが、任意のテキストは受け付けない。
- **再試行・フォールバックを実装しない**（指示書 4 章）— 1 回呼んで失敗したら分類して記録するだけ。

---

## 構成

```
ブラウザ ──> Vercel（Next.js）──> OpenAI  gpt-image-2
                  │
                  └──> Supabase（Postgres / Storage / Auth）
```

- **API キーはブラウザへ渡らない。** 生成はすべて `/api/generate`（サーバー側）を通る。
- **画像バケットは非公開。** 閲覧は 1 時間の署名付き URL でのみ行う。

| ファイル | 役割 |
| --- | --- |
| [`src/app/api/generate/route.ts`](src/app/api/generate/route.ts) | 生成の唯一の入口。検証 → 上限確認 → 1 回呼ぶ → 記録 |
| [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) | スキーマ・RLS・ブレーキ（`reserve_generation`） |
| [`src/components/MaskCanvas.tsx`](src/components/MaskCanvas.tsx) | マスク描画 |
| [`src/lib/mask.ts`](src/lib/mask.ts) | マスクの正規化と alpha 変換（PoC の `sharpMaskCodec` 相当） |
| [`src/lib/vendor/`](src/lib/vendor) | PoC から移植した層。**PoC 側で仕様が確定したらここも揃えること** |

---

## 上限（ブレーキ）

すべて `public.demo_limits` の 1 行で決まる。**再デプロイなしで変更できる。**

| 項目 | 既定値 | 列名 |
| --- | --- | --- |
| 緊急停止 | 稼働中 | `enabled` |
| 日次予算 | $5.00 | `daily_budget_usd` |
| 日次の枚数 | 60 枚 | `daily_max_images` |
| 全体の呼び出し間隔 | 10 秒 | `global_min_interval_ms` |
| 1 人あたりの呼び出し間隔 | 60 秒 | `user_min_interval_ms` |
| 1 人あたりの枚数 | 招待時に指定（既定 10 枚） | `profiles.max_images` |

1 枚あたりの実費は約 **$0.083**（1024×1536・quality medium）。$5 でおよそ 60 枚。

**全部止めたいとき**（Supabase の SQL Editor で実行）:

```sql
update public.demo_limits set enabled = false;
```

**検証済み。** 8 通りすべてが実際に止まることを確認してある
（全体間隔・個人間隔・個人の枚数・日次枚数・日次予算・緊急停止・招待外の拒否・未招待のサインアップ拒否）。

---

## セットアップ

### 1. Supabase（作成済み）

- プロジェクト: **ai-canvas-demo** (`fxhwiyaqhluayrknhpvi` / ap-northeast-1)
- スキーマ・RLS・Storage バケットは適用済み。

### 2. 環境変数

`.env.example` をコピーして `.env.local` を作り、次の 2 つを埋める。

| 変数 | 取得先 |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase ダッシュボード → Project Settings → API Keys → `service_role` |
| `OPENAI_API_KEY` | **デモ専用に新規発行したキー**（PoC 用と分ける） |

> **なぜキーを分けるのか**
> 同じキーだと、デモの利用が PoC の日次予算 $11.11 を食う。
> 「PoC にいくらかかったか」は測定対象そのもの（A-4）なので、混ざると測れなくなる。

### 3. ローカルで動かす

```bash
npm install
```

```bash
npm run dev
```

### 4. Vercel へデプロイ

Vercel CLI は未インストールなので `npx` で使う。ログインはブラウザが開く。

```bash
npx vercel login
```

```bash
cd demo && npx vercel link
```

環境変数を 4 つ登録する（`vercel env add` は値を対話で聞いてくる）:

```bash
npx vercel env add NEXT_PUBLIC_SUPABASE_URL production
```

```bash
npx vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
```

```bash
npx vercel env add SUPABASE_SERVICE_ROLE_KEY production
```

```bash
npx vercel env add OPENAI_API_KEY production
```

```bash
npx vercel env add ADMIN_EMAILS production
```

本番へ出す:

```bash
npx vercel --prod
```

### 5. デプロイ後に必ず行う設定

**Supabase ダッシュボード → Authentication → URL Configuration**

- **Site URL** に Vercel の本番 URL（`https://....vercel.app`）を入れる
- **Redirect URLs** に `https://....vercel.app/auth/callback` を追加する

これをしないと、メールのログインリンクが `localhost` へ飛んで動かない。

---

## 招待のしかた

`ADMIN_EMAILS` に載っているアドレスでログインすると、`/admin` が開ける。
メールアドレスと上限枚数を入れて「招待する」を押す。

**「パスワードを発行する」を推奨する。**
Supabase の組み込みメール送信には厳しい回数制限がある（既定で 1 時間に数通）。
独自 SMTP（Resend・SendGrid 等）を設定するまでは、パスワードを発行して直接伝えるほうが確実である。

招待は 2 段構えになっていて、片方だけでは入れない：

1. `allowed_emails` へ登録（DB のトリガが、載っていないアドレスの作成を拒否する）
2. Auth のユーザーを作成（ログイン画面は `shouldCreateUser: false` で動く）

---

## 利用者から見た流れ

1. 招待されたアドレスでログイン
2. 写真を選ぶ
3. メイクの強さ（必須）と、変えたいカテゴリ・テンプレートを選ぶ
4. タトゥー除去を選んだ場合は、消したい部分をブラシで塗る
5. 「本人の同意を得た写真である」にチェック（**外すと送信できない**）
6. 「この内容で 1 枚つくる」→ 最大 3 分ほどで結果が出る

失敗したときは理由が 3 分類（`policy` / `input` / `infra`）で表示される。PoC の `results.jsonl` と同じ分類なので、
デモで観測した拒否をそのまま PoC の分類表（[`../poc/docs/provider-error-map.md`](../poc/docs/provider-error-map.md)）へ持ち込める。

**失敗時の枚数の返却**:

| 失敗の種類 | 枚数 | コスト |
| --- | --- | --- |
| `infra`（こちら側の障害） | 返す | 返す |
| `policy`（安全性判定による拒否） | **返さない** | 返す |
| `input`（送信内容の不備） | **返さない** | 返す |

`policy` で返さないのは、禁止事項③（拒否された内容を文言を変えて再投入しない）の趣旨による。
返すと、拒否されるまで何度でも押せることになる。

---

## 残っている作業

| # | 内容 |
| --- | --- |
| 1 | `SUPABASE_SERVICE_ROLE_KEY` と `OPENAI_API_KEY`（デモ専用）の設定 |
| 2 | Vercel へのデプロイと、Supabase の Site URL / Redirect URLs 設定 |
| 3 | 実 API を 1 回通しての疎通確認（キー設定後でないと行えない） |
| 4 | 独自 SMTP の設定（メールのログインリンクを常用する場合） |
| 5 | PoC 側で `maskSemantics` が実測確定したら [`src/lib/models.ts`](src/lib/models.ts) を揃える |
