# デプロイ

Cloudflare アカウントへのデプロイと、任意の機能の設定、更新の手順である。
運用中の作業（token、派生データ、バックアップなど）は [operations.md](./operations.md) にある。

コマンドは、特に断らない限り `apps/worker` で実行する。
`wiki.example.com` は、自分のホスト名（`WIKI_HOSTNAME`）に読み替える。

## 必要なもの

- Cloudflare アカウント
- 公開するホスト名のゾーン。デプロイ先と同じ Cloudflare アカウントの DNS にあること
- Node 24 系（`>=24.22 <25`）
- pnpm（バージョンは `package.json` の `packageManager`）
- git、openssl（`SESSION_SECRET` を作るとき）

## 無料枠の資源

| 機能 | 使う資源 |
| --- | --- |
| 本体 | Workers（API と、Static Assets で配信する SPA） |
| ページ、版、API token | D1 |
| 添付（任意） | R2。ダッシュボードで R2 を有効にする必要があり、有効化の際に支払い情報の登録を求められることがある |
| OAuth の接続（任意） | Workers KV。書き込みの上限が小さいので、使い方の見積もりは `apps/worker/src/auth/oauth-server.ts` の冒頭にある |
| リンクの書き換えの自動実行（任意） | Cron Trigger。アカウント全体で 5 本までである |
| owner のログイン（任意） | Cloudflare Zero Trust の Access。組織を作る際に支払い情報の登録を求められることがある |

各機能の上限とプランの条件は Cloudflare の最新の案内で確かめる。

## 初回のデプロイ

ホスト名と D1 の ID は `apps/worker/deploy.env`（gitignore 済み）に書き、追跡される `wrangler.jsonc` には書かない。
`pnpm deploy:remote` と `pnpm db:migrate:remote` は、`wrangler.jsonc` に `deploy.env` の値を重ねた設定を `wrangler.deploy.json`（gitignore 済み）に作って wrangler に渡す。
デプロイでは wrangler の自動プロビジョニングを無効にするので、D1、R2、KV は手順で作ったものだけを使う。
各項目の詳細と注意は `node scripts/deploy.mjs --help` に載せている。

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

`--update-config=false` を付けないと、wrangler が追跡対象の `wrangler.jsonc` に binding を書き込む。
表示された `database_id` を次の手順で使う。

### 3. `deploy.env` を書く

```sh
cp deploy.env.example deploy.env
```

最低限、次の 2 つを書く。

- `WIKI_HOSTNAME`: 公開するホスト名（スキームとパスは含めない）
- `D1_DATABASE_ID`: 手順 2 の `database_id`

そのほかの項目（サイト名、サイトの説明文、R2、OAuth、Cron、owner のログイン、複数アカウントのときの `CLOUDFLARE_ACCOUNT_ID`）は `deploy.env.example` のコメントに書いてあり、後の「任意の機能」で使う。
`R2_BUCKET_NAME` と `OAUTH_KV_NAMESPACE_ID` が空なら、その binding を付けずにデプロイする。

### 4. migration とデプロイ

```sh
pnpm db:migrate:remote
pnpm deploy:remote
```

`deploy:remote` は先に `apps/web` をビルドする。
migration を先にするのは、デプロイが先だと新しい版が使うテーブルがまだ無く、保存と一覧がエラーで止まるためである。
owner のログインや OAuth を設定していない間は `warning:` が標準エラーに出るが、デプロイは続く。

### 5. API token を発行する

```sh
pnpm -s api-token issue <name> --scopes read,write --remote
```

token の平文は標準出力に 1 度だけ出るので控える。
token の id は標準エラー出力に出る。
token の扱いは [operations.md](./operations.md) の「API token」を参照する。

ここまでで REST と MCP が使える（MCP の接続は [README](../README.md) の「MCP への接続」）。
ブラウザで編集するには、次の owner のログインが要る。

## 任意の機能

各節の手順を終えて `pnpm deploy:remote` を実行し直すと有効になる。
`deploy.env` の値を空に戻して再デプロイすると外れる（secret は残るが、使われない）。

### owner のログイン（ブラウザでの閲覧と編集）

ログインは Cloudflare Access を使う。
Access が保護するのは `/_auth/login` だけで、Worker は Access が付ける JWT を自分で検証してから、`SESSION_SECRET` で署名したセッション cookie を発行する。

