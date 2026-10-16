# 運用

デプロイ済みの wiki で行う作業です。
デプロイと更新の手順は [deploy.md](./deploy.md) にあります。

コマンドは `apps/worker` で実行します。
`--remote` を付けると、`deploy.env` のデプロイ先（API を呼ぶコマンドでは `WIKI_HOSTNAME`、D1 を直接操作するコマンドでは D1）が対象になります。
付けないとローカルが対象です。

## API token

REST と MCP の認証に使います。

```sh
pnpm api-token issue <name> --scopes read|read,write [--remote]
pnpm api-token revoke <name> | --id <id> [--remote]
pnpm api-token list [--remote]
```

- token を識別するのは id です。
  name は重複してよいラベルで、失効させた token と同じ名前でも発行し直せます
- 平文は発行時に標準出力へ 1 度だけ出ます。
  発行した id と、同じ名前でほかに有効な token の id は標準エラー出力に出ます。
  D1 に入るのは hash だけです。
  標準出力をパイプに渡すときは、pnpm の表示が混ざらないよう `pnpm -s api-token` で呼びます
- `revoke <name>` は、その名前で有効な token が 1 本だけのときに失効させます。
  2 本以上あるときは何も変えずに id を並べて止まるので、`list` で確かめて `revoke --id <id>` で選びます
- `list` は id、name、scope と、発行、最後に使った、失効の各時刻を出します。
  hash は出しません。
  最後に使った時刻は 1 時間ごとにしか更新しないので、最大 1 時間遅れます
- `revisions.actor` などに残る書き手は `token:<id>:<name>` です。
  name が一意だったころに書いた行は `token:<name>` のままで、その名前を持っていた最初の token を指します
- `read` の token は、write が要る REST の操作（403）と MCP のツール（エラー）を呼べません

token を使うスクリプト（`derived:rebuild`、`link-rewrites`）は、環境変数 `WIKI_TOKEN` から write の token を読みます。
平文をコマンド行に書かず、シェルの履歴に残らないよう次のように入れます。

```sh
read -rs WIKI_TOKEN && export WIKI_TOKEN
```

## 派生データの作り直し

```sh
pnpm derived:rebuild [--remote] [--url <base>] [--after <id>]
```

links、tags、添付の参照、一覧の抜粋、検索の索引を、本文から作り直します。
API は `POST /api/admin/derived/rebuild` で、CPU の上限に収まるよう 1 回の呼び出しで 1 ページずつ進めます。
スクリプトは、応答の `next` が null になるまで繰り返して全ページ分を回します。

- 既定の送り先はローカルの `wrangler dev`（`http://localhost:8787`）です。
  `--remote` は `WIKI_HOSTNAME`、`--url` は指定したオリジンに送ります（`--remote` とは同時に使えません）。
  token を平文で送らないよう、`--url` の http は `localhost`、`127.0.0.1`、`[::1]` だけを受け付けます
- 途中で止まったときは、表示される `--after <id>` を付けて続きから再開します
- 失敗したページがあると、その id を標準エラーに出して終了コード 1 になります

実行するのは次のときです。

- migration が派生データの表を足した更新のあと（[deploy.md](./deploy.md) の「更新」）
- Worker を前の版に戻して再デプロイしたあと（[deploy.md](./deploy.md) の「前の版に戻す」）
- バックアップから復元したあと。
  復元した直後は、一覧の抜粋、backlink、タグ、検索が空で、匿名には画像も 404 になります（配信の判定に使う添付の参照が空のため）

## リンクの書き換え

title を変えると、他のページの `[[旧 title]]` を書き換える仕事が `link_rewrites` に積まれます。
積まれた仕事は、ブラウザで開いている画面と Cron が進めます。
画面は `POST /api/link-rewrites/step` を呼んで 1 回に 1 ページずつ書き換え、Cron（[deploy.md](./deploy.md) の「リンクの書き換えの自動実行（Cron）」）は発火ごとに 1 リンク元を進めます。

手動で最後まで進めるには、write の token で次を実行します。

```sh
pnpm link-rewrites [--remote] [--url <base>] [--target <page id>]
```

- `--remote` と `--url` の送り先と制限は、`derived:rebuild` と同じです
- 応答の `remaining` が 0 になるまで step を呼びます。
  `--target` を付けると、そのページの rename で積まれた分だけを進めます
- 書き換えると他のリンクやタグが変わるページ、書き換えた本文が上限（64 KiB）を超えるページ、3 回試しても処理が終わらなかったページは、書き換えずに飛ばします。
  その id を標準エラーに出して、終了コード 1 になります
- 5xx などで途中で止まったときも終了コード 1 になります。
  積んだ分は D1 に残るので、同じコマンドを再実行すれば続きから進みます。
  飛ばしたページの id は、止まる前の分も標準エラーに出ています
- 試行の回数は再実行でも引き継ぎます。
  同じページで 5xx が 3 回続くと、そのページは飛ばします
- 書き換え先のページが保存され続けて版の競合が 5 回続くと、スクリプトは止まります

Cron が飛ばしたページ（D1 の一時的な失敗が 3 発火続いた分を含む）は、Worker のログ（`wrangler tail` の `link_rewrites.failed`）にしか出ません。
`link-rewrites` でも拾えないので、気づいたら手で直します。
`link_rewrites.scheduled_error` の `sourcePageId` は、その発火で選んだリンク元です。
書き換えが済んでいることもあります。

## バックアップと復元

