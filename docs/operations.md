# 運用

デプロイ済みの wiki で行う作業である。
デプロイと更新の手順は [deploy.md](./deploy.md) にある。

コマンドは `apps/worker` で実行する。
`--remote` を付けると、`deploy.env` のデプロイ先（API を呼ぶコマンドでは `WIKI_HOSTNAME`、D1 を直接操作するコマンドでは D1）が対象になる。
付けないとローカルが対象である。

## API token

REST と MCP の認証に使う。

```sh
pnpm api-token issue <name> --scopes read|read,write [--remote]
pnpm api-token revoke <name> | --id <id> [--remote]
pnpm api-token list [--remote]
```

- token を識別するのは id である。
  name は重複してよいラベルで、失効させた token と同じ名前でも発行し直せる
- 平文は発行時に標準出力へ 1 度だけ出る。
  発行した id と、同じ名前でほかに有効な token の id は標準エラー出力に出る。
  D1 に入るのは hash だけである。
  標準出力をパイプに渡すときは、pnpm の表示が混ざらないよう `pnpm -s api-token` で呼ぶ
- `revoke <name>` は、その名前で有効な token が 1 本だけのときに失効させる。
  2 本以上あるときは何も変えずに id を並べて止まるので、`list` で確かめて `revoke --id <id>` で選ぶ
- `list` は id、name、scope と、発行、最後に使った、失効の各時刻を出す。
  hash は出さない。
  最後に使った時刻は 1 時間ごとにしか更新しないので、最大 1 時間遅れる
- `revisions.actor` などに残る書き手は `token:<id>:<name>` である。
  name が一意だったころに書いた行は `token:<name>` のままで、その名前を持っていた最初の token を指す
- `read` の token は、write が要る REST の操作（403）と MCP のツール（エラー）を呼べない

token を使うスクリプト（`derived:rebuild`、`link-rewrites`）は、環境変数 `WIKI_TOKEN` から write の token を読む。
平文をコマンド行に書かず、シェルの履歴に残らないよう次のように入れる。

```sh
read -rs WIKI_TOKEN && export WIKI_TOKEN
```

## 派生データの作り直し

```sh
pnpm derived:rebuild [--remote] [--url <base>] [--after <id>]
```

links、tags、添付の参照、一覧の抜粋、検索の索引を、本文から作り直す。
API は `POST /api/admin/derived/rebuild` で、CPU の上限に収まるよう 1 回の呼び出しで 1 ページずつ進める。
スクリプトは、応答の `next` が null になるまで繰り返して全ページ分を回す。

- 既定の送り先はローカルの `wrangler dev`（`http://localhost:8787`）である。
  `--remote` は `WIKI_HOSTNAME`、`--url` は指定したオリジンに送る（`--remote` とは同時に使えない）。
  token を平文で送らないよう、`--url` の http は `localhost`、`127.0.0.1`、`[::1]` だけを受け付ける
- 途中で止まったときは、表示される `--after <id>` を付けて続きから再開する
- 失敗したページがあると、その id を標準エラーに出して終了コード 1 になる

実行するのは次のときである。

- migration が派生データの表を足した更新のあと（[deploy.md](./deploy.md) の「更新」）
- Worker を前の版に戻して再デプロイしたあと（[deploy.md](./deploy.md) の「前の版に戻す」）
- バックアップから復元したあと。
  復元した直後は、一覧の抜粋、backlink、タグ、検索が空で、匿名には画像も 404 になる（配信の判定に使う添付の参照が空のため）

## リンクの書き換え

title を変えると、他のページの `[[旧 title]]` を書き換える仕事が `link_rewrites` に積まれる。
積まれた仕事は、ブラウザで開いている画面と Cron が進める。
画面は `POST /api/link-rewrites/step` を呼んで 1 回に 1 ページずつ書き換え、Cron（[deploy.md](./deploy.md) の「リンクの書き換えの自動実行（Cron）」）は発火ごとに 1 リンク元を進める。

手動で最後まで進めるには、write の token で次を実行する。

```sh
pnpm link-rewrites [--remote] [--url <base>] [--target <page id>]
```

- `--remote` と `--url` の送り先と制限は、`derived:rebuild` と同じである
- 応答の `remaining` が 0 になるまで step を呼ぶ。
  `--target` を付けると、そのページの rename で積まれた分だけを進める
- 書き換えると他のリンクやタグが変わるページ、書き換えた本文が上限（64 KiB）を超えるページ、3 回試しても処理が終わらなかったページは、書き換えずに飛ばす。
  その id を標準エラーに出して、終了コード 1 になる
- 5xx などで途中で止まったときも終了コード 1 になる。
  積んだ分は D1 に残るので、同じコマンドを再実行すれば続きから進む。
  飛ばしたページの id は、止まる前の分も標準エラーに出ている
- 試行の回数は再実行でも引き継ぐ。
  同じページで 5xx が 3 回続くと、そのページは飛ばす
- 書き換え先のページが保存され続けて版の競合が 5 回続くと、スクリプトは止まる

Cron が飛ばしたページ（D1 の一時的な失敗が 3 発火続いた分を含む）は、Worker のログ（`wrangler tail` の `link_rewrites.failed`）にしか出ない。
`link-rewrites` でも拾えないので、気づいたら手で直す。
`link_rewrites.scheduled_error` の `sourcePageId` は、その発火で選んだリンク元である。
書き換えが済んでいることもある。

