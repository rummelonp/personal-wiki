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
出力先は `apps/worker/backups/<UTC の日時>-remote/`（gitignore 済み）で、`data.sql` と `manifest.json` ができる。
`--out <dir>` で変えるときは追跡される場所に置かない。相対パスの起点はコマンドを実行したディレクトリ（pnpm なら `apps/worker`）で、`-` で始まる値は受け付けない。
`data.sql` は draft の本文を含むので、扱いに気を付ける。

- ダンプするのは `pages` と `revisions` だけ。links、tags、抜粋、検索の索引は本文から作り直せるので出さない。
- `api_tokens` は token の hash を含むので、既定では出さない。復元後に token を発行し直す。失効済みの名前は再利用できず、`revisions.actor` の `token:<名前>` が指す先でもあるので、前と違う名前を使う。hash ごと戻したいときだけ `--with-tokens` を付け、ダンプを秘密として扱う（この場合は `api-token issue` を省ける）。
- `wrangler d1 export` は使わない。export の形式は、本文にもとからある 2 文字の `\n` を、改行を逃がした `\n` と区別せず、復元後に本物の改行へ変える。代わりに `SELECT` で読み、文字列の列を `hex()` で受けて `CAST(X'…' AS TEXT)` の INSERT にする。NUL を含むどんな本文も変わらない。1 文は D1 の上限（100 KB）に収まるよう、本文を分けて `UPDATE` で連結する。
- 読む間も保存は続く。pages を先に読み、revisions はその pages の版までのものだけを書く。読んだあとに作られたページと保存された版は、そのバックアップに入らない（件数は終了時に表示する）。ページ同士の時点は揃わない。読む間に削除や改名で title を手放したページがあり、後で読んだページがその title を取ると、生きたページの title が dump の中で重なる。これを見つけたら "pages changed while reading" で失敗し、出力は残さないので、そのまま再実行する。書き込みの多い時間帯は避けるとよい。
- `manifest.json` に、読んだ時点の migration の一覧と、表ごとの行数と全列の SHA-256 を書く。
- R2 は対象外。

復元は、空の新しい D1 に対して行う。`load` は次を行う。

- 復元先の migration の一覧が、バックアップの時点のものを先頭に含まなければ止める（復元先が先に進んでいるのは許す）。
- 対象の表が空でなければ止める。
- 流し込んだあとに、復元先から読み直して行数と SHA-256 を `manifest.json` と照合する。

```sh
pnpm exec wrangler d1 create <名前> --update-config=false  # 表示された database_id と <名前> を deploy.env の D1_DATABASE_ID と D1_DATABASE_NAME に書く
pnpm db:migrate:remote
pnpm backup load backups/<ダンプのディレクトリ> --remote
pnpm deploy:remote
pnpm -s api-token issue <name> --scopes read,write --remote  # --with-tokens で戻したなら不要
WIKI_TOKEN=<write の token> pnpm derived:rebuild --remote
```

- `derived:rebuild` を回すまで、一覧の抜粋、backlink、タグ、検索は空のまま。
- 旧い D1 に、このバックアップから `deploy:remote` までの間に入った書き込みは移らない。
- `load` が wrangler の失敗で止まったときは、同じコマンドで再試行できる。ローカルの D1 では、失敗した SQL ファイルは全体が巻き戻って表が空のままだった。remote で表が空でなくなっていたら（`load` が not empty で拒否する）、新しい D1 を作り直して最初からやり直す。

PR を出す前に `lint`、`typecheck`、`test` がすべて通ることを確認する。
CI（`.github/workflows/ci.yml`）も同じ 3 つを実行する。
コミット時は lefthook が biome を実行する。

## 規約

- ドキュメントとコメントは日本語で書く。コメントはコードから自明でないこと（判断の理由、制約）だけを書く。
- 秘密情報（`.dev.vars`、`.env*`、`apps/worker/deploy.env`）はコミットしない。
