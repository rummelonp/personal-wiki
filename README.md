# personal-wiki

Cloudflare の無料枠で動かす、一人用の Markdown wiki である。
Hono の Worker、Vite/React の SPA、D1、R2 で構成し、AI エージェントが REST API と MCP から読み書きできる。

## 機能

- Markdown のページの作成、編集、検索。
  ブラウザの Live Preview エディタと、REST（`/api/*`）、MCP（`/mcp`）から操作できる
- `[[wikilink]]`、タグ、backlink、画像の添付（R2 を設定したときだけ）
- ページごとの public / draft。
  public のページと一覧は、ログインしていない閲覧者にも見え、リンクのプレビュー用に OGP のメタ情報を返す。
  draft は id を知っている人だけが開け、検索エンジンには載せない（`noindex`）。
  REST の最近の更新の一覧（`GET /api/pages/recent`）と、タグとその件数の一覧（`GET /api/tags`）は、`visibility=public` か `visibility=draft` で公開範囲を絞り込める。
  タグの一覧は `limit`（1 以上 1000 以下）を付けると上位から切り、`truncated` で後ろに残りがあるかを返す。
  `limit` を付けなければ、従来どおり全件の `tags` だけを返す。
  一覧で draft を見られるのは owner と read 以上の API token だけである。
  ログインしていない閲覧者の `visibility=draft` は、draft があっても空の一覧を返す。
- title を変えたときの、他のページの `[[旧 title]]` の書き換え
- ページの版の履歴。
  保存のたびに版を残し、owner のブラウザからの保存は、最初の保存から 10 分までを 1 つの版にまとめる。
  過去の版は、owner がブラウザの右の列から、read 以上の API token が REST（`/api/pages/:id/revisions`）と MCP（`list_revisions` と `read_page` の `revision`）から、OAuth の接続が MCP から読める。
  ログインしていない閲覧者には見せない。
  過去の版の本文には、owner が版のダイアログの「この版の本文に戻す」から、write の API token が REST（`POST /api/pages/:id/revisions/:version/restore`）から戻せる。
  戻すのは本文と、本文から作るタグとリンクだけで、title は今のままである。
  戻すと新しい版を積み、戻す前の本文も履歴に残る
- API token による REST と MCP の認証。
  claude.ai などのカスタムコネクタからは OAuth でも接続できる
- ブラウザで閲覧と編集をする owner のログイン（Cloudflare Access）
- 全ページの派生データの作り直し（`derived:rebuild`）と、手元へのバックアップ（`backup`）

一人用の設計である。
ログインできるのは `OWNER_EMAILS` に書いたメールアドレスだけで、複数人での共同編集は想定していない。

## 構成

pnpm workspace で、アプリは `apps/*`、共有パッケージは `packages/*` にある。

- `apps/worker`: Hono の Worker（REST の `/api/*` と MCP の `/mcp`）、D1 の migration、デプロイ、token の発行、バックアップなどのスクリプト
- `apps/web`: Vite/React の SPA。Worker が Static Assets として配信する
- `packages/domain`: title の正規化と Result 型など、実行環境に依存しない規則
- `packages/markdown`: Markdown の解析（wikilink、タグ、frontmatter の抽出、差分など）
- `packages/editor`: CodeMirror 6 の Live Preview エディタ（React に依存しない）

## ローカルで動かす

Node 22 系（`>=22.13 <23`）と pnpm（バージョンは `package.json` の `packageManager`）が要る。

```sh
pnpm install
cd apps/worker
pnpm db:migrate
pnpm dev
```

ローカルの D1 に migration を適用し、`apps/web` をビルドしてから `wrangler dev` を起動する。

`pnpm dev` の画面は匿名である。
owner として編集を試すときは、`pnpm dev` の代わりに `pnpm dev:owner` を実行し、http://localhost:8780 を開く。
Cloudflare Access の設定は要らない。
起動ごとに乱数の `SESSION_SECRET` を作り、前段の proxy がリクエストごとに owner の cookie を足す。
ブラウザには cookie を置かないので、iOS の Simulator の Safari からも同じ URL で入れる。
ログアウトしても、再読み込みすると owner に戻る。
ポートは `--port <n>` で変えられ、proxy を通らない `wrangler dev` は `<n> + 1` で動く。
匿名の画面は、その `wrangler dev`（既定では http://localhost:8781）で見られる。

## デプロイ

Cloudflare アカウントと、そのアカウントの DNS にあるホスト名のゾーンが要る。
手順の全体は [docs/deploy.md](./docs/deploy.md) にあり、流れは次のとおりである（コマンドは `apps/worker` で実行する）。

1. `wrangler login` し、D1 を作る
2. `apps/worker/deploy.env`（`deploy.env.example` を写して作る。gitignore 済み）に、ホスト名と D1 の ID を書く
3. `pnpm db:migrate:remote` で migration を適用し、`pnpm deploy:remote` でデプロイする
4. `pnpm -s api-token issue <name> --scopes read,write --remote` で API token を発行する

使う Cloudflare の資源と無料枠の条件、次の任意の機能の設定も [docs/deploy.md](./docs/deploy.md) にある。

- owner のログイン（ブラウザでの閲覧と編集。Cloudflare Access）
- 添付（R2）
- OAuth（claude.ai などのカスタムコネクタ）
- リンクの書き換えの自動実行（Cron）

## MCP への接続

エンドポイントは `https://wiki.example.com/mcp` である（`wiki.example.com` は自分のホスト名に読み替える）。

- Claude Code など、API token で接続する場合:

  ```sh
  claude mcp add --transport http personal-wiki https://wiki.example.com/mcp \
    --header "Authorization: Bearer $WIKI_TOKEN"
  ```

  `--scope project` は付けない。付けると、リポジトリの `.mcp.json` に token が書かれる。
  `WIKI_TOKEN` の入れ方は [docs/operations.md](./docs/operations.md) の「API token」にある。
  token の scope が `read` だけのときは、write が要るツールを呼ぶとエラーになる。
- claude.ai や Claude Desktop のカスタムコネクタ: コネクタの URL に上の URL を入れて接続する。
  ブラウザで同意画面が開くので、「接続するアプリ」の名前と「トークンの送り先」を確かめ、「読み取り」か「読み書き」を選んで許可する。
  OAuth と owner のログインの設定が要る

## 運用

- 更新: 新しい版では、`apps/worker` で `pnpm db:migrate:remote`、`pnpm deploy:remote`、`pnpm derived:rebuild --remote` を順に実行する（[docs/deploy.md](./docs/deploy.md)）
- API token の発行、失効、一覧、派生データの作り直し、リンクの書き換え、バックアップと復元: [docs/operations.md](./docs/operations.md)
- 画像の添付の使い方と公開範囲: [docs/attachments.md](./docs/attachments.md)

Time Travel で遡れるのは Free で 7 日までなので、定期的に `pnpm backup --remote` で手元にダンプを残す。
`data.sql` には draft の本文が入るので、扱いに気を付ける。

## 開発

PR を出す前に、次の 3 つがすべて通ることを確認する。
CI もこの 3 つを実行する。

```sh
pnpm lint
pnpm typecheck
pnpm test
```

`packages/editor` と `apps/web` のコンポーネントのテストは、Playwright の Chromium の中で動く。
初回は `pnpm --filter @personal-wiki/editor exec playwright install chromium` でブラウザを入れる。
`pnpm format` で biome が整形する。
E2E、規約、開発用コマンドの一覧は [AGENTS.md](./AGENTS.md) にある。
画面の見た目と使い心地の原則は [docs/design.md](./docs/design.md) にある。

## ライセンス

[MIT](./LICENSE)
