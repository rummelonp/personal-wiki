import { describe, expect, it } from "vitest";
import { extractOutline } from "./heading-outline";

describe("extractOutline", () => {
  it("ATX 見出しを、レベルと行頭の位置つきで拾う", () => {
    const body = "# 一\n本文\n## 二 ##\n";
    expect(extractOutline(body)).toEqual([
      { level: 1, text: "一", offset: 0 },
      { level: 2, text: "二", offset: body.indexOf("## 二") },
    ]);
  });

  it("コードブロックの中の # は見出しにしない", () => {
    const body = "```md\n# 例\n```\n~~~\n# 例\n~~~\n# 本物";
    expect(extractOutline(body).map((item) => item.text)).toEqual(["本物"]);
  });

  it("長い囲みの中の短い囲みでは閉じない", () => {
    const body = "````\n```\n# 例\n````\n# 外";
    expect(extractOutline(body).map((item) => item.text)).toEqual(["外"]);
  });

  it("先頭の frontmatter を飛ばす", () => {
    const body = "---\n# yaml のコメント\n---\n# 題";
    expect(extractOutline(body).map((item) => item.text)).toEqual(["題"]);
  });

  it("# の後に空白が無い行や、空の見出しは拾わない", () => {
    expect(extractOutline("#タグ\n#\n# \n#### ok")).toEqual([
      { level: 4, text: "ok", offset: "#タグ\n#\n# \n".length },
    ]);
  });
});
