# personal-wiki

Cloudflare の無料枠で動かす、一人用の Markdown wiki です。
Hono の Worker、Vite/React の SPA、D1、R2 で構成し、AI エージェントが REST API と MCP から読み書きできるようにします。

## 状態

開発中です。実装はこれから進めます。

## デプロイ

自分の Cloudflare アカウントと独自ドメインにデプロイします。
ホスト名と D1 の ID は `apps/worker/deploy.env`（gitignore 済み）に書き、追跡される `wrangler.jsonc` には書きません。
`pnpm deploy:remote` と `pnpm db:migrate:remote` は、`wrangler.jsonc` に `deploy.env` の値を重ねた設定を `apps/worker/wrangler.deploy.json` に作って wrangler に渡します。

手順の詳細は `node apps/worker/scripts/deploy.mjs --help` に載せています。
概要は次のとおりです（`apps/worker` で実行します）。

1. `pnpm exec wrangler login`
2. `pnpm exec wrangler d1 create personal-wiki --update-config=false`
   - `--update-config=false` を付けないと、wrangler が追跡対象の `wrangler.jsonc` に binding を書き込みます。
   - R2 は添付とバックアップで使います。ダッシュボードで R2 を有効にしてから `pnpm exec wrangler r2 bucket create personal-wiki --update-config=false` を実行します。
3. `cp deploy.env.example deploy.env` を実行し、ホスト名と `database_id` を書く
   - `R2_BUCKET_NAME` は R2 を作ったときだけ書きます。空のままなら、R2 の binding を付けずにデプロイします。
4. `pnpm db:migrate:remote`
5. `pnpm deploy:remote`
6. `pnpm -s api-token issue <name> --scopes read,write --remote`
7. `claude mcp add` で MCP に接続する（MCP エンドポイントの実装後）

ホスト名は `custom_domain` で割り当てるので、そのゾーンの DNS が、デプロイ先と同じ Cloudflare アカウントにある必要があります。

## ライセンス

[MIT](./LICENSE)
