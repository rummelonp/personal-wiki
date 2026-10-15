import { describe, expect, it } from "vitest";
import {
  generateToken,
  hashToken,
  issueSql,
  main,
  parseArgs,
  revokeSql,
  run,
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

  it("scopes の指定が無いか未知のときは、発行を拒否する", () => {
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
    expect(wranglerArgs("SELECT 1", { remote: false })).toContain("--local");
    expect(wranglerArgs("SELECT 1", { remote: false })).not.toContain("--remote");
    const remote = wranglerArgs("SELECT 1", {
      remote: true,
      configPath: "/w/wrangler.deploy.json",
    });
    expect(remote).toContain("--remote");
    expect(remote).not.toContain("--local");
    expect(remote.slice(remote.indexOf("--config"), remote.indexOf("--config") + 2)).toEqual([
      "--config",
      "/w/wrangler.deploy.json",
    ]);
  });
});

describe("main", () => {
  /** wrangler の代わりに、結果の行を返すだけの spawn を使う。 */
  function fakeIo(rows: unknown[] = []) {
    const out = { stdout: "", stderr: "", spawnArgs: [] as string[][] };
    const io = {
      spawn: (_command: string, args: string[]) => {
        out.spawnArgs.push(args);
        return { status: 0, stdout: JSON.stringify([{ results: rows }]) };
      },
      stdout: { write: (chunk: string) => (out.stdout += chunk) },
      stderr: { write: (chunk: string) => (out.stderr += chunk) },
      now: () => 1,
    };
    return { io, out };
  }

  it("発行したトークンの平文は標準出力にだけ出し、wrangler には hash だけを渡す", () => {
    const { io, out } = fakeIo([{ id: 1 }]);
    expect(run(["issue", "laptop", "--scopes", "read"], io)).toBe(0);
    const token = out.stdout.trimEnd();
    expect(out.stdout).toBe(`${token}\n`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(out.stderr).not.toContain(token);
    expect(out.spawnArgs).toHaveLength(1);
    const args = out.spawnArgs[0]?.join(" ") ?? "";
    expect(args).toContain(hashToken(token));
    expect(args).not.toContain(token);
    expect(args).toContain("--local");
  });

  it("名前が使用済み（失効済みを含む）なら、平文を出さずに使用済みと伝えて終了コード 1 にする", () => {
    const { io, out } = fakeIo([]);
    expect(run(["issue", "laptop", "--scopes", "read"], io)).toBe(1);
    expect(out.stderr).toContain('token name "laptop" is already used');
    expect(out.stdout).toBe("");
  });

  it("失効させる行が無ければ終了コード 1 にする", () => {
    const { io, out } = fakeIo([]);
    expect(run(["revoke", "nobody"], io)).toBe(1);
    expect(out.stderr).toContain('no active token named "nobody"');
    expect(out.stdout).toBe("");
  });

  it("失効させた行があれば終了コード 0 にする", () => {
    const { io } = fakeIo([{ id: 1 }]);
    expect(run(["revoke", "laptop"], io)).toBe(0);
  });

  it("wrangler が失敗したら、平文を出さずに終了コード 1 にする", () => {
    const { io, out } = fakeIo();
    io.spawn = (_command, args) => {
      out.spawnArgs.push(args);
      return { status: 1, stdout: "" };
    };
    expect(run(["issue", "laptop", "--scopes", "read"], io)).toBe(1);
    expect(out.stdout).toBe("");
  });

  it("未知のオプションでは wrangler を呼ばずに例外を投げる", () => {
    const { io, out } = fakeIo();
    expect(() => main(["revoke", "laptop", "--force"], io)).toThrow("unknown option: --force");
    expect(out.spawnArgs).toHaveLength(0);
  });
});
