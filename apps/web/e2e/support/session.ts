import { createHmac } from "node:crypto";
import type { BrowserContext } from "@playwright/test";

/*
 * ローカル専用: owner のセッション cookie を SESSION_SECRET から直接作る。本番のログインは
 * Access を通した /_auth/login だけが cookie を出すが、E2E は Access を持たないので、Worker と同じ
 * 形式で署名する。形式は apps/worker/src/auth/session.ts に合わせる（変えたら auth.spec.ts が落ちる）。
 */

export const SESSION_COOKIE_NAME = "__Host-wiki_session";
const SIGNING_CONTEXT = "personal-wiki/session/v1.";
const SESSION_TTL_SECONDS = 24 * 60 * 60;

/** expiresAt は UNIX エポックの秒。省くと Worker の発行と同じ 24 時間後。 */
export function mintSessionValue(
  secret: string,
  email: string,
  expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
): string {
  const payloadPart = Buffer.from(JSON.stringify({ e: email, exp: expiresAt })).toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret)
    .update(SIGNING_CONTEXT + payloadPart)
    .digest("base64url");
  return `${payloadPart}.${signature}`;
}

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
