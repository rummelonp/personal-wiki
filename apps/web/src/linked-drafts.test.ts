import { describe, expect, it, vi } from "vitest";
import { findLinkedDrafts } from "./linked-drafts";
import { RESOLVE_MAX_TITLES, type ResolvedPage } from "./pages-api";

function resolverOf(pages: ResolvedPage[]) {
  return vi.fn(async (titles: string[]) => ({
    ok: true as const,
    value: titles.map((title) => pages.find((page) => page.title === title) ?? null),
  }));
}

describe("findLinkedDrafts", () => {
  it("本文の link と page embed のうち、draft のものを本文の順に、重複を畳んで返す", async () => {
    const resolve = resolverOf([
      { id: "d1", title: "計画", visibility: "draft" },
      { id: "d2", title: "メモ", visibility: "draft" },
      { id: "p1", title: "公開", visibility: "public" },
    ]);
    const body =
      "[[メモ#見出し|見出し]] と [[公開]] と ![[計画]] と [[無い]] と [[メモ]] ![[画像.png]]";
    const found = await findLinkedDrafts(body, { selfId: "self", resolve });
    expect(found).toEqual({
      ok: true,
      value: [
        { id: "d2", title: "メモ" },
        { id: "d1", title: "計画" },
      ],
    });
    // 添付の embed は page ではないので問い合わせない
    expect(resolve.mock.calls.flatMap(([titles]) => titles)).not.toContain("画像.png");
  });

  it("自分への link は、公開すれば draft でなくなるので数えない", async () => {
    const resolve = resolverOf([{ id: "self", title: "自分", visibility: "draft" }]);
    expect(await findLinkedDrafts("[[自分]]", { selfId: "self", resolve })).toEqual({
      ok: true,
      value: [],
    });
  });

  it("link が無ければ問い合わせない", async () => {
    const resolve = resolverOf([]);
    expect(await findLinkedDrafts("本文だけ", { selfId: "self", resolve })).toEqual({
      ok: true,
      value: [],
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("1 回に収まらない数の link は分けて問い合わせ、まとめて返す", async () => {
    const pages: ResolvedPage[] = Array.from({ length: RESOLVE_MAX_TITLES + 1 }, (_, i) => ({
      id: `d${i}`,
      title: `下書き${i}`,
      visibility: "draft",
    }));
    const resolve = resolverOf(pages);
    const body = pages.map((page) => `[[${page.title}]]`).join(" ");
    const found = await findLinkedDrafts(body, { selfId: "self", resolve });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(found.ok && found.value.map((page) => page.id)).toEqual(pages.map((page) => page.id));
  });

  it("問い合わせが 1 つでも失敗したら、一部の一覧ではなく失敗を返す", async () => {
    const titles = Array.from({ length: RESOLVE_MAX_TITLES + 1 }, (_, i) => `t${i}`);
    let calls = 0;
    const resolve = vi.fn(async (batch: string[]) => {
      calls += 1;
      return calls === 1
        ? { ok: true as const, value: batch.map(() => null) }
        : { ok: false as const, reason: "error" as const, message: "" };
    });
    const found = await findLinkedDrafts(titles.map((t) => `[[${t}]]`).join(" "), {
      selfId: "self",
      resolve,
    });
    expect(found.ok).toBe(false);
  });
});