1. Cloudflare Zero Trust のチーム名を確かめる。
   `<team>.cloudflareaccess.com` が `ACCESS_TEAM_DOMAIN` になる
2. Access のアプリケーションを作る。
   対象は、ホスト名 `WIKI_HOSTNAME` のパス `/_auth/login` だけにする
3. そのアプリケーションのポリシーで、owner のメールアドレスだけを許可する。
   ログイン方法には、メールアドレスを検証する IdP（One-time PIN、Cloudflare アカウントでのログインなど）を使う。
   Worker は JWT の email を信じて owner にするためである
4. アプリケーションの Application Audience (AUD) タグを `ACCESS_AUD` に書く。
   アプリケーションを作り直すと AUD が変わり、`ACCESS_AUD` を書き直して再デプロイするまでログインできない
5. owner のメールアドレスを `OWNER_EMAILS` に書く（複数ならカンマ区切り）
6. `pnpm deploy:remote` を実行する
7. セッション cookie の署名鍵（32 文字以上）を secret で入れる。
   `deploy.env` には書かない

   ```sh
   openssl rand -base64 32 | pnpm exec wrangler secret put SESSION_SECRET --config wrangler.deploy.json
   ```

`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`OWNER_EMAILS` は、3 つとも書くか、3 つとも空にする。
一部だけだと `deploy.env` の検査で止まる。
`SESSION_SECRET` が無い、または 32 文字未満のあいだは、3 つを書いてもログインできない。

デプロイ後に `https://wiki.example.com/_auth/login` を開くと、Access の認証を経てログインする。

owner のセッションを切るときは、次のようにする。

- `SESSION_SECRET` を入れ替えると、発行済みのセッション cookie はすべてすぐに無効になる。
  cookie や秘密が漏れたときは、手順 7 と同じコマンドで新しい値を入れる
- wiki のログアウトは、wiki の cookie だけを消す。
  Access のセッションは `https://wiki.example.com/cdn-cgi/access/logout` を開くと切れる

### 添付（R2）

画像の添付に使う。

1. ダッシュボードで R2 を有効にする
2. バケットを作る

   ```sh
   pnpm exec wrangler r2 bucket create personal-wiki --update-config=false
   ```

3. バケット名を `deploy.env` の `R2_BUCKET_NAME` に書き、`pnpm deploy:remote` を実行する

API の使い方と公開範囲は [attachments.md](./attachments.md) にある。

### OAuth（カスタムコネクタ、コーディングエージェント）

claude.ai や Claude Desktop のカスタムコネクタ、Claude Code や Codex などのコーディングエージェントから OAuth で MCP に接続するときだけ必要である。
同意画面は owner のセッションを使うので、上の owner のログインも設定する。

1. KV namespace を作る

   ```sh
   pnpm exec wrangler kv namespace create personal-wiki-oauth --update-config=false
   ```

2. 表示された `id` を `deploy.env` の `OAUTH_KV_NAMESPACE_ID` に書き、`pnpm deploy:remote` を実行する

接続の扱いは次のとおりである。

- claude.ai のリダイレクト先は既定で許可している。
  ほかのクライアントから接続するときだけ、redirect URI を `OAUTH_REDIRECT_URIS`（カンマ区切り、完全一致）に足す。
  コーディングエージェントの足し方は、次の「コーディングエージェントから接続する」にある
- client の登録は、redirect URI が許可したものだけを受け付け、1 日（UTC）に 20 件までである。
  上限に達した日は、新しい接続だけが止まる
- 同意画面では、「接続するアプリ」の名前と「トークンの送り先」を確かめ、「読み取り」か「読み書き」を選んで許可する。
  「読み書き」は、ページの作成と書き換えを許す。公開中のページも書き換えられる。削除、画像の添付、公開と下書きの切り替えはできない
- 許可した接続は `https://wiki.example.com/_auth/oauth/grants` で見て、取り消せる。
  取り消すと、その接続のトークンはすぐに使えなくなる
- 同意画面と一覧に出る `client_id` が同じアプリを許可し直すと、以前の許可とトークンは自動で取り消される。
  アプリが登録をやり直して `client_id` が変わると、以前の許可は残るので、一覧から取り消す
- API token による接続は、KV と owner のログインが無くても使える

#### コーディングエージェントから接続する

