import { describe, expect, it } from "vitest";
import { generateTestToken } from "../test/tokens";
import { hashApiToken, isWellFormedApiToken } from "./token";

describe("isWellFormedApiToken", () => {
  it("発行する形式（32 バイトの base64url）を受理する", () => {
    expect(isWellFormedApiToken(generateTestToken())).toBe(true);
  });

  it("長さが違えば拒否する", () => {
    const token = generateTestToken();
    expect(isWellFormedApiToken(token.slice(0, -1))).toBe(false);
    expect(isWellFormedApiToken(`${token}x`)).toBe(false);
    expect(isWellFormedApiToken("")).toBe(false);
  });

  it("base64url 以外の文字を含む同じ長さの文字列を拒否する", () => {
    const token = generateTestToken();
    // 標準 base64 の文字（+ /）や padding（=）は base64url に含まれない。
    expect(isWellFormedApiToken(`${token.slice(0, -1)}+`)).toBe(false);
    expect(isWellFormedApiToken(`${token.slice(0, -1)}/`)).toBe(false);
    expect(isWellFormedApiToken(`${token.slice(0, -1)}=`)).toBe(false);
    expect(isWellFormedApiToken(`${token.slice(0, -1)} `)).toBe(false);
  });
});

describe("hashApiToken", () => {
  it("SHA-256 の小文字 hex を返す", async () => {
    // 発行スクリプトのテストと同じ既知の値で、両者の計算が揃っていることを確かめる
    expect(await hashApiToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
