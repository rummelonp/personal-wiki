# AGENTS.md

## 概要

Cloudflare の無料枠で動く一人用 Markdown wiki。
1 つの Hono の Worker が API を提供し、Static Assets として Vite/React の SPA を配信する。
データは D1 と R2 に置き、AI エージェントが REST と MCP から読み書きする。

pnpm workspace の構成で、アプリは `apps/*`、共有パッケージは `packages/*` に置く。
現在は土台のみで、`apps/*` と `packages/*` はまだ空。

## コマンド

Node は 22 系、パッケージマネージャーは pnpm（バージョンは `package.json` の `packageManager`）。

```sh
pnpm install
pnpm lint          # biome check
pnpm format        # biome check --write
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest run
```

PR を出す前に `lint`、`typecheck`、`test` がすべて通ることを確認する。
CI（`.github/workflows/ci.yml`）も同じ 3 つを実行する。
コミット時は lefthook が biome を実行する。

## 規約

- ドキュメントとコメントは日本語で書く。コメントはコードから自明でないこと（判断の理由、制約）だけを書く。
- 秘密情報（`.dev.vars`、`.env*`）はコミットしない。
