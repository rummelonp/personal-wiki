# デプロイ

Cloudflare アカウントへのデプロイと、任意の機能の設定、更新の手順です。
運用中の作業（token、派生データ、バックアップなど）は [operations.md](./operations.md) にあります。

コマンドは、特に断らない限り `apps/worker` で実行します。
`wiki.example.com` は、自分のホスト名（`WIKI_HOSTNAME`）に読み替えてください。

## 必要なもの

- Cloudflare アカウント
- 公開するホスト名のゾーン。デプロイ先と同じ Cloudflare アカウントの DNS にあること
- Node 22 系（`>=22.13 <23`）
- pnpm（バージョンは `package.json` の `packageManager`）
- git、openssl（`SESSION_SECRET` を作るとき）

## 無料枠の資源

| 機能 | 使う資源 |
| --- | --- |
| 本体 | Workers（API と、Static Assets で配信する SPA） |
| ページ、版、API token | D1 |
| 添付（任意） | R2。ダッシュボードで R2 を有効にする必要があり、有効化の際に支払い情報の登録を求められることがあります |
| OAuth の接続（任意） | Workers KV。書き込みの上限が小さいので、使い方の見積もりは `apps/worker/src/auth/oauth-server.ts` の冒頭にあります |
| リンクの書き換えの自動実行（任意） | Cron Trigger。アカウント全体で 5 本までです |
| owner のログイン（任意） | Cloudflare Zero Trust の Access。組織を作る際に支払い情報の登録を求められることがあります |

各機能の上限とプランの条件は Cloudflare の最新の案内で確かめてください。

## 初回のデプロイ

ホスト名と D1 の ID は `apps/worker/deploy.env`（gitignore 済み）に書き、追跡される `wrangler.jsonc` には書きません。
`pnpm deploy:remote` と `pnpm db:migrate:remote` は、`wrangler.jsonc` に `deploy.env` の値を重ねた設定を `wrangler.deploy.json`（gitignore 済み）に作って wrangler に渡します。
デプロイでは wrangler の自動プロビジョニングを無効にするので、D1、R2、KV は手順で作ったものだけを使います。
各項目の詳細と注意は `node scripts/deploy.mjs --help` に載せています。

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

そのほかの項目（R2、OAuth、Cron、owner のログイン、複数アカウントのときの `CLOUDFLARE_ACCOUNT_ID`）は `deploy.env.example` のコメントに書いてあり、後の「任意の機能」で使います。
`R2_BUCKET_NAME` と `OAUTH_KV_NAMESPACE_ID` が空なら、その binding を付けずにデプロイします。

### 4. migration とデプロイ

```sh
pnpm db:migrate:remote
pnpm deploy:remote
```

`deploy:remote` は先に `apps/web` をビルドします。
migration を先にするのは、デプロイが先だと新しい版が使う表がまだ無く、保存と一覧がエラーで止まるためです。
owner のログインや OAuth を設定していない間は `warning:` が標準エラーに出ますが、デプロイは続きます。

### 5. API token を発行する

```sh
pnpm -s api-token issue <name> --scopes read,write --remote
```

token の平文は標準出力に 1 度だけ出るので控えます。
token の扱いは [operations.md](./operations.md) の「API token」を参照してください。

ここまでで REST と MCP が使えます（MCP の接続は [README](../README.md) の「MCP への接続」）。
ブラウザで編集するには、次の owner のログインが要ります。

## 任意の機能

各節の手順を終えて `pnpm deploy:remote` を実行し直すと有効になります。
`deploy.env` の値を空に戻して再デプロイすると外れます（secret は残りますが、使われません）。

### owner のログイン（ブラウザでの閲覧と編集）

ログインは Cloudflare Access を使います。
Access が保護するのは `/_auth/login` だけで、Worker は Access が付ける JWT を自分で検証してから、`SESSION_SECRET` で署名したセッション cookie を発行します。

1. Cloudflare Zero Trust のチーム名を確かめる。
   `<team>.cloudflareaccess.com` が `ACCESS_TEAM_DOMAIN` になります
2. Access のアプリケーションを作る。
   対象は、ホスト名 `WIKI_HOSTNAME` のパス `/_auth/login` だけにします
3. そのアプリケーションのポリシーで、owner のメールアドレスだけを許可する。
   ログイン方法には、メールアドレスを検証する IdP（One-time PIN、Cloudflare アカウントでのログインなど）を使います。
   Worker は JWT の email を信じて owner にするためです
4. アプリケーションの Application Audience (AUD) タグを `ACCESS_AUD` に書く。
   アプリケーションを作り直すと AUD が変わり、`ACCESS_AUD` を書き直して再デプロイするまでログインできません
5. owner のメールアドレスを `OWNER_EMAILS` に書く（複数ならカンマ区切り）
6. `pnpm deploy:remote` を実行する
7. セッション cookie の署名鍵（32 文字以上）を secret で入れる。
   `deploy.env` には書きません

   ```sh
   openssl rand -base64 32 | pnpm exec wrangler secret put SESSION_SECRET --config wrangler.deploy.json
   ```

`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`OWNER_EMAILS` は、3 つとも書くか、3 つとも空にします。
一部だけだと `deploy.env` の検査で止まります。
`SESSION_SECRET` が無い、または 32 文字未満のあいだは、3 つを書いてもログインできません。

デプロイ後に `https://wiki.example.com/_auth/login` を開くと、Access の認証を経てログインします。

owner のセッションを切るときは、次のようにします。

- `SESSION_SECRET` を入れ替えると、発行済みのセッション cookie はすべてすぐに無効になります。
  cookie や秘密が漏れたときは、手順 7 と同じコマンドで新しい値を入れます
