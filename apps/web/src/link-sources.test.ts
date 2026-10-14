import { describe, expect, it, vi } from "vitest";
import {
  createLinkTargetSource,
  createTitleIndex,
  type FindPageByTitle,
  type ListTitles,
  TITLE_INDEX_MAX_REQUESTS,
} from "./link-sources";
import type { ApiResult, Page, PageList, PageSummary } from "./pages-api";

const summary = (id: string, title: string): PageSummary => ({
  id,
  title,
  visibility: "draft",
  updatedAt: 0,
});

const listOk = (pages: PageSummary[], nextCursor: string | null = null) =>
  ({ ok: true, value: { pages, nextCursor } }) as ApiResult<PageList<PageSummary>>;

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

describe("createTitleIndex", () => {
  it("一覧の title を、title_key と同じ規則で引ける候補にする", async () => {
    const index = createTitleIndex(async () =>
      listOk([summary("1", "Ｎｏｔｅ"), summary("2", "日記")]),
    );
    expect(index.search("note")).toEqual([]);
    await index.refresh();
    expect(index.search("note")).toEqual([{ id: "1", title: "Ｎｏｔｅ" }]);
  });

  it("cursor を辿り、上限の回数で止める", async () => {
    const list = vi.fn<ListTitles>(async (cursor) =>
      listOk([summary(cursor ?? "0", `p${cursor ?? "0"}`)], `${Number(cursor ?? 0) + 1}`),
    );
    const index = createTitleIndex(list);
    await index.refresh();
    expect(list).toHaveBeenCalledTimes(TITLE_INDEX_MAX_REQUESTS);
    expect(list.mock.calls.map(([cursor]) => cursor)).toEqual([null, "1", "2", "3"]);
    // 途中のページの分も積み上げて持つ
    expect(index.search("p0")).toContainEqual({ id: "0", title: "p0" });
    expect(index.search("p3")).toContainEqual({ id: "3", title: "p3" });
  });

  it("maxRequests で回数の上限を変えられ、続きがあってもそこで止める", async () => {
    const list = vi.fn<ListTitles>(async () => listOk([summary("0", "p0")], "next"));
    const index = createTitleIndex(list, { maxRequests: 1 });
    await index.refresh();
    expect(list).toHaveBeenCalledTimes(1);
    expect(index.search("p0")).toEqual([{ id: "0", title: "p0" }]);
  });

  it("1 回目で失敗したら前の候補を残し、reject しない", async () => {
    let fail = false;
    const index = createTitleIndex(async () => {
      if (fail) throw new Error("network");
      return listOk([summary("1", "Note")]);
    });
    await index.refresh();
    fail = true;
    await expect(index.refresh()).resolves.toBeUndefined();
    expect(index.search("Note")).toHaveLength(1);
  });

  it("途中で失敗したら、取れた分までを候補にする", async () => {
    const responses: (() => Promise<ApiResult<PageList<PageSummary>>>)[] = [
      async () => listOk([summary("1", "一枚目")], "c1"),
      async () => listOk([summary("2", "二枚目")], "c2"),
      async () => ({ ok: false, reason: "error", message: "サーバーに接続できない" }),
    ];
    const list = vi.fn<ListTitles>(() => (responses.shift() as () => Promise<never>)());
    const index = createTitleIndex(list);
    await expect(index.refresh()).resolves.toBeUndefined();
    expect(list).toHaveBeenCalledTimes(3);
    expect(index.search("一枚目")).toContainEqual({ id: "1", title: "一枚目" });
    expect(index.search("二枚目")).toContainEqual({ id: "2", title: "二枚目" });
  });

  it("遅れて終わった古い取り直しで上書きしない", async () => {
    let release: (() => void) | undefined;
    const responses = [
      () =>
        new Promise<ApiResult<PageList<PageSummary>>>((resolve) => {
          release = () => resolve(listOk([summary("old", "古い")]));
        }),
      async () => listOk([summary("new", "新しい")]),
    ];
    const index = createTitleIndex(() => (responses.shift() ?? responses[0])?.() as never);
    const first = index.refresh();
    await index.refresh();
    release?.();
    await first;
    expect(index.search("新しい")).toHaveLength(1);
    expect(index.search("古い")).toEqual([]);
  });
});

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

  it("取れた分は覚えておき、同じ title（表記ゆれを含む）では取りに行かない", async () => {
    const find = vi.fn<FindPageByTitle>(async () => ({ ok: true, value: page("# 概要") }));
    const source = createLinkTargetSource(find);
    await source.load("Note", signal());
    await source.load("ｎｏｔｅ", signal());
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("ページが無い・通信に失敗した・例外が出たときは null を返し、reject しない", async () => {
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
    // 失敗は覚えないので、次はまた取りに行く
    expect(find).toHaveBeenCalledTimes(3);
  });

  it("中断の signal を取得に渡す", async () => {
    const find = vi.fn<FindPageByTitle>(async () => ({ ok: false, reason: "not_found" }));
    const controller = new AbortController();
    await createLinkTargetSource(find).load("Note", controller.signal);
    expect(find).toHaveBeenCalledWith("Note", controller.signal);
  });
});
