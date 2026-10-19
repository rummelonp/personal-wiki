# クローラーと AI の取得

`apps/web/public/robots.txt` の各行の理由と、変えるときに合わせて直す場所を書く。
robots.txt は誰でも開いて読める公開のファイルなので、理由はファイルに書かず、ここに書く。
ファイルにはコメントを置かない。
本番の robots.txt の末尾の `Sitemap:` の行は repo のファイルに無く、デプロイのときに足す（「sitemap.xml」の節）。

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

## JS を実行しない読み手への一覧

JS を実行しない読み手が public のページへたどれるよう、トップの HTML、public のページの HTML、`/llms.txt` に一覧を置く。
どちらも public で削除されていないページを、更新日時の新しい順に多くて 100 件並べる（`apps/worker/src/pages/search.ts` の `listPublicPages`、件数は `apps/worker/src/page-html.ts` の `ROOT_PAGE_LIST_LIMIT`）。
ページ送りは無い。
owner や API token で取っても、draft は入らない。
100 件より古いページへは、トップの HTML と `/llms.txt` の末尾から指す `/sitemap.xml` でたどらせる（「sitemap.xml」の節）。

クエリの無い `/` の HTML は、`#root` にサイト名と各ページへのリンクを差し込んで返す（`apps/worker/src/spa.ts` の `rootHtml`、`page-html.ts` の `rewriteRootHtml`）。
一覧の後ろには `/sitemap.xml` へのリンクを置く。
ブラウザでは SPA の描画が置き換えるので、人には見えない。
`/?tag=` や `/?q=` のようにクエリの付いた `/` は絞り込みの画面なので、一覧を差し込まない。
一覧の取得が失敗したら、一覧を差し込まない HTML を 503 で返す（`spa.ts` の `unavailable`）。
一覧の無い 200 だと、public のページが 1 つも無いと読まれ、検索エンジンもその版を覚える。

public のページの HTML は、本文の下に、本文がリンクするページのうち public で削除されていないもの（自分自身を除き、多くて 100 件）を、正規の URL（絶対 URL）の `<a>` の一覧にして入れる（`apps/worker/src/page-html.ts` の `rewritePageHtml`、引く条件は `apps/worker/src/pages/link-targets.ts`）。
`<pre>` の中の `[[...]]` はリンクにならないので、JS を実行しない取得でもリンク先をたどれるようにするためである。
draft のページとまだ無いページへのリンクは出さず、draft のページの HTML には一覧そのものを入れない。

`/llms.txt` は、llmstxt.org の書式で wiki の概要と各ページへの入口を AI のエージェントに渡す（`apps/worker/src/llms-txt.ts`）。
H1 にサイト名、`SITE_DESCRIPTION` を書いたときは blockquote に説明文、`## Pages` の下に `- [title](URL)` を並べ、抜粋は入れない。
続く `## Optional` に `/sitemap.xml` へのリンクを置く。
llmstxt.org で `Optional` は、短い文脈で足りるなら読み飛ばしてよい節の名前で、100 件より古いページまで要るエージェントだけがたどればよい。
public のページが無いときは、`/sitemap.xml` も空なので、`## Pages` と `## Optional` の節を出さない。
トップの HTML も、public のページが無ければ `/sitemap.xml` へのリンクを置かない。
title の中の `[`、`]`、`\`、文字参照に見える `&` などはリンクが崩れたり化けたりしないよう escape し、URL の `(` と `)` は percent-encoding にする（`packages/markdown/src/markdown-link.ts`）。
本文は Markdown だが、ブラウザでその場で読めるよう `text/plain; charset=utf-8` で返す。
クエリは見ない。
一覧の取得が失敗したら、空の一覧の 200 でなく 503 を返す。
一覧は取得のたびに D1 から引き、匿名の応答にも `no-store` を付けて写しを使い回させないので、draft に戻したページは次の取得で一覧から消える。
`X-Robots-Tag: noindex` を付ける（`llms-txt.ts`）。
中身はトップの一覧と同じなので、検索の結果からは各ページの HTML に入らせる。

robots.txt は `/llms.txt` を `*` のグループで断っていない。
名指しの学習用の bot には `Disallow: /` で `/llms.txt` も断っている。
`/llms.txt` を読むのは利用者の依頼で動く AI のエージェントで、`ChatGPT-User` などを名乗って `*` のグループに当たるので、学習用の bot に開ける理由が無い。
ページの title の `llms.txt` は Worker のパスと重なる予約語で、その title のページへのリンクは `/p/<id>` になる（`packages/domain/src/page-path.ts` の `WORKER_PATH_SEGMENTS`）。
パスを変えるときは、`llms-txt.ts` の `LLMS_TXT_PATH` と `WORKER_PATH_SEGMENTS` を合わせて直す。

## sitemap.xml

`/sitemap.xml` は、sitemaps.org の書式で、public で削除されていないページの正規の URL（絶対 URL）と更新日時を検索エンジンに渡す（`apps/worker/src/sitemap-xml.ts`）。
`<url>` には `<loc>` と `<lastmod>` だけを入れ、`<changefreq>` と `<priority>` は入れない。
`<lastmod>` は pages の `updated_at` を W3C Datetime（UTC の秒まで）にした値である。
`updated_at` は本文の保存のほか、公開範囲の切り替えやリンクの書き換えでも進むので、本文が変わっていなくても新しくなることがある。
URL は `/llms.txt` と同じ関数で作り、予約語と重なる title は `/p/<id>`、`/` を含む title は `%2F` の URL になる（`apps/worker/src/pages/urls.ts` の `publicPageUrl`）。
URL は title を percent-encoding した後、残る `'` などの XML の特殊文字を文字参照にする。
sitemaps.org は `<loc>` を 2,048 文字未満と定めるが、長い title の URL は percent-encoding でそれを超えうる（日本語ではおよそ 220 文字を超える title）。
超えた URL は検索エンジンが読み飛ばしうるが、ほかのページの読み取りは妨げないので、除かずに出す。

