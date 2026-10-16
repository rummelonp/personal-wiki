import { describe, expect, it, vi } from "vitest";
import { stepLinkRewrites } from "./link-rewrites-api";

const STEP = {
  processed: { sourcePageId: "p1", title: "元", visibility: "public", version: 3, rewritten: 2 },
  conflict: false,
  failed: [],
  remaining: 1,
  rowsWritten: 5,
};

describe("stepLinkRewrites", () => {
  it("JSON の空の object を POST し、応答を返す", async () => {
    const fetchFn = vi.fn(async () => Response.json(STEP));
    const result = await stepLinkRewrites(fetchFn);
    expect(result).toEqual({
      ok: true,
      value: {
        processed: STEP.processed,
        conflict: false,
        failed: [],
        remaining: 1,
      },
    });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/link-rewrites/step");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  });

  it("processed が null の応答も受ける", async () => {
    const result = await stepLinkRewrites(async () =>
      Response.json({ ...STEP, processed: null, remaining: 0 }),
    );
    expect(result).toMatchObject({ ok: true, value: { processed: null, remaining: 0 } });
  });

  it("書き換えられなかったリンク元は failedPages の id と title で返す", async () => {
    const result = await stepLinkRewrites(async () =>
      Response.json({
        ...STEP,
        failed: ["x", "y"],
        failedPages: [
          { id: "x", title: "前の題" },
          { id: "y", title: null },
        ],
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        failed: [
          { id: "x", title: "前の題" },
          { id: "y", title: null },
        ],
      },
    });
  });

  it("failedPages の無い前の版の Worker の応答では、failed の id だけで返す", async () => {
    const result = await stepLinkRewrites(async () => Response.json({ ...STEP, failed: ["x"] }));
    expect(result).toMatchObject({ ok: true, value: { failed: [{ id: "x", title: undefined }] } });
  });

  it("形の合わない応答は error にする", async () => {
    for (const body of [
      { ...STEP, remaining: "1" },
      { ...STEP, failed: [1] },
      { ...STEP, failed: ["x"], failedPages: [{ id: "x" }] },
      { ...STEP, failed: ["x"], failedPages: "x" },
      { ...STEP, processed: { sourcePageId: "p1" } },
      null,
    ]) {
      expect(await stepLinkRewrites(async () => Response.json(body))).toEqual({
        ok: false,
        kind: "error",
      });
    }
  });

  it("status で失敗を分け、通信の失敗は error にする", async () => {
    const cases = [
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not_found"],
      [500, "error"],
    ] as const;
    for (const [status, kind] of cases) {
      const result = await stepLinkRewrites(async () => new Response(null, { status }));
      expect(result).toEqual({ ok: false, kind });
    }
    const offline = await stepLinkRewrites(async () => {
      throw new TypeError("offline");
    });
    expect(offline).toEqual({ ok: false, kind: "error" });
  });
});
