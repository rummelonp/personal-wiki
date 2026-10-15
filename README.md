# personal-wiki

Cloudflare の無料枠で動かす、一人用の Markdown wiki です。
Hono の Worker、Vite/React の SPA、D1、R2 で構成し、AI エージェントが REST API と MCP から読み書きできます。

## 機能

- Markdown のページの作成、編集、検索。
  ブラウザの Live Preview エディタと、REST（`/api/*`）、MCP（`/mcp`）から操作できます
- `[[wikilink]]`、タグ、backlink、画像の添付（R2 を設定したときだけ）
- ページごとの public / draft。
  public のページと一覧は、ログインしていない閲覧者にも見え、リンクのプレビュー用に OGP のメタ情報を返します。
  draft は id を知っている人だけが開け、検索エンジンには載せません（`noindex`）
- title を変えたときの、他のページの `[[旧 title]]` の書き換え
- API token による REST と MCP の認証。
  claude.ai などのカスタムコネクタからは OAuth でも接続できます
- ブラウザで閲覧と編集をする owner のログイン（Cloudflare Access）
- 全ページの派生データの作り直し（`derived:rebuild`）と、手元へのバックアップ（`backup`）

一人用の設計です。
ログインできるのは `OWNER_EMAILS` に書いたメールアドレスだけで、複数人での共同編集は想定していません。

## 構成

pnpm workspace で、アプリは `apps/*`、共有パッケージは `packages/*` にあります。

- `apps/worker`: Hono の Worker（REST の `/api/*` と MCP の `/mcp`）、D1 の migration、デプロイ、token の発行、バックアップなどのスクリプト
- `apps/web`: Vite/React の SPA。Worker が Static Assets として配信します
- `packages/domain`: title の正規化と Result 型など、実行環境に依存しない規則
- `packages/markdown`: Markdown の解析（wikilink、タグ、frontmatter の抽出、差分など）
- `packages/editor`: CodeMirror 6 の Live Preview エディタ（React に依存しない）

## ローカルで動かす

Node 22 系（`>=22.13 <23`）と pnpm（バージョンは `package.json` の `packageManager`）が要ります。

```sh
pnpm install
cd apps/worker
pnpm db:migrate
pnpm dev
```

ローカルの D1 に migration を適用し、`apps/web` をビルドしてから `wrangler dev` を起動します。

## デプロイ

Cloudflare アカウントと、そのアカウントの DNS にあるホスト名のゾーンが要ります。
手順の全体は [docs/deploy.md](./docs/deploy.md) にあり、流れは次のとおりです（コマンドは `apps/worker` で実行します）。

1. `wrangler login` し、D1 を作る
2. `apps/worker/deploy.env`（`deploy.env.example` を写して作る。gitignore 済み）に、ホスト名と D1 の ID を書く
3. `pnpm db:migrate:remote` で migration を適用し、`pnpm deploy:remote` でデプロイする
4. `pnpm -s api-token issue <name> --scopes read,write --remote` で API token を発行する

使う Cloudflare の資源と無料枠の条件、次の任意の機能の設定も [docs/deploy.md](./docs/deploy.md) にあります。

- owner のログイン（ブラウザでの閲覧と編集。Cloudflare Access）
- 添付（R2）
- OAuth（claude.ai などのカスタムコネクタ）
- リンクの書き換えの自動実行（Cron）

## MCP への接続

エンドポイントは `https://wiki.example.com/mcp` です（`wiki.example.com` は自分のホスト名に読み替えます）。

- Claude Code など、API token で接続する場合:

  ```sh
  claude mcp add --transport http personal-wiki https://wiki.example.com/mcp \
    --header "Authorization: Bearer $WIKI_TOKEN"
  ```

  `--scope project` は付けません。付けると、リポジトリの `.mcp.json` に token が書かれます。
  `WIKI_TOKEN` の入れ方は [docs/operations.md](./docs/operations.md) の「API token」にあります。
  token の scope が `read` だけのときは、write が要るツールを呼ぶとエラーになります。
- claude.ai や Claude Desktop のカスタムコネクタ: コネクタの URL に上の URL を入れて接続します。
  ブラウザで同意画面が開くので、クライアント名と送り先を確かめ、`read` か `read` と `write` を選んで許可します。
  OAuth と owner のログインの設定が要ります

## 運用

- 更新: 新しい版では、`apps/worker` で `pnpm db:migrate:remote`、`pnpm deploy:remote`、`pnpm derived:rebuild --remote` を順に実行します（[docs/deploy.md](./docs/deploy.md)）
- API token の発行と失効、派生データの作り直し、リンクの書き換え、バックアップと復元: [docs/operations.md](./docs/operations.md)
- 画像の添付の使い方と公開範囲: [docs/attachments.md](./docs/attachments.md)

Time Travel で遡れるのは Free で 7 日までなので、定期的に `pnpm backup --remote` で手元にダンプを残します。
`data.sql` には draft の本文が入るので、扱いに気を付けてください。

## 開発

PR を出す前に、次の 3 つがすべて通ることを確認します。
CI もこの 3 つを実行します。

```sh
pnpm lint
pnpm typecheck
pnpm test
```

`packages/editor` と `apps/web` の部品のテストは、Playwright の Chromium の中で動きます。
初回は `pnpm --filter @personal-wiki/editor exec playwright install chromium` でブラウザを入れます。
`pnpm format` で biome が整形します。
E2E、規約、開発用コマンドの一覧は [AGENTS.md](./AGENTS.md) にあります。

## ライセンス

[MIT](./LICENSE)