draft、削除済みのページは、owner や API token で取っても入らない。
public のページが無いときは、`<url>` の無い `<urlset>` を 200 で返す。
sitemaps.org の XSD は `<url>` を 1 つ以上求めるが、404 や 503 にすると、ルートが無いことや D1 の失敗と区別できない。

件数は、sitemaps.org の 1 ファイルの上限の 50,000 件までにする（`sitemap-xml.ts` の `SITEMAP_URL_LIMIT`）。
sitemap index は作らず、上限を超えた分は更新日時の古いページから出さない。
一覧は取得のたびに D1 から 1 回で引き、間に挟まる draft の行も含めて全ページの行を読む。
sitemaps.org の非圧縮 50MB の上限や 50,000 件より先に、XML を組み立てる CPU 時間（Free の 10ms）が効き、見積もりでは数千件で超えうる。
超えると一部でなく sitemap 全体がエラーで返らない。
取得ごとに読む行数は D1 の日次の読み取りの上限にも数える。

キャッシュ、クエリ、HEAD、D1 の失敗の扱いは `/llms.txt` と同じである。
匿名の応答にも `no-store` を付け、draft に戻したページは次の取得で消える。
クエリは見ない。
一覧の取得が失敗したら、空の `<urlset>` の 200 でなく 503 を返す。
空の 200 だと、検索エンジンは public のページが 1 つも無い sitemap を受け取る。
`Content-Type` は `application/xml; charset=utf-8` にし、`X-Robots-Tag: noindex` を付ける。
sitemap は巡回の入口で、検索の結果に載せるものではない。

robots.txt は `/sitemap.xml` を `*` のグループで断っていない。
名指しの学習用の bot には `Disallow: /` で `/sitemap.xml` も断っている。
ページの title の `sitemap.xml` は Worker のパスと重なる予約語で、その title のページへのリンクは `/p/<id>` になる（`packages/domain/src/page-path.ts` の `WORKER_PATH_SEGMENTS`）。
パスを変えるときは、`sitemap-xml.ts` の `SITEMAP_XML_PATH`、`WORKER_PATH_SEGMENTS`、`apps/worker/scripts/deploy.mjs` の `SITEMAP_PATH` を合わせて直す。

### robots.txt の Sitemap の行

本番の robots.txt の末尾には、`Sitemap: https://<WIKI_HOSTNAME>/sitemap.xml` の行が入る。
`Sitemap:` の URL はスキームとホストを含む絶対 URL でなければならず、repo の `apps/web/public/robots.txt` にはホスト名を書けない。
そのため `pnpm deploy:remote` が web をビルドした後に、`apps/web/dist/robots.txt` の末尾へ足す（`apps/worker/scripts/deploy.mjs` の `robotsTxtWithSitemap`）。
ホスト名は、Worker のデプロイ先と同じ値にするため、合成した設定の routes から読む。
`pnpm dev` と E2E のビルドの robots.txt には、この行が入らない。
`pnpm deploy:remote` の後は、次にビルドし直すまで、手元の dist の robots.txt にも本番の行が残る。

`Sitemap:` の行は、RFC 9309 ではグループを終わらせず、どの `User-agent` にも属さない（Google の説明も同じ）。
直前のグループの規則と読み違えられないよう、最後のグループとの間に空行を挟む。

## robots.txt の Content-Type

`apps/web/public/_headers` は、`/robots.txt` の `Content-Type` を `text/plain; charset=utf-8` にする。
本番の Static Assets は `.txt` を charset なしの `text/plain` で返し、ブラウザで ASCII でない文字が化ける。
ローカルの `wrangler dev` は charset を付けて返すので、E2E では気づけない。

今の robots.txt は ASCII だけなので化けない。
パスに ASCII でない文字を書いたときなどのために、`_headers` を置く。
`apps/worker/scripts/public-assets.test.ts` が、`_headers` にこの規則があることを検査する。

robots.txt は、Worker を通さず Static Assets が直接返す（`apps/worker/wrangler.jsonc` の `run_worker_first`）。
Worker のミドルウェアが付けるヘッダーは付かないので、ヘッダーを足すときは `_headers` に書く。
robots.txt のファイル名を変えるときは、`_headers`、`run_worker_first`、`packages/domain` の `RESERVED_TITLE_SEGMENTS`、`apps/worker/scripts/deploy.mjs` の `addSitemapToRobotsTxt` も合わせて直す。
`addSitemapToRobotsTxt` は web の dist のパスを直に持つので、`wrangler.jsonc` の `assets.directory` を変えるときも合わせて直す。

ゾーンの WAF、レート制限、Bot の設定は robots.txt の外にあり、クローラーの取得にも当たる。
そこで bot を止めたり通したりするときは、この文書の方針と食い違わないようにする。
併用するときの注意は、[deploy.md](./deploy.md) の「ゾーンの WAF、レート制限、Bot の設定」にある。
