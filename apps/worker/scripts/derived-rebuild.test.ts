import { describe, expect, it } from "vitest";
import { parseArgs, rebuildAll, run } from "./derived-rebuild.mjs";

const TOKEN = "t".repeat(43);

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { after: string | null };
}

/** 応答を順に返す fetch。呼び出しの内容を calls に溜める。 */
function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchFn: fetchFn as typeof fetch, calls };
}

const ok = (body: object) => Response.json(body);
const step = (next: string | null, extra: object = {}) =>
  ok({ rebuilt: 1, skipped: 0, failed: [], next, rowsWritten: 9, ...extra });

function fakeIo(responses: (Response | Error)[], env: Record<string, string | undefined>) {
  const { fetchFn, calls } = fakeFetch(responses);
  const out = { stderr: "" };
  const io = {
    fetch: fetchFn,
    env,
    stderr: { write: (chunk: string) => (out.stderr += chunk) },
    readDeployEnv: () =>
      "WIKI_HOSTNAME=wiki.example.com\nD1_DATABASE_ID=0b1c2d3e-0000-4000-8000-000000000000\n",
  };
  return { io, out, calls };
}

describe("parseArgs", () => {
  it("既定はローカルで、先頭から始める", () => {
    expect(parseArgs([])).toEqual({ remote: false, url: undefined, after: null });
    expect(parseArgs(["--remote", "--after", "abc"])).toEqual({
      remote: true,
      url: undefined,
      after: "abc",
    });
  });

  it("未知の引数、origin でない --url、--remote との併用を拒否する", () => {
    expect(() => parseArgs(["--force"])).toThrow("unknown argument");
    expect(() => parseArgs(["--url", "http://localhost:8787/path"])).toThrow("--url");
    expect(() => parseArgs(["--remote", "--url", "http://localhost:8787"])).toThrow(
      "cannot be combined",
    );
    expect(() => parseArgs(["--after"])).toThrow("--after");
  });
});

describe("rebuildAll", () => {
  it("next が null になるまで、前の応答の next を after にして呼ぶ", async () => {
    const { fetchFn, calls } = fakeFetch([step("a"), step("b"), step(null, { rebuilt: 0 })]);
    const summary = await rebuildAll({
      baseUrl: "http://x",
      token: TOKEN,
      after: null,
      fetch: fetchFn,
    });
    expect(calls.map((c) => c.body.after)).toEqual([null, "a", "b"]);
    expect(summary).toMatchObject({ rebuilt: 2, calls: 3, failed: [], error: null });
    for (const call of calls) {
      expect(call.url).toBe("http://x/api/admin/derived/rebuild");
      expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(call.headers["User-Agent"]).toBe("personal-wiki-derived-rebuild");
    }
  });

  it("HTTP の失敗では再開位置を返して止まる", async () => {
    const { fetchFn } = fakeFetch([
      step("a"),
      Response.json({ error: "forbidden" }, { status: 403 }),
    ]);
    const summary = await rebuildAll({
      baseUrl: "http://x",
      token: TOKEN,
      after: null,
      fetch: fetchFn,
    });
    expect(summary).toMatchObject({
      rebuilt: 1,
      stoppedAfter: "a",
      error: "server returned 403 (forbidden)",
    });
  });

  it("通信の失敗、JSON でない応答、形の違う応答、進まない cursor で止まる", async () => {
    const cases: [Response | Error, string][] = [
      [new Error("boom"), "request failed: boom"],
      [new Response("<html>", { status: 200 }), "response is not JSON"],
      [ok({ rebuilt: 1 }), "unexpected response shape"],
      [step("same"), "cursor did not advance"],
    ];
    for (const [response, error] of cases) {
      const { fetchFn } = fakeFetch([response]);
      const summary = await rebuildAll({
        baseUrl: "http://x",
        token: TOKEN,
        after: "same",
        fetch: fetchFn,
      });
      expect(summary.error, error).toBe(error);
    }
  });
});

describe("run", () => {
  it("すべて成功すれば 0 で、token を出力に含めない", async () => {
    const { io, out, calls } = fakeIo([step("a"), step(null)], { WIKI_TOKEN: TOKEN });
    expect(await run([], io)).toBe(0);
    expect(calls[0]?.url).toBe("http://localhost:8787/api/admin/derived/rebuild");
    expect(out.stderr).toContain("rebuilt 2");
    expect(out.stderr).not.toContain(TOKEN);
  });

  it("--remote は deploy.env のホスト名に送る", async () => {
    const { io, calls } = fakeIo([step(null)], { WIKI_TOKEN: TOKEN });
    expect(await run(["--remote"], io)).toBe(0);
    expect(calls[0]?.url).toBe("https://wiki.example.com/api/admin/derived/rebuild");
  });

  it("failed があれば id を標準エラーに出して 1 にする", async () => {
    const { io, out } = fakeIo([step("a", { rebuilt: 0, failed: ["BAD1"] }), step(null)], {
      WIKI_TOKEN: TOKEN,
    });
    expect(await run([], io)).toBe(1);
    expect(out.stderr).toContain("failed 1");
    expect(out.stderr).toContain("  BAD1\n");
  });

  it("途中で止まったら再開の引数を示して 1 にする", async () => {
    const { io, out } = fakeIo([step("a"), new Error("offline")], { WIKI_TOKEN: TOKEN });
    expect(await run([], io)).toBe(1);
    expect(out.stderr).toContain("resume with: --after a");
  });

  it("WIKI_TOKEN が無ければ、要求を送らずに 1 にする", async () => {
    for (const token of [undefined, "", "  "]) {
      const { io, out, calls } = fakeIo([], { WIKI_TOKEN: token });
      expect(await run([], io)).toBe(1);
      expect(out.stderr).toContain("WIKI_TOKEN");
      expect(calls).toHaveLength(0);
    }
  });

  it("deploy.env が無い・不正なら 1 にする", async () => {
    const { io, out } = fakeIo([], { WIKI_TOKEN: TOKEN });
    io.readDeployEnv = () => {
      throw new Error("ENOENT");
    };
    expect(await run(["--remote"], io)).toBe(1);
    expect(out.stderr).toContain("deploy.env not found");
    io.readDeployEnv = () => "";
    expect(await run(["--remote"], io)).toBe(1);
    expect(out.stderr).toContain("deploy.env:");
  });
});
