import { describe, expect, it } from "vitest";
import { rebaseOnLinkRewrite, renamesBetween } from "./link-rewrite-body";

describe("renamesBetween と rebaseOnLinkRewrite", () => {
  it("リンクの target の書き換えだけなら、旧 key から新しい title への対応を返す", () => {
    expect(renamesBetween("x [[旧]] y [[別]]", "x [[新]] y [[別]]")).toEqual(
      new Map([["旧", "新"]]),
    );
  });

  it("リンク以外の変化が混ざっていれば null", () => {
    expect(renamesBetween("x [[旧]]", "x! [[新]]")).toBeNull();
    expect(renamesBetween("[[旧]]", "[[旧]]")).toBeNull();
  });

  it("手元の未保存の編集に、サーバーの書き換えを重ねる。後から打った旧 title も書き換える", () => {
    const base = "[[旧]] 本文";
    const server = "[[新]] 本文";
    expect(rebaseOnLinkRewrite(base, server, "[[旧]] 本文 追記 [[旧]]")).toBe(
      "[[新]] 本文 追記 [[新]]",
    );
    expect(rebaseOnLinkRewrite(base, server, base)).toBe(server);
  });

  it("手元の表記ゆれ（大文字小文字）のリンクも同じ key として書き換える", () => {
    expect(rebaseOnLinkRewrite("[[abc]]", "[[Xyz]]", "[[abc]] [[ABC]]")).toBe("[[Xyz]] [[Xyz]]");
  });

  it("手元に重ねると他のリンクやタグが変わるなら null", () => {
    // 新しい title の ` が手元で足した ` と組んでインラインコードになり、リンクが消える
    expect(rebaseOnLinkRewrite("[[Old]]", "[[Ne`w]]", "a ` b [[Old]] c")).toBeNull();
  });

  it("書き換えで説明できない変化なら null", () => {
    expect(rebaseOnLinkRewrite("[[旧]] 本文", "[[旧]] 他の編集", "[[旧]] 手元")).toBeNull();
  });
});