- wiki のログアウトは、wiki の cookie だけを消します。
  Access のセッションは `https://wiki.example.com/cdn-cgi/access/logout` を開くと切れます

### 添付（R2）

画像の添付に使います。

1. ダッシュボードで R2 を有効にする
2. バケットを作る

   ```sh
   pnpm exec wrangler r2 bucket create personal-wiki --update-config=false
   ```

3. バケット名を `deploy.env` の `R2_BUCKET_NAME` に書き、`pnpm deploy:remote` を実行する

API の使い方と公開範囲は [attachments.md](./attachments.md) にあります。

### OAuth（claude.ai などのカスタムコネクタ）

claude.ai や Claude Desktop のカスタムコネクタから OAuth で MCP に接続するときだけ必要です。
同意画面は owner のセッションを使うので、上の owner のログインも設定します。

1. KV namespace を作る

   ```sh
   pnpm exec wrangler kv namespace create personal-wiki-oauth --update-config=false
   ```

2. 表示された `id` を `deploy.env` の `OAUTH_KV_NAMESPACE_ID` に書き、`pnpm deploy:remote` を実行する

接続の扱いは次のとおりです。

- claude.ai の戻り先は既定で許可しています。
  ほかのクライアントから接続するときだけ、redirect URI を `OAUTH_REDIRECT_URIS`（カンマ区切り、完全一致）に足します
- client の登録は、redirect URI が許可したものだけを受け付け、1 日（UTC）に 20 件までです。
  上限に達した日は、新しい接続だけが止まります
- 許可した接続は `https://wiki.example.com/_auth/oauth/grants` で見て、取り消せます。
  取り消すと、その接続のトークンはすぐに使えなくなります
- 同じクライアント（`client_id`）を同意画面で許可し直すと、以前の許可とトークンは自動で取り消されます
- API token による接続は、KV と owner のログインが無くても使えます

### リンクの書き換えの自動実行（Cron）

title を変えると、他のページの `[[旧 title]]` を書き換える仕事が積まれます。
owner がブラウザで開いていれば画面が進めますが、MCP 経由の rename では積まれたまま残ります。
`deploy.env` の `LINK_REWRITE_CRON` に cron 式（5 フィールド。例 `*/5 * * * *`）を書いてデプロイすると、1 回の発火で 1 リンク元ずつ進めます。

Cron Trigger はアカウント全体で 5 本までなので、既定は空です。
空のままデプロイすると、Cron を付けず、デプロイ済みの Cron も外します。
推奨は `* * * * *` か `*/5 * * * *` です。
積んだ分が無い発火の D1 の読み取りは数行で、毎分でも 1 日 1,500 行ほどに収まります。

Cron を使わないときの進め方と、Cron が飛ばしたページの扱いは [operations.md](./operations.md) の「リンクの書き換え」にあります。

## ゾーンの WAF、レート制限、Bot の設定

ゾーン単位の WAF のルール、レート制限、Bot の設定は wrangler の外にあり、このリポジトリは作りも変えもしません。
使うときは、wiki への次の影響に気をつけます。

- MCP のクライアントと OAuth の接続は、challenge を解けません。
  国や IP で challenge をかけるルールでは、`/mcp`、`/.well-known/`、`/_auth/oauth/token`、`/_auth/oauth/register` を除きます。
  `/_auth/oauth/authorize` の同意画面はブラウザで開くので、challenge を受けても進めます
- Bot Fight Mode は、パスを除いて外すことができず、MCP と API への接続も challenge します。
  MCP や REST をエージェントから使うなら無効にします
- `/api/` にかかるレート制限には、`derived:rebuild --remote` と `link-rewrites --remote` の連続した要求も当たります。
  当たると `server returned 429` で止まるので、少し待ってから [operations.md](./operations.md) の手順で続きから再開します

## 更新

新しい版に更新するときは、取得と `pnpm install` のあと、`apps/worker` で毎回次の 3 つを順に実行します。
`derived:rebuild` は環境変数 `WIKI_TOKEN` から write の token を読みます。

```sh
pnpm db:migrate:remote
pnpm deploy:remote
pnpm derived:rebuild --remote
```

migration は派生データの表を足すことがあります。
デプロイが先だと、新しい版が使う表がまだ無く、保存と一覧がエラーで止まります。
新しい版が派生データの表や作り方を変えても、既存のページの分は作り直すまで古いまま（または空のまま）残ります。
`derived:rebuild` はこれを本文から作り直します。
migration の前からあるページは、これを回すまで一覧に抜粋が出ません。
作り直しの内容は [operations.md](./operations.md) の「派生データの作り直し」にあります。

## 前の版に戻す

Worker を前の版に戻して再デプロイしたあとは、次の点に注意します。

- `derived:rebuild` を実行します。
  前の版は新しい派生データ（抜粋など）を書かないので、戻している間に保存したページの分が古いまま残ります。
  添付の参照も同じで、戻している間に本文から外した添付は、`derived:rebuild` を回すまで匿名に読めるまま残ります
- リンクの書き換えの step（`POST /api/link-rewrites/step`）が無い版では、step が 404 になり、rename しても書き換えは積まれません。
  戻している間に変えた title へのリンクは、手で直します
- Cron の予約は script の設定なので、`scheduled` の無い版に戻しても残り、発火ごとにエラーになります。
  前の版の deploy は予約に触れないので、外すならダッシュボードで外します
- 新規作成が `/?new` の画面でない版に戻すと、web は localStorage の `personal-wiki:draft:new:` で始まる key（作れなかった新規作成の内容の退避）を読みません。
  退避はブラウザに残り、今の版に戻すと、次に + で開いた新規作成の画面で復元を尋ねます
