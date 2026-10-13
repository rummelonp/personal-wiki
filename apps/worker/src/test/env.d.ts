import type { D1Migration } from "cloudflare:test";
import type { Bindings } from "../env";

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {
      /** vitest.config.ts が migrations/ を読んで渡す。 */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
