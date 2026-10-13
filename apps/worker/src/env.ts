import type { Principal } from "./auth/principal";

/** wrangler.jsonc の binding と対応させる。 */
export interface Bindings {
  DB: D1Database;
  BUCKET: R2Bucket;
}

export interface AppEnv {
  Bindings: Bindings;
  Variables: {
    principal: Principal;
  };
}
