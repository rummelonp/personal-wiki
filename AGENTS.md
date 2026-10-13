# AGENTS.md

## 概要

Cloudflare の無料枠で動く一人用 Markdown wiki。
1 つの Hono の Worker が API を提供し、Static Assets として Vite/React の SPA を配信する。
データは D1 と R2 に置き、AI エージェントが REST と MCP から読み書きする。

pnpm workspace の構成で、アプリは `apps/*`、共有パッケージは `packages/*` に置く。

- `apps/worker`: Hono の Worker（REST の `/api/*` と MCP の `/mcp`）、D1 の migration、デプロイとトークン発行のスクリプト
- `packages/domain`: title の正規化と Result 型など、実行環境に依存しない規則
- `packages/markdown`: Markdown の解析（wikilink、タグ、frontmatter の抽出、差分など）

## コマンド

Node は 22 系、パッケージマネージャーは pnpm（バージョンは `package.json` の `packageManager`）。

```sh
pnpm install
pnpm lint          # biome check
pnpm format        # biome check --write
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest run
```

Worker の開発とデプロイは `apps/worker` で実行する。

```sh
pnpm db:migrate         # ローカルの D1 に migration を適用
pnpm dev                # wrangler dev
pnpm deploy:remote      # deploy.env から設定を合成してデプロイ
pnpm db:migrate:remote  # 本番の D1 に migration を適用
pnpm api-token issue <name> --scopes read|read,write [--remote]
pnpm api-token revoke <name> [--remote]
```

本番の hostname と D1 の ID は `apps/worker/deploy.env`（コミットしない。`deploy.env.example` を写して作る）に置く。
トークンの平文は発行時に標準出力へ 1 度だけ出る。失効したトークンの名前は再利用できない。

PR を出す前に `lint`、`typecheck`、`test` がすべて通ることを確認する。
CI（`.github/workflows/ci.yml`）も同じ 3 つを実行する。
コミット時は lefthook が biome を実行する。

## 規約

- ドキュメントとコメントは日本語で書く。コメントはコードから自明でないこと（判断の理由、制約）だけを書く。
- 秘密情報（`.dev.vars`、`.env*`、`apps/worker/deploy.env`）はコミットしない。
