import { describe, expect, it } from "vitest";
import { fetchMe, loginHref, logout, parseMe } from "./api";

describe("loginHref", () => {
  it("今のパス、クエリ、フラグメントを return に入れる", () => {
    expect(loginHref({ pathname: "/p/abc", search: "?x=1&y=2", hash: "#h" })).toBe(
      "/_auth/login?return=%2Fp%2Fabc%3Fx%3D1%26y%3D2%23h",
    );
    expect(loginHref({ pathname: "/", search: "", hash: "" })).toBe("/_auth/login?return=%2F");
  });
});

describe("parseMe", () => {
  const off = { attachments: false, linkRewrites: false };

  it("知らない形は anonymous にする", () => {
    for (const value of [
      null,
      "owner",
      { kind: "admin" },
      { kind: "token", name: 1, scopes: [] },
    ]) {
      expect(parseMe(value)).toEqual({ kind: "anonymous", features: off });
    }
  });

  it("owner、token、anonymous を読み、features を添える", () => {
    expect(parseMe({ kind: "owner" })).toEqual({ kind: "owner", features: off });
    expect(parseMe({ kind: "token", name: "a", scopes: ["read"] })).toEqual({
      kind: "token",
      name: "a",
      scopes: ["read"],
      features: off,
    });
    expect(parseMe({ kind: "anonymous" })).toEqual({ kind: "anonymous", features: off });
  });

  it("features.attachments は true のときだけ true にし、項目が無ければ false にする", () => {
    const on = { attachments: true, linkRewrites: true };
    expect(parseMe({ kind: "owner", features: { attachments: true } })).toEqual({
      kind: "owner",
      features: on,
    });
    expect(parseMe({ kind: "anonymous", features: { attachments: true } })).toEqual({
      kind: "anonymous",
      features: on,
    });
    for (const features of [{ attachments: false }, {}, { attachments: "true" }]) {
      expect(parseMe({ kind: "owner", features })).toEqual({
        kind: "owner",
        features: { attachments: false, linkRewrites: true },
      });
    }
  });

  it("features が無い（step の無い前の版の）Worker では、リンクの書き換えも使えないものとする", () => {
    for (const features of [undefined, null, "yes", 1]) {
      expect(parseMe({ kind: "owner", features })).toEqual({ kind: "owner", features: off });
    }
  });

  it("知らない kind の応答の features は読まない", () => {
    expect(parseMe({ kind: "admin", features: { attachments: true } })).toEqual({
      kind: "anonymous",
      features: off,
    });
  });
});

describe("fetchMe と logout", () => {
  it("/api/me を cookie 付きで引く", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const me = await fetchMe(async (input, init) => {
      calls.push([input, init]);
      return Response.json({ kind: "owner" });
    });
    expect(me).toEqual({ kind: "owner", features: { attachments: false, linkRewrites: false } });
    expect(calls).toEqual([["/api/me", { credentials: "same-origin", cache: "no-store" }]]);
  });

  it("ログアウトは JSON の POST で送り、失敗したら例外にする", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    await logout(async (input, init) => {
      calls.push([input, init]);
      return new Response(null, { status: 204 });
    });
    expect(calls[0]?.[0]).toBe("/_auth/logout");
    expect(calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await expect(logout(async () => new Response(null, { status: 403 }))).rejects.toThrow();
  });
});
