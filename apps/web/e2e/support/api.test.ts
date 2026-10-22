import { describe, expect, it } from "vitest";
import { type ApiPage, ownerApi } from "./api";

const LOST = () => new Response("Network connection lost.", { status: 500 });
const json = (value: unknown, status = 200) => Response.json(value, { status });

function page(overrides: Partial<ApiPage> = {}): ApiPage {
  return { id: "p1", title: "T", body: "B", visibility: "draft", version: 1, ...overrides };
}

/** 応答を順に返し、呼ばれた method と path を残す fetch。 */
function scripted(responses: Array<() => Response>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    const next = responses.shift();
    if (next === undefined) throw new Error("想定より多く呼ばれた");
    return next();
  }) as typeof fetch;
  return { calls, api: ownerApi("http://localhost:1", "secret", fetchImpl) };
}

describe("ownerApi の送り直し", () => {
  it("Network connection lost. の 500 は送り直し、成功した応答を返す", async () => {
    const { api, calls } = scripted([LOST, () => json(page({ version: 2 }))]);
    await expect(api.updatePage(page(), { body: "B" })).resolves.toMatchObject({ version: 2 });
    expect(calls).toEqual(["PUT /api/pages/p1", "PUT /api/pages/p1"]);
  });

  it("先頭の行が接続切れの例外の stack の 500 も送り直す", async () => {
    const stack = () =>
      new Response("Error: Network connection lost.\n    at entry.worker.js:1:1", { status: 500 });
    const { api, calls } = scripted([stack, () => json(page())]);
    await expect(api.getPage("p1")).resolves.toEqual(page());
    expect(calls).toHaveLength(2);
  });

  it("ほかの 500 は送り直さない", async () => {
    const { api, calls } = scripted([() => new Response("boom", { status: 500 })]);
    await expect(api.createPage({ title: "T", body: "B" })).rejects.toThrow("500 boom");
    expect(calls).toEqual(["POST /api/pages"]);
  });

  it("上限の回数を送って失敗する", async () => {
    const { api, calls } = scripted([LOST, LOST, LOST]);
    await expect(api.getPage("p1")).rejects.toThrow("500 Network connection lost.");
    expect(calls).toHaveLength(3);
  });

  it("最初の送信が効いていた PUT は、版が 1 つ進んで中身が同じなら成功にする", async () => {
    const applied = page({ body: "new", version: 2 });
    const { api, calls } = scripted([
      LOST,
      () => json({ error: "version_conflict", currentVersion: 2 }, 409),
      () => json(applied),
    ]);
    await expect(api.updatePage(page(), { body: "new" })).resolves.toEqual(applied);
    expect(calls).toEqual(["PUT /api/pages/p1", "PUT /api/pages/p1", "GET /api/pages/p1"]);
  });

  it("別の更新による PUT の version_conflict は失敗のままにする", async () => {
    const { api } = scripted([
      LOST,
      () => json({ error: "version_conflict", currentVersion: 2 }, 409),
      () => json(page({ body: "other", version: 2 })),
    ]);
    await expect(api.updatePage(page(), { body: "new" })).rejects.toThrow("409");
  });

  it("送り直した PUT の後に版が 2 つ以上進んでいたら、中身が同じでも失敗にする", async () => {
    const { api } = scripted([
      LOST,
      () => json({ error: "version_conflict", currentVersion: 3 }, 409),
      () => json(page({ body: "new", version: 3 })),
    ]);
    await expect(api.updatePage(page(), { body: "new" })).rejects.toThrow("409");
  });

  it("送り直していない PUT の version_conflict は確かめずに失敗にする", async () => {
    const { api, calls } = scripted([
      () => json({ error: "version_conflict", currentVersion: 2 }, 409),
    ]);
    await expect(api.updatePage(page(), { body: "new" })).rejects.toThrow("409");
    expect(calls).toHaveLength(1);
  });

  it("最初の送信が効いていた POST は、同じ本文の版 1 が既にあれば成功にする", async () => {
    const created = page({ id: "p2" });
    const { api, calls } = scripted([
      LOST,
      () => json({ error: "title_conflict", existing: { id: "p2" } }, 409),
      () => json(created),
    ]);
    await expect(api.createPage({ title: "T", body: "B" })).resolves.toEqual(created);
    expect(calls).toEqual(["POST /api/pages", "POST /api/pages", "GET /api/pages/p2"]);
  });

  it.each([
    ["本文が違う", page({ id: "p2", body: "other" })],
    ["版が 2 以上の", page({ id: "p2", version: 2 })],
    ["public の", page({ id: "p2", visibility: "public" })],
  ] as const)("%s既存のページとの title_conflict は失敗のままにする", async (_, existing) => {
    const { api } = scripted([
      LOST,
      () => json({ error: "title_conflict", existing: { id: "p2" } }, 409),
      () => json(existing),
    ]);
    await expect(api.createPage({ title: "T", body: "B" })).rejects.toThrow("409");
  });
});