Claude Code や Codex などの CLI のエージェントは、OAuth の callback を手元の loopback のポートで受ける。
この wiki は client の登録で redirect URI を完全一致で比べるので、ポート番号も一致しなければ登録を断る。
ポートを固定しないと接続のたびに別の URI で登録することになり、`OAUTH_REDIRECT_URIS` に書いた値と一致しない。
そこで、エージェントの callback のポートを固定し、その redirect URI を 1 つ `OAUTH_REDIRECT_URIS` に足して再デプロイする。
同じ redirect URI を使うエージェントどうしは、その URI を `OAUTH_REDIRECT_URIS` に 1 つ書けば足りる。
ただし同じポートで同時に待ち受けられないので、login は 1 つずつ行う。

1. `deploy.env` の `OAUTH_REDIRECT_URIS` に redirect URI を書き、`pnpm deploy:remote` を実行する。
   すでに値があるときは、カンマで区切って足す

   ```sh
   OAUTH_REDIRECT_URIS=http://localhost:8976/callback
   ```

2. エージェントの callback のポートを、手順 1 の URI のポートに固定して接続する。
   接続を始めるとブラウザで同意画面が開くので、「接続するアプリ」の名前と「トークンの送り先」を確かめ、「読み取り」か「読み書き」を選んで許可する

   - Claude Code は、登録のときに `--callback-port` を付ける。
     `claude mcp add` は設定を書くだけなので、Claude Code の中で `/mcp` からこのサーバーの認証を選ぶと、ブラウザが開く。

     ```sh
     claude mcp add --transport http --callback-port 8976 personal-wiki https://wiki.example.com/mcp
     ```

   - Codex は、サーバーを登録した後、login のときに `callback_port` と `callback_url` を `-c` で渡す。
     token の更新は redirect URI を使わないので、`-c` が要るのは login し直すときだけである。

     ```sh
     codex mcp add personal-wiki --url https://wiki.example.com/mcp
     codex mcp login personal-wiki \
       -c mcp_servers.personal-wiki.oauth.callback_port=8976 \
       -c 'mcp_servers.personal-wiki.oauth.callback_url="http://localhost:8976/callback"'
     ```

     `codex mcp add` は、OAuth に対応したサーバーにはその場で login を始める。
     ポートが固定されていないので、client の登録が「この wiki が許可していない redirect_uri です」（400）で断られ、add はエラーを出す。
     断られた登録は 1 日の登録数に数えず、サーバーの設定も残るので、このエラーは無視して `codex mcp login` に進む。

redirect URI は文字列で比べるので、`localhost` と `127.0.0.1` は別の値になる。
エージェントが送る URI のホスト、ポート、パスを、`OAUTH_REDIRECT_URIS` に書いた値と同じにする。
エージェントごとにポートを分けるときは、それぞれの URI を `OAUTH_REDIRECT_URIS` に足して再デプロイする。

### リンクの書き換えの自動実行（Cron）

title を変えると、他のページの `[[旧 title]]` を書き換えるジョブがキューに入る。
owner がブラウザで開いていれば画面が進め、MCP のクライアントは `rewrite_links` の tool で進められる。
どちらも使わなければ、キューに入ったまま残る。
`deploy.env` の `LINK_REWRITE_CRON` に cron 式（5 フィールド。例 `*/5 * * * *`）を書いてデプロイすると、1 回の発火で 1 リンク元ずつ進める。

Cron Trigger はアカウント全体で 5 本までなので、既定は空である。
空のままデプロイすると、Cron を付けず、デプロイ済みの Cron も外す。
推奨は `* * * * *` か `*/5 * * * *` である。
キューにジョブが無い発火の D1 の読み取りは数行で、毎分でも 1 日 1,500 行ほどに収まる。

Cron を使わないときの進め方と、Cron が飛ばしたページの扱いは [operations.md](./operations.md) の「リンクの書き換え」にある。

### サイト名

`deploy.env` の `SITE_NAME` に書いた名前が、サイト名として次の所に出る。
空のままなら `personal-wiki` である。

- 画面の左上のブランド
- ブラウザのタブの title（ページの URL では `ページの title - サイト名`、それ以外の URL ではサイト名だけ）
- MCP の server の表示名（`initialize` のレスポンスの `serverInfo.title`。`serverInfo.name` は識別子で、`personal-wiki` のまま変わらない）
- OAuth の保護されたリソースのメタデータの `resource_name`
- OAuth の同意画面、許可した接続の一覧、エラーの画面の上に出るブランド

