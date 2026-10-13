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
}

export interface AppEnv {
  Bindings: Bindings;
  Variables: {
    principal: Principal;
  };
}
