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
pnpm lint          # biome check と CSS の直書きの検査
pnpm format        # biome check --write
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest run
```

`packages/editor` のテストは Playwright の Chromium の中で動く。初回は `pnpm --filter @personal-wiki/editor exec playwright install chromium` でブラウザを入れる。

E2E は `pnpm test` に含めず、別に実行する。web を build し、一時の D1 で `wrangler dev`（ポート 8790）を起動して、owner の cookie を作って入る。`apps/worker/.dev.vars` は読まない。
初回は `pnpm --filter @personal-wiki/web exec playwright install chromium webkit firefox` でブラウザを入れる。
E2E の build は `apps/web/dist` を上書きするので、8787 で動かしている開発の `wrangler dev` の画面もその版に変わる。
web のソースを前の build から変えていなければ、`E2E_SKIP_BUILD=1 pnpm e2e` で build を省ける。
E2E のポートは既定で 8790（inspector は 9339）。別の worktree の E2E と同時に流すときは `E2E_PORT=8800 pnpm e2e` のように変える。

```sh
pnpm e2e                    # apps/web/e2e のテスト。結果は apps/web/e2e-output/（gitignore 済み）
pnpm e2e:sheet [--out <dir>]  # 画面の一覧（明暗 × 幅 375・768・1280）を 1 枚の HTML にする
```

Worker の開発とデプロイは `apps/worker` で実行する。

```sh
pnpm db:migrate         # ローカルの D1 に migration を適用
pnpm dev                # wrangler dev
pnpm deploy:remote      # deploy.env から設定を合成してデプロイ
pnpm db:migrate:remote  # 本番の D1 に migration を適用
pnpm api-token issue <name> --scopes read|read,write [--remote]
pnpm api-token revoke <name> [--remote]
WIKI_TOKEN=<write の token> pnpm derived:rebuild [--remote]  # 全ページの派生データを作り直す
WIKI_TOKEN=<write の token> pnpm link-rewrites [--remote] [--target <page id>]  # title の変更で待っているリンクの書き換えを最後まで進める
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

`derived:rebuild` は links、tags、添付の参照、一覧の抜粋、検索の索引を本文から作り直す。
1 回の呼び出しで 1 ページずつ進めるので、全ページ分を回して終わる。
migration の前から在るページは、これを回すまで一覧に抜粋が出ない。
Worker を前の版に戻して再デプロイしたあとも実行する。前の版は新しい派生データ（抜粋など）を書かないので、戻している間に保存したページの分が古いまま残る。
添付の参照も同じで、戻している間に本文から外した添付は、`derived:rebuild` を回すまで匿名に読めるまま残る。
失敗したページがあると、その id を標準エラーに出して終了コード 1 になる。

title を変えると、他のページの `[[旧 title]]` を書き換える仕事が `link_rewrites` に積まれ、`POST /api/link-rewrites/step` が 1 回に 1 ページずつ書き換える。
`link-rewrites` はこれを残りが 0 になるまで呼ぶ。書き換えると他のリンクやタグが変わるページと、3 回試しても処理が終わらなかったページは書き換えずに飛ばし、その id を標準エラーに出して終了コード 1 になる。
5xx などで途中で止まったときも終了コード 1 になるが、積んだ分は D1 に残るので、同じコマンドを再実行すれば続きから進む（飛ばしたページの id は、止まる前の分も標準エラーに出ている）。試行の回数は再実行でも引き継ぐので、同じページで 5xx が 3 回続くと、そのページは飛ばす。
Worker を前の版（step の無い版）に戻している間は step が 404 になり、rename しても書き換えは積まれない。戻している間に変えた title へのリンクは、手で直す。

MCP 経由の rename は web を開かないので、`deploy.env` の `LINK_REWRITE_CRON`（cron 式）を書くと、Cron が発火ごとに 1 リンク元を進める。
Cron Trigger はアカウント全体で 5 本までなので既定は空で、空のままデプロイすると Cron を外す。推奨は `* * * * *` か `*/5 * * * *`。
積んだ分が無い発火の D1 の読み取りは数行で、毎分でも 1 日 1,500 行ほどに収まる。
Cron が飛ばしたページ（D1 の一時的な失敗が 3 発火続いた分を含む）は Worker のログ（`wrangler tail` の `link_rewrites.failed`）にしか出ず、`link-rewrites` でも拾えないので、気づいたら手で直す。`link_rewrites.scheduled_error` の `sourcePageId` はその発火で選んだリンク元で、書き換えが済んでいることもある。
Cron の予約は script の設定なので、前の版（`scheduled` の無い版）に戻しても残り、発火ごとにエラーになる。前の版の deploy は予約に触れないので、外すならダッシュボードで外す。