リンクプレビューが読む `og:title` は、ページの URL ではページの title だけで、サイト名は含まない。
トップ（`/`）ではサイト名になる。
`og:site_name` は出さない。

名前は前後の空白を除き、40 文字以内（サロゲートペアは 1 文字）にする。
改行などの制御文字、U+2028 と U+2029、書式文字（RTL override などの文字の向きを変える文字、ゼロ幅空白、ソフトハイフンなど）は使えない。
絵文字の結合とペルシア語などの分かち書きに要る U+200C と U+200D だけは使える（タグ文字を使う地域の旗は使えない）。
ただし U+200C、U+200D、空白だけの名前は、何も見えないので使えない。
`pnpm deploy:remote` はこれらを含む名前を止め、Worker も同じ規則を満たさない名前は既定の名前に戻す。
`&` や `<` を含めても、HTML の title には文字参照にして入れる。

`deploy.env` は値を引用符で囲まないと、`#` 以降を行末のコメントとして読み捨てる（`SITE_NAME=My #1 wiki` は `My`）。
`#` を含む名前は `SITE_NAME="My #1 wiki"` のように全体を `"` で囲む。
囲まずに `#` を書くと、`pnpm deploy:remote` が止まる。

web には、`pnpm deploy:remote` が `apps/web` をビルドするときに名前を渡して埋め込む。
名前を変えたら、`pnpm deploy:remote` を実行し直す。
実行時に API で取る方式ではないので、初回の描画から名前が出て、後から入れ替わることはない。
`pnpm dev` と E2E は `deploy.env` を読まず、`personal-wiki` のままである。
シェルに `VITE_SITE_NAME` が残っていても、`pnpm dev`、E2E、web のテストはそれを使わない。
`apps/web/.env*` に `VITE_SITE_NAME` を書いても、ビルドは使わない（`<title>` と画面と Worker の値が分かれないよう、環境変数だけで決める）。

### サイトの説明文

`deploy.env` の `SITE_DESCRIPTION` に書いた文が、`/llms.txt` の H1（サイト名）の下に blockquote で出る。
トップの HTML には、`<meta name="description">` と `og:description` として同じ文が入る。
AI のエージェントに wiki の中身を伝える 1〜2 文の要約を想定する。
空のままなら blockquote も `<meta name="description">` も `og:description` も出さない。

説明文は前後の空白を除き、200 文字以内（サロゲートペアは 1 文字）にする。
使えない文字と、`#` を含むときに `"` で囲むことは、サイト名と同じである。
`pnpm deploy:remote` は規則を満たさない説明文を止め、Worker も規則を満たさない説明文を出さない。
説明文は Worker だけが読み、web には埋め込まない。
変えたら `pnpm deploy:remote` を実行し直す。

### リンクのプレビューの画像

`og:image` は、サイト全体で共通の 1200×1200 の PNG（`apps/web/public/og-image.png`）を、全部のページの URL とトップで絶対 URL にして指す。
サイト名や説明文を変えても画像は変わらない。
`og:image:width`、`og:image:height`、`og:image:alt` を添え、`twitter:card` は正方形の画像に合う `summary` である。
クエリ付きのトップ（`/?q=` など）、404、503 は、Static Assets の `index.html` をそのまま返すので出さない（`apps/worker/src/spa.ts`）。

画像は `favicon.svg` の輪郭をもとに、角の丸め（`rx`）を外して書き出す。
追加の依存は使わず、librsvg の `rsvg-convert` で次のように作る。

```sh
sed 's/ rx="7"//' apps/web/public/favicon.svg | rsvg-convert -w 1200 -h 1200 -o apps/web/public/og-image.png
```

Facebook などは画像を URL ごとに覚えるので、画像を差し替えるときは `apps/worker/src/page-html.ts` の `OG_IMAGE_PATH` を `/og-image.png?v=2` のように変える。
ファイル名を変えるなら、`wrangler.jsonc` の `run_worker_first` の除外と `RESERVED_TITLE_SEGMENTS` も合わせる（`apps/worker/scripts/public-assets.test.ts` が検査する）。

## ゾーンの WAF、レート制限、Bot の設定

ゾーン単位の WAF のルール、レート制限、Bot の設定は wrangler の外にあり、このリポジトリは作りも変えもしない。
使うときは、wiki への次の影響に気をつける。

