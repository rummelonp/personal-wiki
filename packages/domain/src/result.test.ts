import { describe, expect, it } from "vitest";
import { err, isErr, isOk, mapResult, ok } from "./result";

describe("Result", () => {
  it("ok() creates a value carrying ok:true", () => {
    const result = ok(42);
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it("err() creates a value carrying ok:false", () => {
    const result = err("boom");
    expect(result).toEqual({ ok: false, error: "boom" });
  });

  it("isOk() narrows an Ok result", () => {
    const result = ok(1);
    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
  });

  it("isErr() narrows an Err result", () => {
    const result = err("boom");
    expect(isErr(result)).toBe(true);
    expect(isOk(result)).toBe(false);
  });

  it("mapResult() transforms the value of an Ok result", () => {
    const result = mapResult(ok(2), (n) => n * 10);
    expect(result).toEqual({ ok: true, value: 20 });
  });

  it("mapResult() passes an Err result through unchanged", () => {
    const original = err("boom");
    const result = mapResult(original, (n: number) => n * 10);
    expect(result).toBe(original);
  });
});
