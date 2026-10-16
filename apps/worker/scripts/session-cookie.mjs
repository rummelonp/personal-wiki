// ローカル専用: owner のセッション cookie の値を SESSION_SECRET から直接作る。本番のログインは
// Access を通した /_auth/login だけが cookie を出すが、E2E と dev:owner は Access を持たないので、
// Worker と同じ形式で署名する。形式は src/auth/session.ts に合わせる（ずれると
// session-cookie.test.ts が落ちる）。
import { createHmac } from "node:crypto";

export const SESSION_COOKIE_NAME = "__Host-wiki_session";
const SIGNING_CONTEXT = "personal-wiki/session/v1.";
const SESSION_TTL_SECONDS = 24 * 60 * 60;

/**
 * cookie の値を作る。expiresAt は UNIX エポックの秒で、省くと Worker の発行と同じ 24 時間後。
 * @param {string} secret
 * @param {string} email
 * @param {number} [expiresAt]
 * @returns {string}
 */
export function mintSessionValue(
  secret,
  email,
  expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
) {
  const payloadPart = Buffer.from(JSON.stringify({ e: email, exp: expiresAt })).toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret)
    .update(SIGNING_CONTEXT + payloadPart)
    .digest("base64url");
  return `${payloadPart}.${signature}`;
}
