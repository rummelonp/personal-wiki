import { env } from "cloudflare:workers";
import { encodeBase64Url } from "../auth/base64url";
import { readOwnerAuthConfig } from "../auth/owner-config";
import { createSessionValue, SESSION_COOKIE_NAME } from "../auth/session";
import type { Bindings } from "../env";

export const TEAM_DOMAIN = "team.cloudflareaccess.example";
export const AUDIENCE = "a".repeat(64);
export const OWNER_EMAIL = "owner@example.com";
export const SESSION_SECRET = "s".repeat(44);
export const JWKS_URL = `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`;

/** owner のログインに要る設定をすべて入れた env。 */
export function ownerEnv(overrides: Partial<Bindings> = {}): Bindings {
  return {
    ...env,
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD: AUDIENCE,
    OWNER_EMAILS: `other@example.com, ${OWNER_EMAIL}`,
    SESSION_SECRET,
    ...overrides,
  };
}

export function ownerConfig() {
  const config = readOwnerAuthConfig(ownerEnv());
  if (config === null) throw new Error("ownerEnv の設定が足りない");
  return config;
}

/** 有効な owner のセッション cookie を `Cookie` ヘッダーの値にして返す。 */
export async function ownerCookie(now: number, secret = SESSION_SECRET): Promise<string> {
  const value = await createSessionValue(
    { ...ownerConfig(), sessionSecret: secret },
    OWNER_EMAIL,
    now,
  );
  return `${SESSION_COOKIE_NAME}=${value}`;
}

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey & { kid: string };
}

export async function generateSigningKey(kid: string): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    kid,
    privateKey: pair.privateKey,
    publicJwk: { kty: "RSA", n: exported.n, e: exported.e, alg: "RS256", kid } as JsonWebKey & {
      kid: string;
    },
  };
}

const encodeJson = (value: unknown) =>
  encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));

/** Access が発行する形の JWT を作る。now は UNIX エポックのミリ秒。 */
export async function signAccessJwt(
  key: SigningKey,
  now: number,
  overrides: { header?: Record<string, unknown>; payload?: Record<string, unknown> } = {},
): Promise<string> {
  const seconds = Math.floor(now / 1000);
  const header = encodeJson({ alg: "RS256", kid: key.kid, typ: "JWT", ...overrides.header });
  const payload = encodeJson({
    aud: [AUDIENCE],
    email: OWNER_EMAIL,
    exp: seconds + 24 * 60 * 60,
    iat: seconds,
    nbf: seconds,
    iss: `https://${TEAM_DOMAIN}`,
    sub: "user-id",
    type: "app",
    ...overrides.payload,
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/** JWKS の fetch の差し替え。呼ばれた回数を数え、返す鍵を途中で入れ替えられる。 */
export function fakeJwks(keys: SigningKey[]) {
  const state = { keys, calls: 0, fail: false };
  const fetch = async (url: string) => {
    state.calls += 1;
    if (url !== JWKS_URL || state.fail) return new Response("unavailable", { status: 503 });
    return Response.json({ keys: state.keys.map((k) => k.publicJwk) });
  };
  return { state, fetch };
}
