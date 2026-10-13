import { decodeBase64Url, decodeBase64UrlJson } from "./base64url";

/*
 * Cloudflare Access が `/_auth/login` へのリクエストに付ける `Cf-Access-Jwt-Assertion` を検証する。
 * 外部ライブラリを使わず WebCrypto で書く。受け付けるのは Access が使う RS256 だけで、検証の範囲が
 * 狭く、alg の選択や鍵の取り直しの規則をこのファイルの中で読み切れるようにするため。
 */

export type AccessVerifyResult =
  | { ok: true; email: string }
  | {
      ok: false;
      reason:
        | "malformed"
        | "unsupported_alg"
        | "unknown_kid"
        | "jwks_unavailable"
        | "bad_signature"
        | "bad_issuer"
        | "bad_audience"
        | "expired"
        | "not_yet_valid"
        | "missing_email";
    };

export interface AccessVerifierOptions {
  /** JWKS の取得に使う fetch。テストだけが差し替える */
  fetch?: (url: string) => Promise<Response>;
  /** UNIX エポックのミリ秒 */
  now: () => number;
}

export interface AccessVerifyInput {
  token: string;
  teamDomain: string;
  audience: string;
}

/**
 * 取得した JWKS を使い回す時間。Access は鍵を定期的に入れ替え、古い鍵もしばらく残すので、
 * 1 時間ごとの取り直しと、kid が見つからないときの 1 回の取り直しで追従できる。
 */
const JWKS_TTL_MS = 60 * 60 * 1000;

/**
 * kid が見つからないときの取り直しの最小間隔。未知の kid を並べた JWT で JWKS の取得を
 * 繰り返させない。Access は新しい鍵を使い始める前から JWKS に載せるので、直前に取った JWKS に
 * 無い kid を、間隔を空けずに取り直して救う必要は薄い。
 */
const JWKS_MIN_REFRESH_INTERVAL_MS = 30 * 1000;

/**
 * nbf と iat に許す時計のずれ。exp には許さない（ログインは JWT の発行直後に行われ、
 * 期限の近い JWT を救う必要が無い）。
 */
const CLOCK_SKEW_MS = 60 * 1000;

interface CachedJwks {
  keys: JsonWebKey[];
  fetchedAt: number;
}

interface RsaJwk extends JsonWebKey {
  kid?: string;
}

export interface AccessVerifier {
  verify(input: AccessVerifyInput): Promise<AccessVerifyResult>;
}

/** JWKS のキャッシュは返したオブジェクトが持つ。createApp ごとに 1 つなので isolate 内で共有される。 */
export function createAccessVerifier({
  fetch: fetchJwks = (url) => fetch(url),
  now,
}: AccessVerifierOptions): AccessVerifier {
  const cache = new Map<string, CachedJwks>();

  async function loadKeys(teamDomain: string, refresh: boolean): Promise<JsonWebKey[] | null> {
    const cached = cache.get(teamDomain);
    if (!refresh && cached !== undefined && now() - cached.fetchedAt < JWKS_TTL_MS) {
      return cached.keys;
    }
    try {
      const res = await fetchJwks(`https://${teamDomain}/cdn-cgi/access/certs`);
      if (!res.ok) return null;
      const body: unknown = await res.json();
      const keys = (body as { keys?: unknown } | null)?.keys;
      if (!Array.isArray(keys)) return null;
      const valid = keys.filter((k): k is JsonWebKey => typeof k === "object" && k !== null);
      cache.set(teamDomain, { keys: valid, fetchedAt: now() });
      return valid;
    } catch {
      return null;
    }
  }

  async function findKey(teamDomain: string, kid: string): Promise<RsaJwk | "missing" | null> {
    const select = (keys: JsonWebKey[]) =>
      keys.find((k): k is RsaJwk => (k as RsaJwk).kid === kid && k.kty === "RSA");
    const first = await loadKeys(teamDomain, false);
    if (first === null) return null;
    const hit = select(first);
    if (hit !== undefined) return hit;
    // 鍵の入れ替え直後はキャッシュに新しい kid が無いので、1 回だけ取り直す
    const fetchedAt = cache.get(teamDomain)?.fetchedAt;
    if (fetchedAt !== undefined && now() - fetchedAt < JWKS_MIN_REFRESH_INTERVAL_MS) {
      return "missing";
    }
    const second = await loadKeys(teamDomain, true);
    if (second === null) return null;
    return select(second) ?? "missing";
  }

  return {
    async verify({ token, teamDomain, audience }) {
      const parts = token.split(".");
      if (parts.length !== 3) return { ok: false, reason: "malformed" };
      const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
      const header = decodeBase64UrlJson(headerPart);
      const payload = decodeBase64UrlJson(payloadPart);
      const signature = decodeBase64Url(signaturePart);
      if (header === null || payload === null || signature === null) {
        return { ok: false, reason: "malformed" };
      }
      // alg はヘッダーの値に従って選ばず、RS256 以外を拒む（none や、公開鍵を HMAC の鍵に使う HS256 の偽造を通さない）
      if (header.alg !== "RS256") return { ok: false, reason: "unsupported_alg" };
      if (typeof header.kid !== "string") return { ok: false, reason: "malformed" };

      const jwk = await findKey(teamDomain, header.kid);
      if (jwk === null) return { ok: false, reason: "jwks_unavailable" };
      if (jwk === "missing") return { ok: false, reason: "unknown_kid" };
      if (jwk.alg !== undefined && jwk.alg !== "RS256") {
        return { ok: false, reason: "unsupported_alg" };
      }
      const { n, e } = jwk;
      if (typeof n !== "string" || typeof e !== "string") {
        return { ok: false, reason: "bad_signature" };
      }
      let valid: boolean;
      try {
        const key = await crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n, e, alg: "RS256", ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
        valid = await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          key,
          signature,
          new TextEncoder().encode(`${headerPart}.${payloadPart}`),
        );
      } catch {
        valid = false;
      }
      if (!valid) return { ok: false, reason: "bad_signature" };

      if (payload.iss !== `https://${teamDomain}`) return { ok: false, reason: "bad_issuer" };
      const aud = payload.aud;
      const audiences = Array.isArray(aud) ? aud : [aud];
      if (!audiences.includes(audience)) return { ok: false, reason: "bad_audience" };
      const current = now();
      if (typeof payload.exp !== "number" || payload.exp * 1000 <= current) {
        return { ok: false, reason: "expired" };
      }
      for (const claim of [payload.nbf, payload.iat]) {
        if (claim === undefined) continue;
        if (typeof claim !== "number" || claim * 1000 > current + CLOCK_SKEW_MS) {
          return { ok: false, reason: "not_yet_valid" };
        }
      }
      if (typeof payload.email !== "string" || payload.email === "") {
        return { ok: false, reason: "missing_email" };
      }
      return { ok: true, email: payload.email };
    },
  };
}
