import { describe, expect, it } from "vitest";
import {
  AUDIENCE,
  fakeJwks,
  generateSigningKey,
  OWNER_EMAIL,
  type SigningKey,
  signAccessJwt,
  TEAM_DOMAIN,
} from "../test/owner";
import { createAccessVerifier } from "./access";
import { encodeBase64Url } from "./base64url";

const T0 = Date.UTC(2026, 9, 1);

async function setup(keys?: SigningKey[]) {
  const key = await generateSigningKey("key-1");
  const jwks = fakeJwks(keys ?? [key]);
  const clock = { now: T0 };
  const verifier = createAccessVerifier({ fetch: jwks.fetch, now: () => clock.now });
  const verify = (token: string) =>
    verifier.verify({ token, teamDomain: TEAM_DOMAIN, audience: AUDIENCE });
  return { key, jwks, clock, verify };
}

const encodeJson = (value: unknown) =>
  encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));

describe("Access の JWT の検証", () => {
  it("正しい JWT から email を取り出す。aud は文字列でも配列でもよい", async () => {
    const { key, verify } = await setup();
    expect(await verify(await signAccessJwt(key, T0))).toEqual({ ok: true, email: OWNER_EMAIL });
    expect(await verify(await signAccessJwt(key, T0, { payload: { aud: AUDIENCE } }))).toEqual({
      ok: true,
      email: OWNER_EMAIL,
    });
  });

  it("aud が違えば拒む", async () => {
    const { key, verify } = await setup();
    for (const aud of [["other"], "other", [], undefined]) {
      expect(await verify(await signAccessJwt(key, T0, { payload: { aud } }))).toEqual({
        ok: false,
        reason: "bad_audience",
      });
    }
  });

  it("iss が違えば拒む", async () => {
    const { key, verify } = await setup();
    for (const iss of ["https://evil.cloudflareaccess.example", TEAM_DOMAIN, undefined]) {
      expect(await verify(await signAccessJwt(key, T0, { payload: { iss } }))).toEqual({
        ok: false,
        reason: "bad_issuer",
      });
    }
  });

  it("期限切れと exp の無いものを拒む", async () => {
    const { key, verify, clock } = await setup();
    const token = await signAccessJwt(key, T0);
    clock.now = T0 + 24 * 60 * 60 * 1000;
    expect(await verify(token)).toEqual({ ok: false, reason: "expired" });
    clock.now = T0;
    expect(await verify(await signAccessJwt(key, T0, { payload: { exp: undefined } }))).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("nbf と iat が未来なら拒み、1 分以内のずれは許す", async () => {
    const { key, verify } = await setup();
    const future = Math.floor(T0 / 1000) + 120;
    expect(await verify(await signAccessJwt(key, T0, { payload: { nbf: future } }))).toEqual({
      ok: false,
      reason: "not_yet_valid",
    });
    expect(await verify(await signAccessJwt(key, T0, { payload: { iat: future } }))).toEqual({
      ok: false,
      reason: "not_yet_valid",
    });
    const near = Math.floor(T0 / 1000) + 30;
    expect(await verify(await signAccessJwt(key, T0, { payload: { nbf: near } }))).toMatchObject({
      ok: true,
    });
  });

  it("email が無ければ拒む", async () => {
    const { key, verify } = await setup();
    expect(await verify(await signAccessJwt(key, T0, { payload: { email: undefined } }))).toEqual({
      ok: false,
      reason: "missing_email",
    });
  });

  it("別の鍵で署名したものと、署名の後に payload を書き換えたものを拒む", async () => {
    const { key, verify } = await setup();
    const other = await generateSigningKey("key-1");
    expect(await verify(await signAccessJwt(other, T0))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const [header, , signature] = (await signAccessJwt(key, T0)).split(".");
    const forged = encodeJson({
      aud: [AUDIENCE],
      email: "attacker@example.com",
      exp: Math.floor(T0 / 1000) + 3600,
      iss: `https://${TEAM_DOMAIN}`,
    });
    expect(await verify(`${header}.${forged}.${signature}`)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("alg が none と HS256 のものを、鍵を引く前に拒む", async () => {
    const { key, verify, jwks } = await setup();
    const payload = encodeJson({
      aud: [AUDIENCE],
      email: OWNER_EMAIL,
      exp: Math.floor(T0 / 1000) + 3600,
      iss: `https://${TEAM_DOMAIN}`,
    });
    const none = `${encodeJson({ alg: "none", kid: key.kid })}.${payload}.`;
    expect(await verify(none)).toEqual({ ok: false, reason: "unsupported_alg" });

    // 公開鍵（誰でも JWKS から取れる）を HMAC の鍵にした偽造
    const hsHeader = encodeJson({ alg: "HS256", kid: key.kid });
    const hmacKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(JSON.stringify(key.publicJwk)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      hmacKey,
      new TextEncoder().encode(`${hsHeader}.${payload}`),
    );
    const hs256 = `${hsHeader}.${payload}.${encodeBase64Url(new Uint8Array(mac))}`;
    expect(await verify(hs256)).toEqual({ ok: false, reason: "unsupported_alg" });
    expect(jwks.state.calls).toBe(0);
  });

  it("JWKS の鍵の alg が RS256 でなければ拒む", async () => {
    const key = await generateSigningKey("key-1");
    const { verify } = await setup([{ ...key, publicJwk: { ...key.publicJwk, alg: "RS512" } }]);
    expect(await verify(await signAccessJwt(key, T0))).toEqual({
      ok: false,
      reason: "unsupported_alg",
    });
  });

  it("形式の崩れた JWT を拒む", async () => {
    const { verify } = await setup();
    for (const token of ["", "a.b", "a.b.c.d", "!!.!!.!!", `${encodeJson([1])}.e30.`]) {
      expect(await verify(token)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  describe("JWKS の取得", () => {
    it("取得した JWKS を使い回す", async () => {
      const { key, verify, jwks } = await setup();
      await verify(await signAccessJwt(key, T0));
      await verify(await signAccessJwt(key, T0));
      expect(jwks.state.calls).toBe(1);
    });

    it("kid が見つからなければ 1 回だけ取り直し、それでも無ければ拒む", async () => {
      const { key, verify, jwks, clock } = await setup();
      await verify(await signAccessJwt(key, T0));
      clock.now = T0 + 30 * 1000;
      const unknown = await generateSigningKey("key-unknown");
      expect(await verify(await signAccessJwt(unknown, clock.now))).toEqual({
        ok: false,
        reason: "unknown_kid",
      });
      expect(jwks.state.calls).toBe(2);
    });

    it("前回の取得から 30 秒以内は、知らない kid でも取り直さない", async () => {
      const { key, verify, jwks, clock } = await setup();
      await verify(await signAccessJwt(key, T0));
      const unknown = await generateSigningKey("key-unknown");
      for (const elapsed of [0, 1000, 29 * 1000]) {
        clock.now = T0 + elapsed;
        expect(await verify(await signAccessJwt(unknown, clock.now))).toEqual({
          ok: false,
          reason: "unknown_kid",
        });
      }
      expect(jwks.state.calls).toBe(1);
      // 取り直した後も、そこから 30 秒は取り直さない
      clock.now = T0 + 30 * 1000;
      await verify(await signAccessJwt(unknown, clock.now));
      clock.now = T0 + 45 * 1000;
      await verify(await signAccessJwt(unknown, clock.now));
      expect(jwks.state.calls).toBe(2);
    });

    it("鍵が入れ替わったら、取り直した JWKS の新しい鍵で検証する", async () => {
      const { key, verify, jwks, clock } = await setup();
      await verify(await signAccessJwt(key, T0));
      const rotated = await generateSigningKey("key-2");
      jwks.state.keys = [key, rotated];
      clock.now = T0 + 60 * 1000;
      expect(await verify(await signAccessJwt(rotated, clock.now))).toMatchObject({ ok: true });
      expect(jwks.state.calls).toBe(2);
    });

    it("TTL の 1 時間が過ぎたら JWKS を取り直す", async () => {
      const { key, verify, jwks, clock } = await setup();
      await verify(await signAccessJwt(key, T0));
      clock.now = T0 + 60 * 60 * 1000 - 1;
      await verify(await signAccessJwt(key, clock.now));
      expect(jwks.state.calls).toBe(1);
      clock.now = T0 + 60 * 60 * 1000;
      expect(await verify(await signAccessJwt(key, clock.now))).toMatchObject({ ok: true });
      expect(jwks.state.calls).toBe(2);
    });

    it("JWKS を取れなければ拒む", async () => {
      const { key, verify, jwks } = await setup();
      jwks.state.fail = true;
      expect(await verify(await signAccessJwt(key, T0))).toEqual({
        ok: false,
        reason: "jwks_unavailable",
      });
    });
  });
});
