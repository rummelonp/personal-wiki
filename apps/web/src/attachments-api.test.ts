import { describe, expect, it, vi } from "vitest";
import { uploadAttachment } from "./attachments-api";

const png = () => new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
const NAME = `${"N".repeat(22)}.png`;

describe("uploadAttachment", () => {
  it("File の生のバイト列を種類つきで POST し、201 の name と size を返す", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ name: NAME, contentType: "image/png", size: 3 }, { status: 201 }),
    );
    const file = png();
    const result = await uploadAttachment(file, fetchFn);
    expect(result).toEqual({
      ok: true,
      value: { name: NAME, contentType: "image/png", size: 3 },
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/attachments");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "image/png" },
    });
    expect(init.body).toBe(file);
  });

  it("201 でも、サーバーが振る名前の形でない name は error にする", async () => {
    for (const name of ["photo.png", "uploading.1-0.png", `${"N".repeat(22)}.svg`, ""]) {
      const result = await uploadAttachment(png(), async () =>
        Response.json({ name, contentType: "image/png", size: 3 }, { status: 201 }),
      );
      expect(result).toEqual({ ok: false, kind: "error" });
    }
  });

  it("201 でも形の合わない応答は error にする", async () => {
    const result = await uploadAttachment(png(), async () =>
      Response.json({ name: 1 }, { status: 201 }),
    );
    expect(result).toEqual({ ok: false, kind: "error" });
  });

  it.each([
    [401, { error: "unauthorized" }, "unauthorized"],
    [413, { error: "payload_too_large" }, "too_large"],
    [415, { error: "unsupported_media_type" }, "unsupported_type"],
    [503, { error: "attachments_unavailable" }, "unavailable"],
    [503, { error: "something_else" }, "error"],
    [403, { error: "forbidden" }, "forbidden"],
    [411, { error: "length_required" }, "error"],
    [500, { error: "internal" }, "error"],
  ])("%i %j は %s", async (status, body, kind) => {
    const result = await uploadAttachment(png(), async () => Response.json(body, { status }));
    expect(result).toEqual({ ok: false, kind });
  });

  it("本文が JSON でない 503 は error にする", async () => {
    const result = await uploadAttachment(png(), async () => new Response("down", { status: 503 }));
    expect(result).toEqual({ ok: false, kind: "error" });
  });

  it("通信の失敗は error にする", async () => {
    const result = await uploadAttachment(png(), async () => {
      throw new TypeError("offline");
    });
    expect(result).toEqual({ ok: false, kind: "error" });
  });
});
