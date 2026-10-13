import { describe, expect, it } from "vitest";
import { hasScope } from "./principal";

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
