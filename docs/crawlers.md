# クローラーと AI の取得

`apps/web/public/robots.txt` の各行の理由と、変えるときに合わせて直す場所を書く。
robots.txt は誰でも開いて読める公開のファイルなので、理由はファイルに書かず、ここに書く。
ファイルにはコメントを置かない。

## 方針

- AI の学習に使う bot は、名指しで断る
- 利用者の依頼でページを取りに来るチャットの取得と、検索のクローラーは止めない
- JS を実行するクローラーが画面を描画できるよう、描画で読む API だけを許す
- 名指ししていない学習用のクローラーには、Content-Signal で学習に使わないよう求める

robots.txt は、守る bot にだけ効く申告である。
アクセスを止める仕組みではないので、匿名で読めない内容は robots.txt に頼らず、Worker の認証と公開範囲で守る。

## 学習用の bot を名指しで断る

最初のグループ（`GPTBot`、`ClaudeBot`、`CCBot`、`Google-Extended`、`Applebot-Extended`、`Bytespider`、`meta-externalagent`）は、`Disallow: /` ですべてを断る。

public のページの HTML は、本文を `<pre>` と、実行されない `<script type="application/json">` に入れて返す（`apps/worker/src/page-html.ts`）。
JS を実行しない取得でも本文が読めるので、学習への利用は取得の側では防げず、robots.txt で断る。

名前が当たるグループがある bot は、`*` のグループに従わない（`*` を使うのは、名前の当たるグループが無いときだけである）。
このグループに挙げた bot には、`*` のグループの `Allow` と `Content-Signal` は適用されない。
学習用の bot を足すときは、このグループに `User-agent:` の行を足す。

`ChatGPT-User` や `Claude-User` のように利用者の依頼で取りに来るチャットの取得と、`Googlebot` や `OAI-SearchBot` のように検索の索引を作るクローラーは、別の User-agent を名乗る。
このグループに挙げていないので当たらず、`*` のグループに従う。
これらを断ると、公開したページが AI のチャットと検索の結果から読めなくなる。

## ページの描画で読む API だけを許す

`*` のグループは、`/api/me`、`/api/pages/`、`/api/tags` を許し、`/api/`、`/mcp`、`/_auth/` を断る。

画面は SPA で、描画の途中で API を読む。

- `/api/me` は、画面を出す前に待つ（`apps/web/src/App.tsx` の `ready`、`apps/web/src/api.ts` の `/api/me`）
- `/api/pages/` の下は、ページ本体、title からの解決、リンク元、トップの最近の一覧、添付の画像など（`apps/web/src/pages-api.ts`、`apps/web/src/useEntryList.ts`、`apps/web/src/attachments.ts`）
- `/api/tags` は、タグの一覧（`apps/web/src/TagsPanel.tsx`、トップでの呼び出しは `apps/web/src/HomeView.tsx`）

JS を実行するクローラーが `/api/` をすべて断られると、これらを読めず、画面が空のままになる。
`Allow` と `Disallow` が重なるときは、パスの長い規則が勝つので、`/api/me` などは `/api/` の断りより先に効く。

検索の画面（`/?q=`）が読む `/api/search` は許さない。
`/?q=` の HTML は索引に載せない（`apps/worker/src/spa.ts` で載せてよいとするのは、クエリの無い `/` だけ）ので、描画できなくてよい。

許しているのは取得だけで、公開範囲は変わらない。
title での解決と一覧では、匿名の読み手に public のページだけが返り、draft は無いページと区別できない（`apps/worker/src/pages/store.ts`）。
id で引けば、draft も誰にでも返る（README.md のページごとの public / draft の説明）。
API の応答には `X-Robots-Tag: noindex` が付くので（`apps/worker/src/security-headers.ts`）、JSON は検索結果に載らない。

`/mcp` と `/_auth/`（OAuth の同意画面など）は、人の画面でなくエージェントや認証の入口なので、クローラーに取らせる理由が無い。
画面が読む API を足したときは、`Allow` にも足す。

## Content-Signal

`*` のグループの `Content-Signal: search=yes, ai-input=yes, ai-train=no` は、用途ごとの許可を申告する行である。
検索の索引（`search`）と AI の回答への入力（`ai-input`）は許し、学習（`ai-train`）は許さない。

名指しのグループに挙げていない学習用のクローラーに対する、追加の申告として置いてある。
Content-Signal は RFC 9309 の規則でなく、この行を読むクローラーにだけ効く申告である。
知らないクローラーが読んでも、RFC 9309 の定めにより、ほかの規則の解釈は妨げられない。

## HTML の索引の扱い

robots.txt は取得への申告で、検索結果に載るかは HTML 側の指定が決める。
トップと public のページだけを索引に載せてよいとし、それ以外には `noindex` を付ける。

- HTML のレスポンスには、既定で `X-Robots-Tag: noindex` を付ける。未知のパスや 404 を載せないため、付ける側に倒してある（`apps/worker/src/security-headers.ts` の `withHtmlHeaders`）
- トップと public のページだけ、この `noindex` を外す（`apps/worker/src/spa.ts`）
- `/_auth/` の HTML は `withHtmlHeaders` を通らず、OAuth のルートが個別に `X-Robots-Tag: noindex` を付ける（`apps/worker/src/auth/oauth-routes.ts`）
- draft のページは、id で開けても `<meta name="robots" content="noindex">` を HTML に入れる（`apps/worker/src/page-html.ts`）

## robots.txt の Content-Type

`apps/web/public/_headers` は、`/robots.txt` の `Content-Type` を `text/plain; charset=utf-8` にする。
本番の Static Assets は `.txt` を charset なしの `text/plain` で返し、ブラウザで ASCII でない文字が化ける。
ローカルの `wrangler dev` は charset を付けて返すので、E2E では気づけない。

今の robots.txt は ASCII だけなので化けない。
パスに ASCII でない文字を書いたときなどのために、`_headers` を置く。
`apps/worker/scripts/public-assets.test.ts` が、`_headers` にこの規則があることを検査する。

robots.txt は、Worker を通さず Static Assets が直接返す（`apps/worker/wrangler.jsonc` の `run_worker_first`）。
Worker のミドルウェアが付けるヘッダーは付かないので、ヘッダーを足すときは `_headers` に書く。
robots.txt のファイル名を変えるときは、`_headers`、`run_worker_first`、`packages/domain` の `RESERVED_TITLE_SEGMENTS` も合わせて直す。

ゾーンの WAF、レート制限、Bot の設定は robots.txt の外にあり、クローラーの取得にも当たる。
そこで bot を止めたり通したりするときは、この文書の方針と食い違わないようにする。
併用するときの注意は、[deploy.md](./deploy.md) の「ゾーンの WAF、レート制限、Bot の設定」にある。
