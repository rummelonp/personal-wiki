import { afterEach, describe, expect, it } from "vitest";
import { expectTaggedRows, forgetEntryShape, rememberEntryShape } from "./entry-shape";

const row = (tags: string[]) => ({ tags });

afterEach(forgetEntryShape);

describe("entry-shape", () => {
  it("一覧を受け取るまでは、タグの無い行を想定する", () => {
    expect(expectTaggedRows()).toBe(false);
  });

  it("タグの有る行が多ければ、タグの有る行を想定する", () => {
    rememberEntryShape([row(["a"]), row(["a", "b"]), row([])]);
    expect(expectTaggedRows()).toBe(true);
  });

  it("タグの無い行が多いか同数なら、タグの無い行を想定する", () => {
    rememberEntryShape([row(["a"]), row([]), row([])]);
    expect(expectTaggedRows()).toBe(false);
    rememberEntryShape([row(["a"]), row([])]);
    expect(expectTaggedRows()).toBe(false);
  });

  it("新しく受け取った一覧で上書きする", () => {
    rememberEntryShape([row(["a"])]);
    rememberEntryShape([row([])]);
    expect(expectTaggedRows()).toBe(false);
  });

  it("空の一覧は覚えているものを変えない", () => {
    rememberEntryShape([row(["a"])]);
    rememberEntryShape([]);
    expect(expectTaggedRows()).toBe(true);
  });
});