- MCP のクライアントと OAuth の接続は、challenge を解けない。
  国や IP で challenge をかけるルールでは、`/mcp`、`/.well-known/`、`/_auth/oauth/token`、`/_auth/oauth/register` を除く。
  `/_auth/oauth/authorize` の同意画面はブラウザで開くので、challenge を受けても進める
- AI のエージェントが `/llms.txt` を、検索エンジンのクローラーが `/sitemap.xml` を取るときも、challenge を解けない。
  challenge をかけるルールでは、`/llms.txt` と `/sitemap.xml` も除く
- Bot Fight Mode は、パスを除いて外すことができず、MCP と API への接続も challenge する。
  MCP や REST をエージェントから使うなら無効にする
- `/api/` にかかるレート制限には、`derived:rebuild --remote` と `link-rewrites --remote` の連続したリクエストも当たる。
  当たると `server returned 429` で止まるので、少し待ってから [operations.md](./operations.md) の手順で続きから再開する
- クローラーと AI の取得への方針は robots.txt にあり、理由は [crawlers.md](./crawlers.md) に書いてある。
  ゾーンで bot を止めたり通したりするときは、その方針と食い違わないようにする

## Web Analytics

Cloudflare Web Analytics を使うときは、ダッシュボードの自動の設定（proxied のホストの HTML に Cloudflare が beacon を差し込む）を使う。
画面の CSP は差し込まれる beacon（`https://static.cloudflareinsights.com/beacon.min.js/` の下）を許してあり、beacon の送り先は自分のドメインの `/cdn-cgi/rum` なので、`deploy.env` などに足す設定は無い。
HTML に beacon のタグを手で書くと、自動の挿入と合わせて 1 ページに 2 つになるので書かない。
自動の設定は、絞らなければゾーンのすべてのホストに差し込む。
同じゾーンに別のサイトがあるなら、wiki のホストだけに絞る。
OAuth の同意画面などの認証の画面は CSP が beacon を止めるので、計測に出ない。
計測にはページの path が残るので、draft のページの title もダッシュボードに出る。
計測が急に 0 になったら、ブラウザのコンソールで beacon が CSP に止められていないかを見る（beacon の src の形が変わると、今の許可に当たらなくなる）。

## 更新

新しい版に更新するときは、取得と `pnpm install` のあと、`apps/worker` で毎回次を順に実行する。
`derived:rebuild` は環境変数 `WIKI_TOKEN` から write の token を読む。
token の扱いは [operations.md](./operations.md) の「API token」を参照する。

```sh
pnpm db:migrate:remote
pnpm deploy:remote
read -rs WIKI_TOKEN && export WIKI_TOKEN  # write の token を入れる
pnpm derived:rebuild --remote
```

`pnpm db:migrate:remote` の出力に `0008_title_key_underscore.sql` が出たときだけ、`pnpm deploy:remote` と `pnpm derived:rebuild --remote` の間に追加の手順が要る。
次の「title の `_` と空白をそろえる migration」の項に従う。

migration は派生データのテーブルを足すことがある。
デプロイが先だと、新しい版が使うテーブルがまだ無く、保存と一覧がエラーで止まる。
新しい版が派生データのテーブルや作り方を変えても、既存のページの分は作り直すまで古いまま（または空のまま）残る。
`derived:rebuild` はこれを本文から作り直す。
migration の前からあるページは、これを回すまで一覧に抜粋が出ず、一覧の各件に本文のハッシュ（`bodySha256`）も付かない。
作り直しの内容は [operations.md](./operations.md) の「派生データの作り直し」にある。

### title の `_` と空白をそろえる migration

`0008_title_key_underscore.sql` より前の版から更新するときだけの手順で、初回のデプロイでは要らない。

`0008_title_key_underscore.sql` から、title の重複の検査と title での参照は `_` と空白を同じ文字として扱う。
この migration は保存済みの title_key を新しい規則に書き換える。
`a_b` と `a b` のように `_` と空白だけが違う title のページが両方あると、`UNIQUE constraint failed` で止まる。
止まったときは migration 全体が巻き戻り、D1 は前のままである。
どちらかのページの title を変えてから、`pnpm db:migrate:remote` をもう一度実行する。
重なるページは次で探せる。

```sh
node scripts/deploy.mjs config
pnpm exec wrangler d1 execute DB --remote --config wrangler.deploy.json --command \
  "SELECT id, title FROM pages WHERE deleted_at IS NULL AND replace(title_key, '_', ' ') IN (SELECT replace(title_key, '_', ' ') FROM pages WHERE deleted_at IS NULL GROUP BY 1 HAVING count(*) > 1)"
```

