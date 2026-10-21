# AGENTS.md

## 概要

Cloudflare の無料枠で動く一人用 Markdown wiki。
1 つの Hono の Worker が API を提供し、Static Assets として Vite/React の SPA を配信する。
データは D1 と R2 に置き、AI エージェントが REST と MCP から読み書きする。
利用者向けの説明は [README.md](./README.md) にある。

pnpm workspace の構成で、アプリは `apps/*`、共有パッケージは `packages/*` に置く。

- `apps/worker`: Hono の Worker（REST の `/api/*` と MCP の `/mcp`）、D1 の migration、デプロイ、token の発行、派生データの作り直し、リンクの書き換え、バックアップのスクリプト
- `apps/web`: Vite/React の SPA（E2E は `apps/web/e2e`）
- `packages/domain`: title の正規化と Result 型など、実行環境に依存しない規則
- `packages/markdown`: Markdown の解析（wikilink、タグ、frontmatter の抽出、差分など）
- `packages/editor`: CodeMirror 6 の Live Preview エディタ（React に依存しない）

## ドキュメント

運用の手順は `docs/` にある。
該当する作業のときに読む。

- [docs/deploy.md](./docs/deploy.md): 初回のデプロイ、任意の機能（owner のログイン、R2、OAuth、Cron）の設定、ゾーンの WAF やレート制限と併用するときの注意、Web Analytics、本番の更新、前の版に戻すときの注意
- [docs/operations.md](./docs/operations.md): API token、派生データの作り直し、リンクの書き換え、バックアップと復元
- [docs/attachments.md](./docs/attachments.md): 添付（R2）の API と公開範囲
- [docs/design.md](./docs/design.md): 画面の見た目と使い心地の原則、対象の環境と幅、守る条件、確かめ方
- [docs/wording.md](./docs/wording.md): 画面の文言の書き方（句点、進行中、日時、数と単位、aria の名前など）と用語集。画面の文言を足すか変えるときに読む
- [docs/crawlers.md](./docs/crawlers.md): `robots.txt` の各行の理由（学習用の bot を断る、チャットの取得と検索を止めない、描画で読む API を許す、Content-Signal、charset）、JS を実行しない読み手への一覧（トップ、ページのリンク先、llms.txt、sitemap.xml）、デプロイで足す robots.txt の `Sitemap:` の行と、変えるときに合わせて直す場所

## コマンド

Node は 24 系、パッケージマネージャーは pnpm（バージョンは `package.json` の `packageManager`）。

```sh
pnpm install
pnpm lint          # biome check、CSS の直書きの検査、複雑度の検査
pnpm format        # biome check --write
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest run
pnpm complexity:update  # 複雑度の baseline を今の値で書き直す
```

`packages/editor` と `apps/web` のコンポーネントのテストは Playwright の Chromium の中で動く。
初回は `pnpm --filter @personal-wiki/editor exec playwright install chromium` でブラウザを入れる。

### 複雑度の検査

