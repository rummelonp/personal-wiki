import type { Principal } from "./auth/principal";

/** wrangler.jsonc の binding と、デプロイ時に入る vars と secret に対応させる。 */
export interface Bindings {
  DB: D1Database;
  BUCKET: R2Bucket;
  /** apps/web のビルド出力 */
  ASSETS: Fetcher;
  /**
   * owner のログインの設定。deploy.env から vars に入る（SESSION_SECRET だけは wrangler secret）。
   * 1 つでも欠けると owner の経路は閉じる（auth/owner-config.ts）。
   */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** カンマ区切り */
  OWNER_EMAILS?: string;
  SESSION_SECRET?: string;
  /**
   * OAuth の client、grant、トークンの置き場（@cloudflare/workers-oauth-provider がこの名前で読む）。
   * deploy.env に ID が無ければ binding ごと外れ、OAuth は閉じる。owner のログインの設定が欠けていても
   * 閉じる（auth/oauth-server.ts）。
   */
  OAUTH_KV?: KVNamespace;
  /**
   * client の登録で許す redirect URI に足す値（カンマ区切り、完全一致）。claude.ai の戻り先は
   * 既定で許す（auth/oauth-registration.ts）。deploy.env から vars に入る。
   */
  OAUTH_REDIRECT_URIS?: string;
}

export interface AppEnv {
  Bindings: Bindings;
  Variables: {
    principal: Principal;
  };
}
