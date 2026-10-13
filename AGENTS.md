# AGENTS.md

## 概要

Cloudflare の無料枠で動く一人用 Markdown wiki。
1 つの Hono の Worker が API を提供し、Static Assets として Vite/React の SPA を配信する。
データは D1 と R2 に置き、AI エージェントが REST と MCP から読み書きする。

pnpm workspace の構成で、アプリは `apps/*`、共有パッケージは `packages/*` に置く。

- `apps/worker`: Hono の Worker（REST の `/api/*` と MCP の `/mcp`）、D1 の migration、デプロイとトークン発行のスクリプト
- `packages/domain`: title の正規化と Result 型など、実行環境に依存しない規則
- `packages/markdown`: Markdown の解析（wikilink、タグ、frontmatter の抽出、差分など）
- `packages/editor`: CodeMirror 6 の Live Preview エディタ（React に依存しない）

## コマンド

Node は 22 系、パッケージマネージャーは pnpm（バージョンは `package.json` の `packageManager`）。

```sh
pnpm install
pnpm lint          # biome check
pnpm format        # biome check --write
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest run
```

`packages/editor` のテストは Playwright の Chromium の中で動く。初回は `pnpm --filter @personal-wiki/editor exec playwright install chromium` でブラウザを入れる。

Worker の開発とデプロイは `apps/worker` で実行する。

```sh
pnpm db:migrate         # ローカルの D1 に migration を適用
pnpm dev                # wrangler dev
pnpm deploy:remote      # deploy.env から設定を合成してデプロイ
pnpm db:migrate:remote  # 本番の D1 に migration を適用
pnpm api-token issue <name> --scopes read|read,write [--remote]
pnpm api-token revoke <name> [--remote]
WIKI_TOKEN=<write の token> pnpm derived:rebuild [--remote]  # 全ページの派生データを作り直す
pnpm backup [--remote] [--out <dir>] [--with-tokens]  # D1 の本文を SQL のダンプにして手元に残す
pnpm backup load <dir> [--remote]  # ダンプを新しい D1 に流し込む
```

本番の hostname と D1 の ID は `apps/worker/deploy.env`（コミットしない。`deploy.env.example` を写して作る）に置く。
トークンの平文は発行時に標準出力へ 1 度だけ出る。失効したトークンの名前は再利用できない。

本番を更新するときは、次の順に実行する。
migration が派生データの表を足すことがあり、デプロイが先だと保存と一覧が表の無いエラーで止まる。

```sh
pnpm db:migrate:remote
pnpm deploy:remote
WIKI_TOKEN=<write の token> pnpm derived:rebuild --remote
```

`derived:rebuild` は links、tags、一覧の抜粋、検索の索引を本文から作り直す。
1 回の呼び出しで 1 ページずつ進めるので、全ページ分を回して終わる。
migration の前から在るページは、これを回すまで一覧に抜粋が出ない。
Worker を前の版に戻して再デプロイしたあとも実行する。前の版は新しい派生データ（抜粋など）を書かないので、戻している間に保存したページの分が古いまま残る。
失敗したページがあると、その id を標準エラーに出して終了コード 1 になる。

### バックアップと復元

Time Travel は Free で 7 日までしか遡れないので、それより古い状態に戻せるよう、定期的に `pnpm backup --remote` で手元にダンプを残す。
出力先は `apps/worker/backups/<UTC の日時>-remote/`（gitignore 済み。`--out` で変えるときも追跡される場所には置かない）で、`data.sql` と `manifest.json` ができる。
`data.sql` は draft の本文を含むので、扱いに気を付ける。

- ダンプするのは `pages` と `revisions` だけ。links、tags、抜粋、検索の索引は本文から作り直せるので出さない（検索の FTS5 は D1 の export もできない）。
- `api_tokens` は token の hash を含むので、既定では出さない。復元後に token を発行し直す。失効済みの名前は再利用できず、`revisions.actor` の `token:<名前>` が指す先でもあるので、前と違う名前を使う。hash ごと戻したいときだけ `--with-tokens` を付け、ダンプを秘密として扱う。
- export の実行中は D1 へのリクエストが止まる。表を 1 回の export にまとめて 1 つの時点のダンプにしているので、書き込みの多い時間帯を避ければ足りる。
- R2 は対象外。

復元は、空の新しい D1 に対して行う。`load` は migration が未適用の D1、対象の表が空でない D1 を拒み、流し込んだあとに行数が `manifest.json` と一致するか確かめる。

```sh
pnpm exec wrangler d1 create <名前> --update-config=false  # 表示された database_id を deploy.env の D1_DATABASE_ID に書く
pnpm db:migrate:remote
pnpm backup load backups/<ダンプのディレクトリ> --remote
pnpm deploy:remote
pnpm -s api-token issue <name> --scopes read,write --remote
WIKI_TOKEN=<write の token> pnpm derived:rebuild --remote
```

`derived:rebuild` を回すまで、一覧の抜粋、backlink、タグ、検索は空のまま。

PR を出す前に `lint`、`typecheck`、`test` がすべて通ることを確認する。
CI（`.github/workflows/ci.yml`）も同じ 3 つを実行する。
コミット時は lefthook が biome を実行する。

## 規約

- ドキュメントとコメントは日本語で書く。コメントはコードから自明でないこと（判断の理由、制約）だけを書く。
- 秘密情報（`.dev.vars`、`.env*`、`apps/worker/deploy.env`）はコミットしない。