`pnpm lint` は [cccc](https://github.com/moznion/cccc) で関数ごとの認知的複雑度を測り、上限の 15 を超える関数が増えていないかを検査する（`scripts/check-complexity.mjs`）。
対象は `apps`、`packages`、`scripts` などで、テストと E2E も含む。
cccc は npm の package が無いので、手元では `cargo install cccc-cli --version <版> --locked` で入れる。
版は `scripts/complexity-baseline.json` の `cccc` に合わせる（違う版だと検査が失敗する）。
CI は同じ版の Release のバイナリを、build provenance を確かめてから使う。

上限を超えている既存の関数は baseline に載っていて、新しく超えた関数と、baseline より値が上がった関数で失敗する。
ただし同じファイルの同じ入れ子に同じ名前の関数（無名関数など）が複数あると、1 つの値の上昇が別の値の低下に隠れて「下がった」と出ることがあるので、`pnpm complexity:update` の後は baseline の差分を見る。
関数を分けて値を下げたときも、baseline が古いとして失敗するので、`pnpm complexity:update` で書き直してコミットに含める。
cccc の版を上げるときは、baseline の `cccc` を書き換えてから `pnpm complexity:update` を流し、値の変化を差分で確かめる。

baseline の関数は上限を超えたまま受け入れているので、元から超えている関数を上限まで下げるのは、その変更の範囲に含めない。
変更で baseline の関数の値が上がったときと、関数が新しく上限を超えたときは、その変更の中で、変更を始めたときの baseline の値（新しく超えたなら上限）まで下げる。
増えた分岐を関数に切り出すなどで下げる。
比べる相手は変更を始めたときの baseline で、`git diff <始めたときのコミット> -- scripts/complexity-baseline.json` で、同じ名前の無名関数の組も含めて確かめる。
下げると読みにくくなる（アルゴリズムの本体など）か、その変更が触れていない箇所まで直すことになるときだけ、`pnpm complexity:update` で受け入れ、関数の key、値、受け入れた理由をコミットメッセージに書く（コミットしないときは作業の報告に書く）。

分ける作業を別に計画するのは、変更が多く、不具合を直したコミットも入っている関数に限る（`git log -L :<関数名>:<ファイル>` か、名前で引けない無名関数ならファイルの `git log` で確かめる。画面の部品や状態の処理に多い）。
解析器、アルゴリズムの本体、引数の解析、テストの補助などは、変更が多くても分ける計画を立てない。
当たるか迷うときは計画せず、作業の報告に書く。

### E2E

E2E は `pnpm test` に含めず、別に実行する。
web を build し、一時の D1 で `wrangler dev` を起動して、owner の cookie を作って入る。
`apps/worker/.dev.vars` は読まない。
初回は `pnpm --filter @personal-wiki/web exec playwright install chromium webkit firefox` でブラウザを入れる。

E2E の build は `apps/web/dist` を上書きするので、8787 で動かしている開発の `wrangler dev` の画面もその版に変わる。
web のソースを前の build から変えていなければ、`E2E_SKIP_BUILD=1 pnpm e2e` で build を省ける。
E2E のポートは既定で 8790（inspector は 9339）。
別の worktree の E2E と同時に流すときは `E2E_PORT=8800 pnpm e2e` のように変える。
`pnpm e2e:full` と `pnpm e2e:sheet` も同じサーバーを起動するので、`apps/web/dist` の上書き、`E2E_SKIP_BUILD`、`E2E_PORT` は `pnpm e2e` と同じに働く。

`pnpm e2e` は主の環境（デスクトップの Chromium と iPhone の WebKit）だけを走らせる。
従の環境（Firefox、Android の Chromium、デスクトップの WebKit）の smoke と速さの計測（`apps/web/e2e/perf-budget.json` の予算）は `pnpm e2e:full` だけが走らせる。
CI は E2E を流さないので、master に取り込む前と push の前に `pnpm e2e:full` を流す。

速さの予算は、測った機械での値である。
機械（CPU、OS など）を変えて予算を外れるようになったら、`pnpm e2e:full` を 2 回流し、`apps/web/e2e-output/perf-<project>.json` の `results` の `median` を指標ごとに見て、大きい方を `measured` に書く。
`budget` は `measured` の 2 倍を 10ms 単位で切り上げた値にする。
打鍵から表示まではフレームの刻みで揺れるので、50ms を下限にする。
値の決め方は `apps/web/e2e/perf.spec.ts` の冒頭にもある。
測り直さずに `budget` だけを上げない。

```sh
pnpm e2e                    # apps/web/e2e のテスト（主の環境）。結果は apps/web/e2e-output/（gitignore 済み）
pnpm e2e:full               # 全部の環境と速さの計測
pnpm e2e e2e/notices.spec.ts  # ファイルを絞る。--last-failed、--only-changed も渡せる
pnpm e2e:sheet [--out <dir>]  # 画面の一覧（明暗 × 幅 375、768、1280）を 1 枚の HTML にする
```

### Worker

Worker の開発とデプロイは `apps/worker` で実行する。
`--remote` は本番（`deploy.env` のデプロイ先）、付けないとローカルが対象になる。

```sh
pnpm db:migrate         # ローカルの D1 に migration を適用
pnpm dev                # apps/web を build してから wrangler dev
pnpm dev:owner [--port <n>]  # owner でログインした状態で開く（http://localhost:8780。wrangler dev は 8781）
pnpm deploy:remote      # deploy.env から設定を合成してデプロイ
pnpm db:migrate:remote  # 本番の D1 に migration を適用
pnpm api-token issue <name> --scopes read|read,write [--remote]
pnpm api-token revoke <name> | --id <id> [--remote]
pnpm api-token list [--remote]
pnpm derived:rebuild [--remote]  # 全ページの派生データを作り直す
pnpm link-rewrites [--remote] [--target <page id>]  # title の変更で待っているリンクの書き換えを最後まで進める
pnpm backup [--remote] [--out <dir>] [--with-tokens]  # D1 の本文を SQL のダンプにして手元に残す
pnpm backup load <dir> [--remote]  # ダンプを新しい D1 に流し込む
```

`dev:owner` は、乱数の `SESSION_SECRET` と Access の仮の値を一時ディレクトリに書いて wrangler dev を起動し、前段の loopback の proxy がリクエストごとに owner の cookie を足す。
`.dev.vars` は読まず、D1 は `pnpm dev` と同じローカルのものを使う。
migration は適用しないので、先に `pnpm db:migrate` を実行する。
ログアウトしても、再読み込みで owner に戻る。
匿名の画面は、proxy を通らない `<port> + 1`（既定は 8781）で見る。
Host が loopback でないリクエストと `--remote` は拒む。
inspector は `<port> + 549`（既定は 9329）を使う。
別の worktree と同時に動かすときは `--port` を変える（wrangler dev と inspector も一緒にずれる）。
cookie の値は `scripts/session-cookie.mjs` が作り、E2E も同じものを使う。

`derived:rebuild` と `link-rewrites` は、環境変数 `WIKI_TOKEN` から write の token を読む。
平文をコマンド行に書くとシェルの履歴に残るので、`read -rs WIKI_TOKEN && export WIKI_TOKEN` で入れる。

本番の hostname と D1 の ID は `apps/worker/deploy.env`（コミットしない。`deploy.env.example` を写して作る）に置く。

本番を更新するときは、次の順に実行する。
デプロイが migration より先だと、新しい版が使うテーブルがまだ無く、保存と一覧がエラーで止まる。
Worker を前の版に戻したときも `derived:rebuild` が要る。
ほかの手順と詳細は [docs/deploy.md](./docs/deploy.md) と [docs/operations.md](./docs/operations.md) にある。

```sh
pnpm db:migrate:remote
pnpm deploy:remote
read -rs WIKI_TOKEN && export WIKI_TOKEN  # write の token を入れる
pnpm derived:rebuild --remote
```

token の平文は発行時に標準出力へ 1 度だけ出る（id は標準エラー出力に出る）。
token を識別するのは id で、name は重複してよい。
バックアップの `data.sql` は draft の本文を含むので、`--out` を追跡される場所に向けない。

## 規約

- README、docs/、AGENTS.md、コメントは常体（である調）で書く。
- ドキュメントとコメントは日本語で書く。
  コメントはコードから自明でないこと（今も有効な判断の理由、制約）だけを書く。
  変更の経緯は、コメント、README、AGENTS.md、docs/ のどれにも書かない。
  既存の文に「以前は」「〜に変えた」があれば、今の値と今の制約で書き直す。
  「この guard が無いと X が起きる」は制約として書き、「以前 X が起きたので直した」はコミットメッセージに書く。
- 並列は中黒（・）でなく読点（、）でつなぎ、範囲は「〜」で書く。
  列挙で網羅を装わず、全部を挙げないときは「など」を付ける。
- 術語は分野で慣用されている語を使い、訳し直さない（table は「テーブル」、index は「インデックス」）。
  和語で自然に通じる語（行、入れ子など）は片仮名にしない。
- 文書は読み手で置き場所を分ける。
  利用者向けの説明は README.md、開発の規約とコマンドは AGENTS.md に置く。
  運用の手順や設計の規範のように長いものは `docs/` に置き、README.md と AGENTS.md からリンクする。
- 秘密情報（`.dev.vars`、`.env*`、`apps/worker/deploy.env`）はコミットしない。
- 見た目の値（色、長さ、font-family、影、z-index）は `apps/web/src/theme.css` の token に置き、コンポーネントの CSS は token だけを参照する。
  直書きが要る宣言は、同じ行の末尾に `/* token-ok: 理由 */` を書く。
  `pnpm lint` が検査する。
- 不具合を直したら回帰のテスト（単体、コンポーネント、E2E のどれか）を足し、修正を外すと落ちることを確かめる。
  テストで再現できない不具合（実機の IME など）は、確かめた手順をコミットメッセージに書く。
- `packages/editor` の外で editor の view を扱うときは、`packages/editor/src/ime.ts` 冒頭の IME の不変条件を守るため、次のようにする。
  本文や readOnly が変わっても view を作り直さず、本文の差し替えは `replaceDoc`、readOnly の切り替えは `setReadOnly` を使う。
  `packages/editor` が公開する関数（`replaceDoc`、`setReadOnly`、`invalidateDecorations` など）は自分で変換が落ち着くのを待つので、そのまま呼ぶ。
  アプリのコードで自分で書く `view.dispatch` は、`dispatchWhenSettled` の中で行う（テストで利用者の操作を模す dispatch は除く）。

PR を出す前に `lint`、`typecheck`、`test` がすべて通ることを確認する。
CI（`.github/workflows/ci.yml`）も同じ 3 つを実行する。
コミット時は lefthook が、ステージしたファイルに biome を実行する。

## 並列レーン

複数の項目をレーン（サブエージェントか別のセッション）に分けて並列に進めるときの、この repo の値。

- 検証: `pnpm lint`、`pnpm typecheck`、`pnpm test`。
  UI とエディタに触るレーンは、レーンごとに別の `E2E_PORT` を付けて `pnpm e2e` も流す。
  受け入れでテストの数を比べるときは、先頭の `+` と `-` を外した行のうち `^\s*(it|test)(\.each)?\(` に当たるものを数える（Vitest の `it` と、Playwright とエディタの `test` が混ざる。行頭に限るのは、正規表現の `.test(` を数えないため）。
- 終える前にまとめて回す検証: `pnpm e2e:full`。
  レーンを取り込むたびには回さず、最後に取り込んだ後の master で 1 回回す。
- 取り込み方: ローカルの fast-forward。
  取り込む各コミットで `pnpm typecheck` が通ることも確かめる。
- 同時に動かすレーン: 3〜4 本まで（E2E を流すレーンが重なると手元のマシンが重くなる）。
- 排他の資源: `--repeat-each` などで繰り返す E2E は、ほかのレーンの検証と重ねない（負荷で、関係のないテストが時間切れで落ちる）。
- 開発サーバー: 開発の `wrangler dev` は 8787、`dev:owner` は既定で 8780 と 8781、E2E は既定で 8790 を使う。
  8790 は統括の E2E に空けておき、レーンには 8800 から 10 ずつ `E2E_PORT` を渡す。
  8780 は統括の `dev:owner` に空けておき、レーンには 8700 から 10 ずつ `--port` を渡す（4 本までなら、開発、E2E、統括の `dev:owner` のポートと重ならない）。
  E2E は `.dev.vars` を読まないので、レーンの worktree に写さない。
- 不変条件: エディタは `packages/editor/src/ime.ts` 冒頭の IME の不変条件を守る。
  高リスクの領域は、認証と権限、draft と public の公開範囲、D1 の migration。
