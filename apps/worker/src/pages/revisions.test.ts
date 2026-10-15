import { describe, expect, it } from "vitest";
import { actorOf } from "./revisions";

describe("actorOf", () => {
  it("api_tokens の token は id と name、OAuth は client_id、owner は owner", () => {
    expect(actorOf({ kind: "owner" })).toBe("owner");
    expect(
      actorOf({ kind: "token", issuer: "api", id: 7, name: "air-claude", scopes: ["read"] }),
    ).toBe("token:7:air-claude");
    expect(actorOf({ kind: "token", issuer: "oauth", name: "client-1", scopes: ["read"] })).toBe(
      "oauth:client-1",
    );
  });

  it("同じ名前の token でも id が違えば別の actor になる", () => {
    const of = (id: number) =>
      actorOf({ kind: "token", issuer: "api", id, name: "air-claude", scopes: ["read"] });
    expect(of(1)).not.toBe(of(2));
  });

  it("数字だけの name でも、name の UNIQUE を外す前の形（token:<name>）と重ならない", () => {
    // 前の形で name が "12" の token と、新しい形で id が 12 の token
    expect(actorOf({ kind: "token", issuer: "api", id: 12, name: "x", scopes: [] })).not.toBe(
      "token:12",
    );
  });

  it("anonymous は書き込めない", () => {
    expect(() => actorOf({ kind: "anonymous" })).toThrow();
  });
});
