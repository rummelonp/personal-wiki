import { describe, expect, it } from "vitest";
import { canChangeVisibility, shownInputProblems } from "./page-editor-state";
import type { Page } from "./pages-api";

const BASE: Page = {
  id: "p1",
  title: "メモ",
  body: "本文",
  visibility: "draft",
  version: 1,
  createdAt: 0,
  updatedAt: 0,
};

describe("canChangeVisibility", () => {
  it("保存中も押せ、ほかの操作の途中は押せない", () => {
    expect(canChangeVisibility({ busy: null }, "saved")).toBe(true);
    expect(canChangeVisibility({ busy: "saving" }, "saving")).toBe(true);
    expect(canChangeVisibility({ busy: "visibility" }, "saved")).toBe(false);
    expect(canChangeVisibility({ busy: "deleting" }, "saved")).toBe(false);
  });

  it("保存済み、未保存、保存中のほかの状態では押せない", () => {
    expect(canChangeVisibility({ busy: null }, "unsaved")).toBe(true);
    for (const status of ["error", "conflict", "invalid", "auth", "gone", "kept"] as const)
      expect(canChangeVisibility({ busy: null }, status)).toBe(false);
  });
});

describe("shownInputProblems", () => {
  const nul = "本文\u0000";

  it("保存済みのままの内容の問題は知らせない", () => {
    const base = { ...BASE, body: nul };
    expect(shownInputProblems({ uncreated: false, base, draft: base })).toEqual([]);
  });

  it("手を付けた内容の問題を知らせる", () => {
    const problems = shownInputProblems({
      uncreated: false,
      base: BASE,
      draft: { title: BASE.title, body: nul },
    });
    expect(problems.map((problem) => problem.reason)).toEqual(["control_char"]);
  });

  it("作る前のページは、変更が無くても問題を知らせ、まだ打っていない空の title は数えない", () => {
    const base = { ...BASE, title: "", body: "" };
    expect(
      shownInputProblems({ uncreated: true, base, draft: { title: "", body: nul } }).map(
        (problem) => problem.reason,
      ),
    ).toEqual(["control_char"]);
    expect(shownInputProblems({ uncreated: true, base, draft: { title: "", body: "" } })).toEqual(
      [],
    );
  });
});
