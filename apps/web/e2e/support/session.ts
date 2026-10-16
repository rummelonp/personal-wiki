import type { BrowserContext } from "@playwright/test";
import { SESSION_COOKIE_NAME } from "../../../worker/scripts/session-cookie.mjs";

export { mintSessionValue, SESSION_COOKIE_NAME } from "../../../worker/scripts/session-cookie.mjs";

/**
 * http://localhost に Secure の `__Host-` cookie を置く。受け付ける指定がブラウザで違う。
 * Chromium は url を渡すと Invalid cookie fields で拒み、WebKit は domain と path を渡すと
 * 置いたように見えて送らない（Firefox はどちらも受け付ける）。どちらも auth.spec.ts で
 * Worker が owner と認めることまで確かめている。
 */
export async function addSessionCookie(
  context: BrowserContext,
  browserName: string,
  origin: string,
  value: string,
): Promise<void> {
  const cookie = {
    name: SESSION_COOKIE_NAME,
    value,
    secure: true,
    httpOnly: true,
    sameSite: "Lax" as const,
  };
  await context.addCookies([
    browserName === "chromium"
      ? { ...cookie, domain: new URL(origin).hostname, path: "/" }
      : { ...cookie, url: origin },
  ]);
}
