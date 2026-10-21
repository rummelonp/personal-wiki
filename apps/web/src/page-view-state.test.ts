import { afterEach, describe, expect, it } from "vitest";
import { forgetTitles, rememberTitle } from "./page-titles";
import { loadingTitleOf, loadStateFrom, targetKeyOf } from "./page-view-state";
import { LOAD_FAILED, type Page } from "./pages-api";

afterEach(forgetTitles);

describe("loadStateFrom", () => {
  it("成功はそのページで ready にする", () => {
    const page = { id: "p1" } as Page;
    expect(loadStateFrom({ ok: true, value: page })).toEqual({ status: "ready", page });
  });

  it("not_found は被リンクの取得が済んでいない not_found にする", () => {
    expect(loadStateFrom({ ok: false, reason: "not_found" })).toEqual({
      status: "not_found",
      settled: false,
    });
  });

  it("unauthorized は unauthorized にする", () => {
    expect(loadStateFrom({ ok: false, reason: "unauthorized" })).toEqual({
      status: "unauthorized",
    });
  });

  it("message を持たない失敗は、読み込みの失敗の汎用の文で error にする", () => {
    expect(loadStateFrom({ ok: false, reason: "version_conflict", currentVersion: null })).toEqual({
      status: "error",
      message: LOAD_FAILED,
    });
  });

  it("それ以外の失敗は error にし、message をそのまま使う", () => {
    expect(loadStateFrom({ ok: false, reason: "error", message: "サーバーのエラー" })).toEqual({
      status: "error",
      message: "サーバーのエラー",
    });
  });
});

describe("targetKeyOf", () => {
  it("取得の単位ごとに違う文字列にする。new は title でなく serial で区別する", () => {
    expect(targetKeyOf({ by: "id", id: "a" })).toBe("id:a");
    expect(targetKeyOf({ by: "title", title: "A" })).toBe("title:A");
    expect(targetKeyOf({ by: "new", serial: 2, title: "A" })).toBe("new:2");
    expect(targetKeyOf({ by: "new", serial: 2, title: "B" })).toBe(
      targetKeyOf({ by: "new", serial: 2, title: "A" }),
    );
  });
});

describe("loadingTitleOf", () => {
  it("id は覚えた title、title は URL から読み替えた title、new は無し", () => {
    rememberTitle("id-1", "My Note");
    expect(loadingTitleOf({ by: "id", id: "id-1" })).toBe("My Note");
    expect(loadingTitleOf({ by: "id", id: "unknown" })).toBeUndefined();
    expect(loadingTitleOf({ by: "title", title: "Other_Note" })).toBe("Other Note");
    expect(loadingTitleOf({ by: "new", serial: 1, title: "x" })).toBeUndefined();
  });
});
