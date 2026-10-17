import { DEFAULT_SITE_NAME, isValidSiteName } from "@personal-wiki/domain";
import type { Bindings } from "./env";

/**
 * MCP の server の表示名、OAuth の resource_name、OAuth の画面のブランドに出すサイト名。
 * deploy.env の SITE_NAME が無いか、deploy の検査と同じ規則（packages/domain の isValidSiteName）を
 * 満たさなければ既定の名前。deploy を通らずに vars を書き換えた値が、画面や応答を崩さないようにする。
 */
export function siteNameOf(env: Pick<Bindings, "SITE_NAME">): string {
  const name = env.SITE_NAME?.trim();
  return name !== undefined && isValidSiteName(name) ? name : DEFAULT_SITE_NAME;
}