D1 の Time Travel は Free で 7 日までしか遡れません。
それより古い状態に戻せるよう、定期的に手元へダンプを残します。

```sh
pnpm backup [--remote] [--out <dir>] [--with-tokens]
pnpm backup load <dir> [--remote]
```

### 取る

出力先は `apps/worker/backups/<UTC の日時>-remote/`（gitignore 済み。ローカルの D1 は `-local`）で、`data.sql` と `manifest.json` ができます。
`--out <dir>` で変えるときは、追跡される場所に置きません。
相対パスの起点はコマンドを実行したディレクトリ（pnpm なら `apps/worker`）で、`-` で始まる値は受け付けません。
`data.sql` は draft の本文を含むので、扱いに気を付けてください。

- ダンプするのは `pages`、`revisions`、`attachments` だけです。
  links、tags、添付の参照、抜粋、検索の索引は本文から作り直せるので出しません
- 待っているリンクの書き換え（`link_rewrites`）も出しません。
  復元すると、その分は本文に旧 title のリンクとして残ります。
  残さないには、`pnpm backup --remote` の前に `pnpm link-rewrites --remote` で残りを 0 にします
- `api_tokens` は token の hash を含むので、既定では出しません。
  復元後に token を発行し直します。
  このとき id は 1 から振り直されるので、前と同じ名前で発行すると `revisions.actor` の `token:<id>:<name>` が前の token の操作と重なることがあります。
  前と違う名前を使うか、`--with-tokens` で戻します。
  hash ごと戻したいときだけ `--with-tokens` を付け、ダンプを秘密として扱います。
  この場合は `api-token issue` を省けます
- `manifest.json` に、読んだ時点の migration の一覧と、表ごとの行数と全列の SHA-256 を書きます
- R2 は対象外です。
  `attachments` の表（添付の名前と種類）は入りますが、画像の中身は入りません

`wrangler d1 export` は使いません。
export の形式は、本文にもとからある 2 文字の `\n` を、改行を逃がした `\n` と区別せず、復元後に本物の改行へ変えます。
代わりに `SELECT` で読み、文字列の列を `hex()` で受けて `CAST(X'…' AS TEXT)` の INSERT にします。
この形なら、NUL を含むどんな本文も変わりません。
1 文は D1 の上限（100 KB）に収まるよう、本文を分けて `UPDATE` で連結します。

読む間も保存は続きます。
`pages` を先に読み、`revisions` はその `pages` の版までのものだけを書きます。
読んだあとに作られたページと保存された版は、そのバックアップに入りません（件数は終了時に表示します）。
owner の保存は、まとまりの最初の保存から 10 分以内の保存を 1 つの revision にまとめるため、最新の revision の版を進めます。
読む間にそれが起きたページは、最新のまとまりの revision がバックアップから欠けることがあります（外した行は終了時の件数に含みます）。
本文は `pages` に入っているので、`load` は失敗しません。
ページ同士の時点は揃いません。
読む間に削除や改名で title を手放したページがあり、後で読んだページがその title を取ると、生きたページの title がダンプの中で重なります。
これを見つけたら "pages changed while reading" で失敗し、出力は残さないので、そのまま再実行します。
書き込みの多い時間帯は、読む間に変わるページが増えるので避けます。

### 復元する

復元は、空の新しい D1 に対して行います。
`load` は次を行います。

- 復元先の migration の一覧が、バックアップの時点のものを先頭に含まなければ止めます（復元先が先に進んでいるのは許します）
- 対象の表が空でなければ止めます
- 流し込んだあとに、復元先から読み直して行数と SHA-256 を `manifest.json` と照合します
- バックアップより後の migration が保存値の規則を変えていれば、照合のあとにその書き換えを当てます（`0008_title_key_underscore.sql` の title_key）。
  `_` と空白だけが違う title のページが両方あると止まり、流し込んだ行は残ります。
  エラーに重なっているページの id と title が出ます。
  `deploy:remote` のあとに `/p/<id>` からどちらかの title を変え、表示された SQL を `wrangler d1 execute` で実行し、最後に `derived:rebuild` を実行します。
  重なりを探し直す SQL は [deploy.md](./deploy.md) の「title の `_` と空白をそろえる migration」にあります

```sh
pnpm exec wrangler d1 create <名前> --update-config=false  # 表示された database_id と <名前> を deploy.env の D1_DATABASE_ID と D1_DATABASE_NAME に書く
pnpm db:migrate:remote
pnpm backup load backups/<ダンプのディレクトリ> --remote
pnpm deploy:remote
pnpm -s api-token issue <name> --scopes read,write --remote  # --with-tokens で戻したなら不要
pnpm derived:rebuild --remote  # WIKI_TOKEN に write の token を入れて実行する
```

- `derived:rebuild` を回すまで、一覧の抜粋、backlink、タグ、検索は空のままです。
  匿名には画像も 404 になります
- 画像の中身はバックアップに入らないので、R2 にあるものを使います。
  復元後も、前と同じバケットを `R2_BUCKET_NAME` に書きます
- 元の D1 に、バックアップを取ってから `deploy:remote` までの間に入った書き込みは移りません
- `load` が wrangler の失敗で止まったときは、同じコマンドで再試行できます。
  ローカルの D1 では、失敗した SQL ファイルは全体が巻き戻り、表は空のまま残ります。
  remote で表が空でなくなっていたら（`load` が not empty で拒否します）、新しい D1 を作り直して最初からやり直します
