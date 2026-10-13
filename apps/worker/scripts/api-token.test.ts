import { describe, expect, it } from "vitest";
import {
  generateToken,
  hashToken,
  issueSql,
  parseArgs,
  revokeSql,
  wranglerArgs,
} from "./api-token.mjs";

describe("generateToken", () => {
  it("32 バイトの乱数を 43 文字の base64url にする", () => {
    const tokens = Array.from({ length: 20 }, () => generateToken());
    expect(new Set(tokens).size).toBe(20);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
    }
  });
});

describe("hashToken", () => {
  it("Worker の hashApiToken と同じ SHA-256 の小文字 hex を返す", () => {
    expect(hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("parseArgs", () => {
  it("既定はローカルで、--remote を付けたときだけリモートにする", () => {
    expect(parseArgs(["issue", "laptop", "--scopes", "read"])).toEqual({
      command: "issue",
      name: "laptop",
      scopes: "read",
      remote: false,
    });
    expect(parseArgs(["revoke", "laptop", "--remote"])).toEqual({
      command: "revoke",
      name: "laptop",
      remote: true,
    });
  });

  it("write は read を含む scopes にそろえる", () => {
    expect(parseArgs(["issue", "a", "--scopes=read,write"])).toMatchObject({
      scopes: "read write",
    });
    expect(parseArgs(["issue", "a", "--scopes", "write"])).toMatchObject({ scopes: "read write" });
  });

  it("SQL に埋め込めない名前を拒否する", () => {
    for (const name of ["x'; DROP TABLE api_tokens; --", "a b", "", "-a", "a".repeat(65)]) {
      expect(() => parseArgs(["revoke", name])).toThrow();
    }
  });

  it("scopes の指定が無い・未知の発行を拒否する", () => {
    expect(() => parseArgs(["issue", "a"])).toThrow();
    expect(() => parseArgs(["issue", "a", "--scopes", "admin"])).toThrow();
  });

  it("未知のコマンドとオプションを拒否する", () => {
    expect(() => parseArgs(["list", "a"])).toThrow();
    expect(() => parseArgs(["revoke", "a", "--force"])).toThrow();
    expect(() => parseArgs(["revoke", "a", "extra"])).toThrow();
  });
});

describe("SQL と wrangler の引数", () => {
  it("平文ではなく hash を登録する", () => {
    const token = generateToken();
    const sql = issueSql({ name: "laptop", tokenHash: hashToken(token), scopes: "read", now: 1 });
    expect(sql).toContain(hashToken(token));
    expect(sql).not.toContain(token);
  });

  it("失効済みの行は書き換えない", () => {
    expect(revokeSql({ name: "laptop", now: 1 })).toContain("revoked_at IS NULL");
  });

  it("--local と --remote を切り替える", () => {
    expect(wranglerArgs("SELECT 1", false)).toContain("--local");
    expect(wranglerArgs("SELECT 1", false)).not.toContain("--remote");
    expect(wranglerArgs("SELECT 1", true)).toContain("--remote");
  });
});
