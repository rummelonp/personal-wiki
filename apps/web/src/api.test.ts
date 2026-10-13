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
  it("知らない形は anonymous にする", () => {
    expect(parseMe({ kind: "owner" })).toEqual({ kind: "owner" });
    expect(parseMe({ kind: "token", name: "a", scopes: ["read"] })).toEqual({
      kind: "token",
      name: "a",
      scopes: ["read"],
    });
    for (const value of [
      null,
      "owner",
      { kind: "admin" },
      { kind: "token", name: 1, scopes: [] },
    ]) {
      expect(parseMe(value)).toEqual({ kind: "anonymous" });
    }
  });
});

describe("fetchMe と logout", () => {
  it("/api/me を cookie 付きで引く", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const me = await fetchMe(async (input, init) => {
      calls.push([input, init]);
      return Response.json({ kind: "owner" });
    });
    expect(me).toEqual({ kind: "owner" });
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
