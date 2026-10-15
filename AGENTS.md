# AGENTS.md

## 概要

Cloudflare の無料枠で動く一人用 Markdown wiki。
1 つの Hono の Worker が API を提供し、Static Assets として Vite/React の SPA を配信する。
データは D1 と R2 に置き、AI エージェントが REST と MCP から読み書きする。
利用者向けの説明は [README.md](./README.md) にある。

pnpm workspace の構成で、アプリは `apps/*`、共有パッケージは `packages/*` に置く。

- `apps/worker`: Hono の Worker（REST の `/api/*` と MCP の `/mcp`）、D1 の migration、デプロイ、token の発行、派生データの作り直し、リンクの書き換え、バックアップのスクリプト
- `apps/web`: Vite/React の SPA（E2E は `apps/web/e2e`）
- `packages/domain`: title の正規化と Result 型など、実行環境に依存しない規則
- `packages/markdown`: Markdown の解析（wikilink、タグ、frontmatter の抽出、差分など）
- `packages/editor`: CodeMirror 6 の Live Preview エディタ（React に依存しない）

## ドキュメント

運用の手順は `docs/` にある。
該当する作業のときに読む。

- [docs/deploy.md](./docs/deploy.md): 初回のデプロイ、任意の機能（owner のログイン、R2、OAuth、Cron）の設定、ゾーンの WAF やレート制限と併用するときの注意、本番の更新、前の版に戻すときの注意
- [docs/operations.md](./docs/operations.md): API token、派生データの作り直し、リンクの書き換え、バックアップと復元
- [docs/attachments.md](./docs/attachments.md): 添付（R2）の API と公開範囲

## コマンド

Node は 22 系、パッケージマネージャーは pnpm（バージョンは `package.json` の `packageManager`）。

```sh
pnpm install
pnpm lint          # biome check と CSS の直書きの検査
pnpm format        # biome check --write
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest run
```

`packages/editor` と `apps/web` の部品のテストは Playwright の Chromium の中で動く。
初回は `pnpm --filter @personal-wiki/editor exec playwright install chromium` でブラウザを入れる。

### E2E

E2E は `pnpm test` に含めず、別に実行する。
web を build し、一時の D1 で `wrangler dev` を起動して、owner の cookie を作って入る。
`apps/worker/.dev.vars` は読まない。
初回は `pnpm --filter @personal-wiki/web exec playwright install chromium webkit firefox` でブラウザを入れる。

E2E の build は `apps/web/dist` を上書きするので、8787 で動かしている開発の `wrangler dev` の画面もその版に変わる。
web のソースを前の build から変えていなければ、`E2E_SKIP_BUILD=1 pnpm e2e` で build を省ける。
E2E のポートは既定で 8790（inspector は 9339）。
別の worktree の E2E と同時に流すときは `E2E_PORT=8800 pnpm e2e` のように変える。
`pnpm e2e:full` と `pnpm e2e:sheet` も同じサーバーを起動するので、`apps/web/dist` の上書き、`E2E_SKIP_BUILD`、`E2E_PORT` は `pnpm e2e` と同じに働く。

`pnpm e2e` は主の環境（デスクトップの Chromium と iPhone の WebKit）だけを走らせる。
従の環境（Firefox、Android の Chromium、デスクトップの WebKit）の smoke と速さの計測（`apps/web/e2e/perf-budget.json` の予算）は `pnpm e2e:full` だけが走らせる。
CI は E2E を流さないので、master に取り込む前と push の前に `pnpm e2e:full` を流す。

```sh
pnpm e2e                    # apps/web/e2e のテスト（主の環境）。結果は apps/web/e2e-output/（gitignore 済み）
pnpm e2e:full               # 全部の環境と速さの計測
pnpm e2e e2e/notices.spec.ts  # ファイルを絞る。--last-failed、--only-changed も渡せる
pnpm e2e:sheet [--out <dir>]  # 画面の一覧（明暗 × 幅 375、768、1280）を 1 枚の HTML にする
```

### Worker

Worker の開発とデプロイは `apps/worker` で実行する。
`--remote` は本番（`deploy.env` のデプロイ先）、付けないとローカルが対象になる。

```sh
pnpm db:migrate         # ローカルの D1 に migration を適用
pnpm dev                # apps/web を build してから wrangler dev
pnpm deploy:remote      # deploy.env から設定を合成してデプロイ
pnpm db:migrate:remote  # 本番の D1 に migration を適用
pnpm api-token issue <name> --scopes read|read,write [--remote]
pnpm api-token revoke <name> [--remote]
pnpm derived:rebuild [--remote]  # 全ページの派生データを作り直す
pnpm link-rewrites [--remote] [--target <page id>]  # title の変更で待っているリンクの書き換えを最後まで進める
pnpm backup [--remote] [--out <dir>] [--with-tokens]  # D1 の本文を SQL のダンプにして手元に残す
pnpm backup load <dir> [--remote]  # ダンプを新しい D1 に流し込む
```

`derived:rebuild` と `link-rewrites` は、環境変数 `WIKI_TOKEN` から write の token を読む。
平文をコマンド行に書くとシェルの履歴に残るので、`read -rs WIKI_TOKEN && export WIKI_TOKEN` で入れる。

本番の hostname と D1 の ID は `apps/worker/deploy.env`（コミットしない。`deploy.env.example` を写して作る）に置く。

本番を更新するときは、次の順に実行する。
デプロイが migration より先だと、新しい版が使う表がまだ無く、保存と一覧がエラーで止まる。
Worker を前の版に戻したときも `derived:rebuild` が要る。
ほかの手順と詳細は [docs/deploy.md](./docs/deploy.md) と [docs/operations.md](./docs/operations.md) にある。

```sh
pnpm db:migrate:remote
pnpm deploy:remote
read -rs WIKI_TOKEN && export WIKI_TOKEN  # write の token を入れる
pnpm derived:rebuild --remote
```

token の平文は発行時に標準出力へ 1 度だけ出る。
失効した token の名前は再利用できない。
バックアップの `data.sql` は draft の本文を含むので、`--out` を追跡される場所に向けない。

## 規約

- ドキュメントとコメントは日本語で書く。
  コメントはコードから自明でないこと（判断の理由、制約）だけを書く。
- 秘密情報（`.dev.vars`、`.env*`、`apps/worker/deploy.env`）はコミットしない。
- 見た目の値（色、長さ、font-family、影、z-index）は `apps/web/src/theme.css` の token に置き、部品の CSS は token だけを参照する。
  直書きが要る宣言は、同じ行の末尾に `/* token-ok: 理由 */` を書く。
  `pnpm lint` が検査する。

PR を出す前に `lint`、`typecheck`、`test` がすべて通ることを確認する。
CI（`.github/workflows/ci.yml`）も同じ 3 つを実行する。
コミット時は lefthook が、ステージしたファイルに biome を実行する。
