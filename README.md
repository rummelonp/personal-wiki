# personal-wiki

Cloudflare の無料枠で動かす、一人用の Markdown wiki です。
Hono の Worker、Vite/React の SPA、D1、R2 で構成し、AI エージェントが REST API と MCP から読み書きできるようにします。

## 状態

開発中です。実装はこれから進めます。

## デプロイ

自分の Cloudflare アカウントと独自ドメインにデプロイします。
ホスト名と D1 の ID は `apps/worker/deploy.env`（gitignore 済み）に書き、追跡される `wrangler.jsonc` には書きません。
`pnpm deploy:remote` と `pnpm db:migrate:remote` は、`wrangler.jsonc` に `deploy.env` の値を重ねた設定を `apps/worker/wrangler.deploy.json` に作って wrangler に渡します。

手順は `node apps/worker/scripts/deploy.mjs --help` に載せています。
概要は次のとおりです。

1. `wrangler login`
2. `wrangler d1 create` と `wrangler r2 bucket create` で D1 と R2 を作る
3. `apps/worker/deploy.env.example` を `deploy.env` にコピーし、ホスト名と `database_id` を書く
4. `pnpm --filter @personal-wiki/worker db:migrate:remote`
5. `pnpm --filter @personal-wiki/worker deploy:remote`
6. `pnpm -s api-token issue <name> --scopes read,write --remote`（`apps/worker` で実行）でトークンを発行する
7. `claude mcp add` で MCP に接続する

ホスト名は `custom_domain` で割り当てるので、そのゾーンの DNS が、デプロイ先と同じ Cloudflare アカウントにある必要があります。

## ライセンス

[MIT](./LICENSE)