links と待っているリンクの書き換えの key もこの migration が書き換える。
タグは `_` と空白を区別したままなので変わらない。

migration からデプロイまでの間は前の版の Worker が動いていて、この間のページの保存は title_key を古い規則で計算し直す。
本文だけの保存でも、`_` を含む title の key が `a_b` に戻る。
戻った key は title の変更とみなされ、他のページの `[[a_b]]` を書き換えるリンクの書き換えがキューに入る。
この migration を当てる更新では、`pnpm db:migrate:remote`、`pnpm deploy:remote` の順に実行したあと、次の SQL を 1 回実行して key をそろえ直す。
そのあとに `pnpm derived:rebuild --remote` を実行する。
`UNIQUE constraint failed` で止まったら、上と同じくどちらかのページの title を変えてから再実行する。

```sh
node scripts/deploy.mjs config
pnpm exec wrangler d1 execute DB --remote --config wrangler.deploy.json --command \
  "UPDATE pages SET title_key = replace(title_key, '_', ' ') WHERE instr(title_key, '_') > 0; UPDATE OR REPLACE link_rewrites SET old_title_key = replace(old_title_key, '_', ' ') WHERE instr(old_title_key, '_') > 0"
```

## 前の版に戻す

Worker を前の版に戻して再デプロイしたあとは、次の点に注意する。

- `derived:rebuild` を実行する。
  前の版は新しい派生データ（抜粋など）を書かないので、戻している間に保存したページの分が古いまま残る。
  添付の参照も同じで、戻している間に本文から外した添付は、`derived:rebuild` を回すまで匿名に読めるまま残る。
  本文のハッシュを書かない版に戻している間に保存したページは、今の版に戻したあと `derived:rebuild` が終わるまで、一覧の `bodySha256` が保存前の本文のハッシュのまま返る。
  デプロイの直後に、前の版がまだ処理しているリクエストで保存したページも同じになる。
  どちらも `derived:rebuild` で直る
- リンクの書き換えの step（`POST /api/link-rewrites/step`）が無い版では、step が 404 になり、rename しても書き換えはキューに入らない。
  戻している間に変えた title へのリンクは、手で直す
- Cron の予約は script の設定なので、`scheduled` の無い版に戻しても残り、発火ごとにエラーになる。
  前の版の deploy は予約に触れないので、外すならダッシュボードで外す
- 新規作成が `/?new` の画面でない版に戻すと、web は localStorage の `personal-wiki:draft:new:` で始まる key（作れなかった新規作成の内容の退避）を読まない。
  退避はブラウザに残り、今の版に戻すと、次に + で開いた新規作成の画面で復元を尋ねる
- `0008_title_key_underscore.sql` を当てたまま、`_` を空白と同じに扱わない版に戻すと、`_` を含む title のページを title で引けず、`[[a_b]]` も解決しない。
  重複の検査も `a b` があるのに `a_b` を作れるようになる。
  title_key は title を正規化した値で SQL では元の形に作り直せないので、戻さずに前へ進めて直す。
  戻している間は、`_` を含む title のページを保存するたびに（本文だけの保存でも）title_key が `a_b` に戻り、他のページの `[[a_b]]` を書き換えるリンクの書き換えがキューに入る。
  今の版に戻したら、戻している間に保存したページと、その間にキューに入ったリンクの書き換えの key を、「title の `_` と空白をそろえる migration」の項のそろえ直しの SQL でもう一度そろえ、`derived:rebuild` を実行する
- `/sitemap.xml` を返さない版に戻すと、`/sitemap.xml` は SPA に落ち、本番の robots.txt からも `Sitemap:` の行が消える。
  検索エンジンは robots.txt を読み直すまで、HTML の `/sitemap.xml` を取り続ける。
  戻している間は、title が `sitemap.xml` の public のページが `/sitemap.xml` で開く
- `0009_api_token_names.sql` を当てたまま、API token を id で識別しない版に戻すと、同じ名前の token の書き込みはどれも actor が `token:<name>` になり、どの token が書いたか区別できない。
  前の版の `pnpm api-token revoke <name>` は、同じ名前の有効な token をすべて失効させる。
  戻している間は同じ名前の token を発行せず、失効は今の版のスクリプトの `revoke --id` で行う
