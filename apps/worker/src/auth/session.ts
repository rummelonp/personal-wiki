import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { decodeBase64Url, decodeBase64UrlJson, encodeBase64Url } from "./base64url";
import { isOwnerEmail, type OwnerAuthConfig } from "./owner-config";

/*
 * owner のセッション cookie。Access の検証を通った後に /_auth/login が発行し、以後のリクエストでは
 * Access を通さずにこの cookie だけで owner を決める。サーバー側に状態を持たず、署名と期限だけで判定する。
 *
 * 値は `<payload の base64url>.<HMAC-SHA256 の base64url>`。payload は `{ e: email, exp: 秒 }`。
 * email を入れるのは、許可リストから外したメールの cookie を期限前でも無効にするため。
 */

/**
 * `__Host-` を付けると、ブラウザは Secure・Path=/・Domain 無しの cookie しか受け付けない。
 * 同じ親ドメインの別のサブドメインから同名の cookie を上書きされない。
 */
export const SESSION_COOKIE_NAME = "__Host-wiki_session";

/** Access のセッション期間の既定値に合わせる。 */
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

// 署名の対象に用途を入れ、同じ秘密で別の用途の値に署名しても session として通らないようにする
const SIGNING_CONTEXT = "personal-wiki/session/v1.";

// 鍵の取り込みを cookie 付きのリクエストごとに繰り返さないよう、isolate の中で使い回す。
// 秘密は通常 1 つなので、最後に使った 1 組だけを持つ（入れ替え後は古い鍵を持ち続けない）
let cachedKey: { secret: string; key: Promise<CryptoKey> } | undefined;

function hmacKey(secret: string): Promise<CryptoKey> {
  if (cachedKey?.secret !== secret) {
    const key = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    cachedKey = { secret, key };
  }
  return cachedKey.key;
}

function signingInput(payloadPart: string): Uint8Array {
  return new TextEncoder().encode(SIGNING_CONTEXT + payloadPart);
}

/** cookie の値を作る。now は UNIX エポックのミリ秒。 */
export async function createSessionValue(
  config: OwnerAuthConfig,
  email: string,
  now: number,
): Promise<string> {
  const payload = { e: email, exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS };
  const payloadPart = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(config.sessionSecret),
    signingInput(payloadPart),
  );
  return `${payloadPart}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/** 署名、期限、許可リストのどれかが合わなければ false。 */
export async function verifySessionValue(
  config: OwnerAuthConfig,
  value: string,
  now: number,
): Promise<boolean> {
  const parts = value.split(".");
  if (parts.length !== 2) return false;
  const [payloadPart, signaturePart] = parts as [string, string];
  const signature = decodeBase64Url(signaturePart);
  if (signature === null) return false;
  // crypto.subtle.verify は比較の時間が一致した長さに依存しない
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(config.sessionSecret),
    signature,
    signingInput(payloadPart),
  );
  if (!valid) return false;
  const payload = decodeBase64UrlJson(payloadPart);
  if (payload === null) return false;
  const { e: email, exp } = payload;
  if (typeof email !== "string" || typeof exp !== "number") return false;
  if (exp * 1000 <= now) return false;
  return isOwnerEmail(config, email);
}

/** 自前のセッション cookie の値。付いていなければ undefined（中身は検証しない）。 */
export function sessionCookieOf(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE_NAME);
}

/** Set-Cookie の属性。発行と削除で揃えないと、ブラウザが削除を別の cookie として扱う。 */
export const SESSION_COOKIE_ATTRIBUTES = {
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "Lax",
} as const;
