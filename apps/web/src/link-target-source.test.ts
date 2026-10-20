import { describe, expect, it, vi } from "vitest";
import { createLinkTargetSource, type FindPageByTitle } from "./link-target-source";
import type { ApiResult, Page } from "./pages-api";

const page = (body: string): Page => ({
  id: "A",
  title: "Note",
  body,
  visibility: "draft",
  version: 1,
  createdAt: 0,
  updatedAt: 0,
});

const signal = () => new AbortController().signal;

describe("createLinkTargetSource", () => {
  it("リンク先の本文から見出しと block id を取り出す", async () => {
    const find = vi.fn<FindPageByTitle>(async () => ({
      ok: true,
      value: page("# 概要\n\n段落 ^intro"),
    }));
    const source = createLinkTargetSource(find);
    expect(await source.load("Note", signal())).toEqual({
      headings: ["概要"],
      blocks: [{ id: "intro", preview: "段落" }],
    });
  });

  it("取れた分はキャッシュしておき、同じ title（表記ゆれを含む）では取りに行かない", async () => {
    const find = vi.fn<FindPageByTitle>(async () => ({ ok: true, value: page("# 概要") }));
    const source = createLinkTargetSource(find);
    await source.load("Note", signal());
    await source.load("ｎｏｔｅ", signal());
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("ページが無いとき、通信に失敗したとき、例外が出たときは null を返し、reject しない", async () => {
    const results: (() => Promise<ApiResult<Page>>)[] = [
      async () => ({ ok: false, reason: "not_found" }),
      async () => ({ ok: false, reason: "error", message: "サーバーに接続できない" }),
      async () => {
        throw new Error("abort");
      },
    ];
    const find = vi.fn<FindPageByTitle>(() =>
      (results.shift() as () => Promise<ApiResult<Page>>)(),
    );
    const source = createLinkTargetSource(find);
    await expect(source.load("Note", signal())).resolves.toBeNull();
    await expect(source.load("Note", signal())).resolves.toBeNull();
    await expect(source.load("Note", signal())).resolves.toBeNull();
    // 失敗はキャッシュしないので、次はまた取りに行く
    expect(find).toHaveBeenCalledTimes(3);
  });

  it("中断の signal を取得に渡す", async () => {
    const find = vi.fn<FindPageByTitle>(async () => ({ ok: false, reason: "not_found" }));
    const controller = new AbortController();
    await createLinkTargetSource(find).load("Note", controller.signal);
    expect(find).toHaveBeenCalledWith("Note", controller.signal);
  });
});
