# personal-wiki

Cloudflare の無料枠で動かす、一人用の Markdown wiki です。
Hono の Worker、Vite/React の SPA、D1、R2 で構成し、AI エージェントが REST API と MCP から読み書きできます。

## 状態

次の機能が使えます。

- Markdown のページの作成、編集、検索、バージョン履歴。ブラウザの Live Preview エディタと、REST（`/api/*`）、MCP（`/mcp`）から操作できます
- `[[wikilink]]`、タグ、backlink、画像の添付（R2 を設定したときだけ）
- ページごとの public / draft。public のページと一覧は、ログインしていない閲覧者にも見えます。draft は id を知っている人だけが開け、検索エンジンには載せません（`noindex`）
- title を変えたときの、他のページの `[[旧 title]]` の書き換え
- API token による REST と MCP の認証。claude.ai などのカスタムコネクタからは OAuth でも接続できます
- ブラウザで閲覧と編集をする owner のログイン（Cloudflare Access）
- 全ページの派生データの作り直し（`derived:rebuild`）と、手元へのバックアップ（`backup`）

一人用の設計です。ログインできるのは `OWNER_EMAILS` に書いたメールアドレスだけで、複数人での共同編集は想定していません。

## 必要なもの

- Cloudflare アカウント
- 公開するホスト名（例 `wiki.example.com`）のゾーン。デプロイ先と同じ Cloudflare アカウントの DNS にあること
- Node 22 系（`>=22.13 <23`）
- pnpm（バージョンは `package.json` の `packageManager`）

## 無料枠の資源

| 機能 | 使う資源 |
| --- | --- |
| 本体 | Workers（API と、Static Assets で配信する SPA） |
| ページ、版、API token | D1 |
| 添付（任意） | R2。ダッシュボードで R2 を有効にする必要があり、有効化の際に支払い情報の登録を求められることがあります |
| OAuth の接続（任意） | Workers KV。書き込みの上限が小さいので、使い方の見積もりは `apps/worker/src/auth/oauth-server.ts` の冒頭にあります |
| リンクの書き換えの自動実行（任意） | Cron Trigger。アカウント全体で 5 本までです |
| owner のログイン（任意） | Cloudflare Zero Trust の Access |

各機能の上限とプランの条件は Cloudflare の最新の案内で確かめてください。

## 初回のデプロイ

以下は `apps/worker` で実行します。
ホスト名と D1 の ID は `apps/worker/deploy.env`（gitignore 済み）に書き、追跡される `wrangler.jsonc` には書きません。
`pnpm deploy:remote` と `pnpm db:migrate:remote` は、`wrangler.jsonc` に `deploy.env` の値を重ねた設定を `wrangler.deploy.json` に作って wrangler に渡します。

### 1. 取得と依存のインストール

```sh
git clone <このリポジトリの URL>
cd personal-wiki
pnpm install
cd apps/worker
pnpm exec wrangler login
```

### 2. D1 を作る

```sh
pnpm exec wrangler d1 create personal-wiki --update-config=false
```

`--update-config=false` を付けないと、wrangler が追跡対象の `wrangler.jsonc` に binding を書き込みます。
表示された `database_id` を次の手順で使います。

### 3. `deploy.env` を書く

```sh
cp deploy.env.example deploy.env
```

最低限、次の 2 つを書きます。

- `WIKI_HOSTNAME`: 公開するホスト名（スキームとパスは含めない）
- `D1_DATABASE_ID`: 手順 2 の `database_id`

そのほかの項目（R2、OAuth、Cron、owner のログイン、複数アカウントのときの `CLOUDFLARE_ACCOUNT_ID`）は `deploy.env.example` のコメントに書いてあり、任意の機能の節で使います。
`R2_BUCKET_NAME` と `OAUTH_KV_NAMESPACE_ID` が空なら、その binding を付けずにデプロイします。

### 4. migration とデプロイ

```sh
pnpm db:migrate:remote
pnpm deploy:remote
```

`deploy:remote` は先に `apps/web` をビルドします。
migration が先なのは、デプロイが先だと保存と一覧が表の無いエラーで止まるためです。

### 5. API token を発行する

```sh
pnpm -s api-token issue <name> --scopes read,write --remote
```

token の平文は標準出力に 1 度だけ出るので控えます。
失効した token の名前は再利用できません。

ここまでで REST と MCP が使えます（MCP の接続は後の節）。
ブラウザで編集するには、次の owner のログインが要ります。

## 任意の機能

どれも `deploy.env` に値を書いて `pnpm deploy:remote` を実行し直すと有効になります。
値を空に戻して再デプロイすると外れます。

### owner のログイン（ブラウザでの閲覧と編集）

ログインは Cloudflare Access を使います。
Access が保護するのは `/_auth/login` だけで、Worker は Access が付ける JWT を自分で検証してから、`SESSION_SECRET` で署名したセッション cookie を発行します。