### 添付（R2）

- 画像は `POST /api/attachments` に、本文を画像のバイト列、`Content-Type` を画像の種類にして送る。`Content-Length` は必須で、無ければ 411 を返す。
- 本文の `![[<名前>]]` は `/api/pages/<page id>/attachments/<名前>` で配信する。匿名は、削除されていないそのページが本文で参照する添付だけを読める。
- 画像の URL は page id を含む。draft は id の URL で匿名に読めるので、draft の画像の URL を共有すると、その draft の本文も読めるようになる。

### バックアップと復元

Time Travel は Free で 7 日までしか遡れないので、それより古い状態に戻せるよう、定期的に `pnpm backup --remote` で手元にダンプを残す。
出力先は `apps/worker/backups/<UTC の日時>-remote/`（gitignore 済み）で、`data.sql` と `manifest.json` ができる。
`--out <dir>` で変えるときは追跡される場所に置かない。相対パスの起点はコマンドを実行したディレクトリ（pnpm なら `apps/worker`）で、`-` で始まる値は受け付けない。
`data.sql` は draft の本文を含むので、扱いに気を付ける。

- ダンプするのは `pages`、`revisions`、`attachments` だけ。links、tags、添付の参照、抜粋、検索の索引は本文から作り直せるので出さない。
- 待っているリンクの書き換え（`link_rewrites`）も出さない。復元すると、その分は本文に旧 title のリンクとして残るので、`pnpm backup --remote` の前に `pnpm link-rewrites --remote` を回しておくとよい。
- `api_tokens` は token の hash を含むので、既定では出さない。復元後に token を発行し直す。失効済みの名前は再利用できず、`revisions.actor` の `token:<名前>` が指す先でもあるので、前と違う名前を使う。hash ごと戻したいときだけ `--with-tokens` を付け、ダンプを秘密として扱う（この場合は `api-token issue` を省ける）。
- `wrangler d1 export` は使わない。export の形式は、本文にもとからある 2 文字の `\n` を、改行を逃がした `\n` と区別せず、復元後に本物の改行へ変える。代わりに `SELECT` で読み、文字列の列を `hex()` で受けて `CAST(X'…' AS TEXT)` の INSERT にする。NUL を含むどんな本文も変わらない。1 文は D1 の上限（100 KB）に収まるよう、本文を分けて `UPDATE` で連結する。
- 読む間も保存は続く。pages を先に読み、revisions はその pages の版までのものだけを書く。読んだあとに作られたページと保存された版は、そのバックアップに入らない（件数は終了時に表示する）。ページ同士の時点は揃わない。読む間に削除や改名で title を手放したページがあり、後で読んだページがその title を取ると、生きたページの title が dump の中で重なる。これを見つけたら "pages changed while reading" で失敗し、出力は残さないので、そのまま再実行する。書き込みの多い時間帯は避けるとよい。
- `manifest.json` に、読んだ時点の migration の一覧と、表ごとの行数と全列の SHA-256 を書く。
- R2 は対象外。`attachments` の表（添付の名前と種類）は入るが、画像の中身は入らない。

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

- `derived:rebuild` を回すまで、一覧の抜粋、backlink、タグ、検索は空のまま。匿名には画像も 404 になる（配信の判定に使う添付の参照が空のため）。
- 画像の中身はバックアップに入らないので、R2 にあるものを使う。復元後も、前と同じバケットを `R2_BUCKET_NAME` に書く。
- 旧い D1 に、このバックアップから `deploy:remote` までの間に入った書き込みは移らない。
- `load` が wrangler の失敗で止まったときは、同じコマンドで再試行できる。ローカルの D1 では、失敗した SQL ファイルは全体が巻き戻って表が空のままだった。remote で表が空でなくなっていたら（`load` が not empty で拒否する）、新しい D1 を作り直して最初からやり直す。

PR を出す前に `lint`、`typecheck`、`test` がすべて通ることを確認する。
CI（`.github/workflows/ci.yml`）も同じ 3 つを実行する。
コミット時は lefthook が biome を実行する。

## 規約

- ドキュメントとコメントは日本語で書く。コメントはコードから自明でないこと（判断の理由、制約）だけを書く。
- 秘密情報（`.dev.vars`、`.env*`、`apps/worker/deploy.env`）はコミットしない。
- 見た目の値（色、長さ、font-family、影、z-index）は `apps/web/src/theme.css` の token に置き、部品の CSS は token だけを参照する。直書きが要る宣言は、同じ行の末尾に `/* token-ok: 理由 */` を書く。`pnpm lint` が検査する。
