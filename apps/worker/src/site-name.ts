import { DEFAULT_SITE_NAME } from "@personal-wiki/domain";
import type { Bindings } from "./env";

/** MCP の server 名と OAuth の resource_name に出すサイト名。deploy.env の SITE_NAME が無ければ既定の名前。 */
export function siteNameOf(env: Pick<Bindings, "SITE_NAME">): string {
  const name = env.SITE_NAME?.trim();
  return name === undefined || name === "" ? DEFAULT_SITE_NAME : name;
}