1. Cloudflare Zero Trust のチーム名を確かめる。`<team>.cloudflareaccess.com` が `ACCESS_TEAM_DOMAIN` になります
2. Access のアプリケーションを作る。対象は、ホスト名 `WIKI_HOSTNAME` のパス `/_auth/login` だけにします
3. そのアプリケーションのポリシーで、owner のメールアドレスだけを許可する。ログイン方法には、メールアドレスを検証する IdP（One-time PIN など）を使います。Worker は JWT の email を信じて owner にするためです
4. アプリケーションの Application Audience (AUD) タグを `ACCESS_AUD` に書く
5. owner のメールアドレスを `OWNER_EMAILS` に書く（複数ならカンマ区切り）
6. `pnpm deploy:remote` を実行する
7. セッション cookie の署名鍵（32 文字以上）を secret で入れる。`deploy.env` には書きません

   ```sh
   openssl rand -base64 32 | pnpm exec wrangler secret put SESSION_SECRET --config wrangler.deploy.json
   ```

`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`OWNER_EMAILS` は、3 つとも書くか、3 つとも空にします。
一部だけだと `deploy.env` の検査で止まります。
`SESSION_SECRET` が無い、または 32 文字未満のあいだは、3 つを書いてもログインできません。

デプロイ後に `https://wiki.example.com/_auth/login` を開くと、Access の認証を経てログインします。
`SESSION_SECRET` を入れ替えると、発行済みのセッションはすべてすぐに無効になります。

### 添付（R2）

画像の添付に使います。

1. ダッシュボードで R2 を有効にする
2. バケットを作る

   ```sh
   pnpm exec wrangler r2 bucket create personal-wiki --update-config=false
   ```

3. バケット名を `deploy.env` の `R2_BUCKET_NAME` に書き、`pnpm deploy:remote` を実行する

`R2_BUCKET_NAME` が空のあいだは、添付の保存は 503、配信は 404 になり、画面は貼り付けの導線を出しません。
API の使い方と公開範囲は [AGENTS.md](./AGENTS.md) の「添付（R2）」にあります。

### OAuth（claude.ai などのカスタムコネクタ）

claude.ai や Claude Desktop のカスタムコネクタから OAuth で MCP に接続するときだけ必要です。
同意画面は owner のセッションを使うので、上の owner のログインも設定します。

1. KV namespace を作る

   ```sh
   pnpm exec wrangler kv namespace create personal-wiki-oauth --update-config=false
   ```

2. 表示された `id` を `deploy.env` の `OAUTH_KV_NAMESPACE_ID` に書き、`pnpm deploy:remote` を実行する

claude.ai の戻り先は既定で許可しています。
ほかのクライアントから接続するときだけ、redirect URI を `OAUTH_REDIRECT_URIS` に足します。
許可した接続は `https://wiki.example.com/_auth/oauth/grants` で見て、取り消せます。
API token による接続は、KV と owner のログインが無くても使えます。

### リンクの書き換えの自動実行（Cron）

title を変えると、他のページの `[[旧 title]]` を書き換える仕事が積まれます。
owner がブラウザで開いていれば画面が進めますが、MCP 経由の rename では積まれたまま残ります。
`deploy.env` の `LINK_REWRITE_CRON` に cron 式（例 `*/5 * * * *`）を書いてデプロイすると、1 回の発火で 1 ページずつ進めます。

空のままなら Cron を付けません。
Cron Trigger はアカウント全体で 5 本までなので、既定は空です。
Cron を使わないときは、`pnpm link-rewrites` で手動で進められます（[AGENTS.md](./AGENTS.md) の「コマンド」）。

## MCP への接続

エンドポイントは `https://wiki.example.com/mcp` です。

- Claude Code など、API token で接続する場合:

  ```sh
  claude mcp add --transport http personal-wiki https://wiki.example.com/mcp \
    --header "Authorization: Bearer <token>"
  ```

  token の scope が `read` だけのときは、write が要るツールを呼ぶとエラーになります。
- claude.ai や Claude Desktop のカスタムコネクタ: コネクタの URL に上の URL を入れて接続します。ブラウザで同意画面が開くので、クライアント名と送り先を確かめ、`read` か `read` と `write` を選んで許可します。OAuth の設定が要ります

## 更新

新しい版に更新するときは、取得と `pnpm install` のあと、`apps/worker` で次の順に実行します。

```sh
pnpm db:migrate:remote
pnpm deploy:remote
WIKI_TOKEN=<write の token> pnpm derived:rebuild --remote
```

`derived:rebuild` は links、tags、添付の参照、一覧の抜粋、検索の索引を本文から作り直します。
migration が派生データの表を足すことがあるので、毎回実行して構いません。
詳しい扱いは [AGENTS.md](./AGENTS.md) の「コマンド」にあります。

## バックアップ

Time Travel で遡れるのは Free で 7 日までなので、定期的に手元へダンプを残します。

```sh
pnpm backup --remote
```

出力の場所、復元の手順、含まれないもの（R2 の画像の中身など）は [AGENTS.md](./AGENTS.md) の「バックアップと復元」にあります。
`data.sql` には draft の本文が入るので、扱いに気を付けてください。

## ローカルで動かす

```sh
pnpm install
cd apps/worker
pnpm db:migrate
pnpm dev
```

ローカルの D1 に migration を適用し、`apps/web` をビルドしてから `wrangler dev` を起動します。
開発、テスト、規約は [AGENTS.md](./AGENTS.md) を参照してください。

## ライセンス

[MIT](./LICENSE)