## バックアップと復元

D1 の Time Travel は Free で 7 日までしか遡れない。
それより古い状態に戻せるよう、定期的に手元へダンプを残す。

```sh
pnpm backup [--remote] [--out <dir>] [--with-tokens]
pnpm backup load <dir> [--remote]
```

### 取る

出力先は `apps/worker/backups/<UTC の日時>-remote/`（gitignore 済み。ローカルの D1 は `-local`）で、`data.sql` と `manifest.json` ができる。
`--out <dir>` で変えるときは、追跡される場所に置かない。
相対パスの起点はコマンドを実行したディレクトリ（pnpm なら `apps/worker`）で、`-` で始まる値は受け付けない。
`data.sql` は draft の本文を含むので、扱いに気を付ける。

- ダンプするのは `pages`、`revisions`、`attachments` だけである。
  links、tags、添付の参照、抜粋、検索の索引は本文から作り直せるので出さない
- 待っているリンクの書き換え（`link_rewrites`）も出さない。
  復元すると、その分は本文に旧 title のリンクとして残る。
  残さないには、`pnpm backup --remote` の前に `pnpm link-rewrites --remote` で残りを 0 にする
- `api_tokens` は token の hash を含むので、既定では出さない。
  復元後に token を発行し直す。
  このとき id は 1 から振り直されるので、前と同じ名前で発行すると `revisions.actor` の `token:<id>:<name>` が前の token の操作と重なることがある。
  前と違う名前を使うか、`--with-tokens` で戻す。
  hash ごと戻したいときだけ `--with-tokens` を付け、ダンプを秘密として扱う。
  この場合は `api-token issue` を省ける
- `manifest.json` に、読んだ時点の migration の一覧と、表ごとの行数と全列の SHA-256 を書く
- R2 は対象外である。
  `attachments` の表（添付の名前と種類）は入るが、画像の中身は入らない

`wrangler d1 export` は使わない。
export の形式は、本文にもとからある 2 文字の `\n` を、改行を逃がした `\n` と区別せず、復元後に本物の改行へ変える。
代わりに `SELECT` で読み、文字列の列を `hex()` で受けて `CAST(X'…' AS TEXT)` の INSERT にする。
この形なら、NUL を含むどんな本文も変わらない。
1 文は D1 の上限（100 KB）に収まるよう、本文を分けて `UPDATE` で連結する。

読む間も保存は続く。
`pages` を先に読み、`revisions` はその `pages` の版までのものだけを書く。
読んだあとに作られたページと保存された版は、そのバックアップに入らない（件数は終了時に表示する）。
owner の保存は、まとまりの最初の保存から 10 分以内の保存を 1 つの revision にまとめるため、最新の revision の版を進める。
読む間にそれが起きたページは、最新のまとまりの revision がバックアップから欠けることがある（外した行は終了時の件数に含む）。
本文は `pages` に入っているので、`load` は失敗しない。
ページ同士の時点は揃わない。
読む間に削除や改名で title を手放したページがあり、後で読んだページがその title を取ると、生きたページの title がダンプの中で重なる。
これを見つけたら "pages changed while reading" で失敗し、出力は残さないので、そのまま再実行する。
書き込みの多い時間帯は、読む間に変わるページが増えるので避ける。

### 復元する

復元は、空の新しい D1 に対して行う。
`load` は次を行う。

- 復元先の migration の一覧が、バックアップの時点のものを先頭に含まなければ止める（復元先が先に進んでいるのは許す）
- 対象の表が空でなければ止める
- 流し込んだあとに、復元先から読み直して行数と SHA-256 を `manifest.json` と照合する
- バックアップより後の migration が保存値の規則を変えていれば、照合のあとにその書き換えを当てる（`0008_title_key_underscore.sql` の title_key）。
  `_` と空白だけが違う title のページが両方あると止まり、流し込んだ行は残る。
  エラーに重なっているページの id と title が出る。
  `deploy:remote` のあとに `/p/<id>` からどちらかの title を変え、表示された SQL を `wrangler d1 execute` で実行し、最後に `derived:rebuild` を実行する。
  重なりを探し直す SQL は [deploy.md](./deploy.md) の「title の `_` と空白をそろえる migration」にある

```sh
pnpm exec wrangler d1 create <名前> --update-config=false  # 表示された database_id と <名前> を deploy.env の D1_DATABASE_ID と D1_DATABASE_NAME に書く
pnpm db:migrate:remote
pnpm backup load backups/<ダンプのディレクトリ> --remote
pnpm deploy:remote
pnpm -s api-token issue <name> --scopes read,write --remote  # --with-tokens で戻したなら不要
pnpm derived:rebuild --remote  # WIKI_TOKEN に write の token を入れて実行する
```

- `derived:rebuild` を回すまで、一覧の抜粋、backlink、タグ、検索は空のままである。
  匿名には画像も 404 になる
- 画像の中身はバックアップに入らないので、R2 にあるものを使う。
  復元後も、前と同じバケットを `R2_BUCKET_NAME` に書く
- 元の D1 に、バックアップを取ってから `deploy:remote` までの間に入った書き込みは移らない
- `load` が wrangler の失敗で止まったときは、同じコマンドで再試行できる。
  ローカルの D1 では、失敗した SQL ファイルは全体が巻き戻り、表は空のまま残る。
  remote で表が空でなくなっていたら（`load` が not empty で拒否する）、新しい D1 を作り直して最初からやり直す
