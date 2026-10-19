import { DEFAULT_SITE_NAME, isValidSiteDescription, isValidSiteName } from "@personal-wiki/domain";
import type { Bindings } from "./env";

/**
 * MCP の server の表示名、OAuth の resource_name、OAuth の画面のブランドに出すサイト名。
 * deploy.env の SITE_NAME が無いか、deploy の検査と同じ規則（packages/domain の isValidSiteName）を
 * 満たさなければ既定の名前。deploy を通らずに vars を書き換えた値が、画面やレスポンスを崩さないようにする。
 */
export function siteNameOf(env: Pick<Bindings, "SITE_NAME">): string {
  const name = env.SITE_NAME?.trim();
  return name !== undefined && isValidSiteName(name) ? name : DEFAULT_SITE_NAME;
}

/**
 * llms.txt の blockquote に出すサイトの説明文。deploy.env の SITE_DESCRIPTION が無いか、deploy の検査と
 * 同じ規則（isValidSiteDescription）を満たさなければ null で、blockquote を出さない。
 */
export function siteDescriptionOf(env: Pick<Bindings, "SITE_DESCRIPTION">): string | null {
  const description = env.SITE_DESCRIPTION?.trim();
  return description !== undefined && isValidSiteDescription(description) ? description : null;
}
