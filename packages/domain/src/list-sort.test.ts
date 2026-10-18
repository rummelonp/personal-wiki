import { describe, expect, it } from "vitest";
import { DEFAULT_LIST_SORT, isListSort, LIST_SORTS } from "./list-sort";

describe("isListSort", () => {
  it("並びの値だけを通す", () => {
    for (const sort of LIST_SORTS) expect(isListSort(sort)).toBe(true);
    expect(LIST_SORTS).toEqual(["updated", "created", "title"]);
  });

  it("知らない値、大文字違い、文字列でない値、Object.prototype の名前を弾く", () => {
    for (const bad of ["", "popular", "Updated", "toString", "__proto__", null, undefined, 1, {}]) {
      expect(isListSort(bad), String(bad)).toBe(false);
    }
  });

  it("既定の並びは更新日時", () => {
    expect(DEFAULT_LIST_SORT).toBe("updated");
    expect(isListSort(DEFAULT_LIST_SORT)).toBe(true);
  });
});
