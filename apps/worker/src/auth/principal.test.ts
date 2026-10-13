import { describe, expect, it } from "vitest";
import { hasScope, readableVisibilityOf } from "./principal";

describe("hasScope", () => {
  it("write は read を含む", () => {
    expect(hasScope(["write"], "read")).toBe(true);
    expect(hasScope(["read", "write"], "read")).toBe(true);
    expect(hasScope(["write"], "write")).toBe(true);
  });

  it("read だけでは write を満たさない", () => {
    expect(hasScope(["read"], "read")).toBe(true);
    expect(hasScope(["read"], "write")).toBe(false);
  });

  it("scope が空なら何も満たさない", () => {
    expect(hasScope([], "read")).toBe(false);
    expect(hasScope([], "write")).toBe(false);
  });
});

describe("readableVisibilityOf", () => {
  it("owner と read を持つ token は draft も読み、anonymous は public だけ", () => {
    expect(readableVisibilityOf({ kind: "owner" })).toBe("all");
    expect(
      readableVisibilityOf({ kind: "token", issuer: "api", name: "r", scopes: ["read"] }),
    ).toBe("all");
    expect(
      readableVisibilityOf({ kind: "token", issuer: "api", name: "w", scopes: ["write"] }),
    ).toBe("all");
    expect(readableVisibilityOf({ kind: "anonymous" })).toBe("public");
    expect(readableVisibilityOf({ kind: "anonymous", staleSession: true })).toBe("public");
  });

  it("scope の無い token には draft を見せない", () => {
    expect(readableVisibilityOf({ kind: "token", issuer: "api", name: "none", scopes: [] })).toBe(
      "public",
    );
  });
});
