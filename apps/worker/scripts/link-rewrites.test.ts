import { describe, expect, it } from "vitest";
import { MAX_CONSECUTIVE_CONFLICTS, parseArgs, run } from "./link-rewrites.mjs";

const TOKEN = "t".repeat(43);

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { targetPageId?: string };
}

function fakeIo(responses: (Response | Error)[], env: Record<string, string | undefined>) {
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
  const out = { stderr: "" };
  const io = {
    fetch: fetchFn as typeof fetch,
    env,
    stderr: { write: (chunk: string) => (out.stderr += chunk) },
    readDeployEnv: () =>
      "WIKI_HOSTNAME=wiki.example.com\nD1_DATABASE_ID=0b1c2d3e-0000-4000-8000-000000000000\n",
  };
  return { io, out, calls };
}

const step = (remaining: number, extra: object = {}) =>
  Response.json({
    processed: { sourcePageId: "s", title: "S", visibility: "draft", rewritten: 2 },
    conflict: false,
    failed: [],
    remaining,
    rowsWritten: 11,
    ...extra,
  });

describe("parseArgs", () => {
  it("既定はローカルで、--target で対象を絞る", () => {
    expect(parseArgs([])).toEqual({ remote: false, url: undefined, target: null });
    expect(parseArgs(["--remote", "--target", "abc"])).toEqual({
      remote: true,
      url: undefined,
      target: "abc",
    });
  });

  it("未知の引数、値の無い --target、--remote と --url の併用を拒否する", () => {
    expect(() => parseArgs(["--force"])).toThrow("unknown argument");
    expect(() => parseArgs(["--target"])).toThrow("--target needs a page id");
    expect(() => parseArgs(["--remote", "--url", "http://localhost:8787"])).toThrow(
      "cannot be combined",
    );
  });
});

describe("run", () => {
  it("remaining が 0 になるまで呼び、token は Authorization にだけ載せる", async () => {
    const { io, out, calls } = fakeIo([step(2), step(1), step(0)], { WIKI_TOKEN: TOKEN });
    expect(await run(["--target", "abc"], io)).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe("http://localhost:8787/api/link-rewrites/step");
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls.every((call) => call.body.targetPageId === "abc")).toBe(true);
    expect(out.stderr).toContain("rewrote 6 links in 3 pages, failed 0");
    expect(out.stderr).not.toContain(TOKEN);
  });

  it("キューに入ったジョブが無ければ 1 回で終える", async () => {
    const empty = Response.json({
      processed: null,
      conflict: false,
      failed: [],
      remaining: 0,
      rowsWritten: 0,
    });
    const { io, calls } = fakeIo([empty], { WIKI_TOKEN: TOKEN });
    expect(await run(["--remote"], io)).toBe(0);
    expect(calls[0]?.url).toBe("https://wiki.example.com/api/link-rewrites/step");
    expect(calls[0]?.body).toEqual({});
  });

  it("failed のページを出して終了コード 1 にする", async () => {
    const { io, out } = fakeIo([step(0, { processed: null, failed: ["bad"] })], {
      WIKI_TOKEN: TOKEN,
    });
    expect(await run([], io)).toBe(1);
    expect(out.stderr).toContain("  bad\n");
  });

  it("版の競合が続いたら止める", async () => {
    const conflicts = Array.from({ length: MAX_CONSECUTIVE_CONFLICTS }, () =>
      step(1, { processed: null, conflict: true }),
    );
    const { io, out, calls } = fakeIo(conflicts, { WIKI_TOKEN: TOKEN });
    expect(await run([], io)).toBe(1);
    expect(calls).toHaveLength(MAX_CONSECUTIVE_CONFLICTS);
    expect(out.stderr).toContain("version conflicts");
  });

  it("サーバーのエラーと想定外のレスポンスで止め、残りの数を出す", async () => {
    const failing = fakeIo([step(3), Response.json({ error: "forbidden" }, { status: 403 })], {
      WIKI_TOKEN: TOKEN,
    });
    expect(await run([], failing.io)).toBe(1);
    expect(failing.out.stderr).toContain("server returned 403 (forbidden) (3 pages left)");

    const odd = fakeIo([Response.json({ next: null })], { WIKI_TOKEN: TOKEN });
    expect(await run([], odd.io)).toBe(1);
    expect(odd.out.stderr).toContain("unexpected response shape");
  });

  it("WIKI_TOKEN が無ければ呼ばない", async () => {
    const { io, calls } = fakeIo([], {});
    expect(await run([], io)).toBe(1);
    expect(calls).toHaveLength(0);
  });
});
