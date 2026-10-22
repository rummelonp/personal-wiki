import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";
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

/** R2 の binding を外した ownerEnv（添付を使えない構成）。 */
export function ownerEnvWithoutBucket(): Bindings {
  const { BUCKET: _, ...rest } = ownerEnv();
  return rest;
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

interface KeyPair {
  privateKey: CryptoKey;
  n: string;
  e: string;
}

// RSA 2048 の鍵の生成は素数探しで、所要時間がぶれ、負荷が高いと 1 回に数秒かかる。テストごとに作ると
// 時間切れで落ちるので、ファイルごとに slot ごとの 1 組を使い回す。kid は組に付ける名札で、組とは別に決める
const keyPairs = new Map<number, Promise<KeyPair>>();

async function generateKeyPair(): Promise<KeyPair> {
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
  return { privateKey: pair.privateKey, n: exported.n as string, e: exported.e as string };
}

/**
 * 署名の鍵を返す。同じ slot は同じ組の鍵を返すので、別の鍵が要るテスト（別の鍵で署名したものを拒む、
 * 鍵の入れ替え）は別の slot を渡す。
 */
export async function signingKey(kid: string, slot = 0): Promise<SigningKey> {
  let pair = keyPairs.get(slot);
  if (pair === undefined) {
    pair = generateKeyPair();
    keyPairs.set(slot, pair);
  }
  const { privateKey, n, e } = await pair;
  return {
    kid,
    privateKey,
    publicJwk: { kty: "RSA", n, e, alg: "RS256", kid } as JsonWebKey & { kid: string },
  };
}

/**
 * slot が 0 から slots 未満の鍵を、ファイルの最初のテストより前に作る。テストの中で作ると、生成の
 * 時間が最初に使うテストの時間切れ（5 秒）に数えられ、負荷が高いと生成が数秒かかって落ちる。
 * 生成の所要時間は乱数で大きくぶれるので、hook の時間切れは 5 秒でなく 1 分にする。
 */
export function pregenerateSigningKeys(slots: number): void {
  beforeAll(async () => {
    await Promise.all(Array.from({ length: slots }, (_, slot) => signingKey("pregenerated", slot)));
  }, 60_000);
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
