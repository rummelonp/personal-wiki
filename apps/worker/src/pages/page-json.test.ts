import { INITIAL_PAGE_ELEMENT_ID } from "@personal-wiki/domain";
import { describe, expect, it } from "vitest";
import { type PageMeta, rewritePageHtml } from "../page-html";
import { pageJson } from "./page-json";

/*
 * `/api/pages/:id` の応答と HTML の初回の表示用の JSON は、どちらも pageJson で作る。
 * ここでは pageJson が項目を名前で取り出すことと、HTML 側が pageJson と同じ値になることを確かめる。
 * 実際の API の応答と HTML の JSON がそろうことは page-html.test.ts が匿名と owner の両方で確かめる。
 */

const BODY = "# 見出し\n\n本文";

const META: PageMeta = {
  id: "0123456789abcdef0123456789abcdef",
  title: "Shared Note",
  visibility: "public",
  excerpt: "抜粋は応答の項目ではない",
  body: BODY,
  version: 3,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
};

const INDEX_HTML =
  '<!doctype html><html><head><title>wiki</title></head><body><div id="root"></div></body></html>';

async function initialJsonOf(page: PageMeta): Promise<unknown> {
  const res = rewritePageHtml(new Response(INDEX_HTML), page, "http://localhost", []);
  const html = await res.text();
  const pattern = new RegExp(
    `<script type="application/json" id="${INITIAL_PAGE_ELEMENT_ID}">([\\s\\S]*?)</script>`,
  );
  const text = pattern.exec(html)?.[1];
  return text === undefined ? null : JSON.parse(text);
}

describe("pageJson", () => {
  it("Page の項目だけを返し、広い値を渡されても余分な項目を含めない", () => {
    const json = pageJson({ ...META, body: BODY });
    expect(Object.keys(json).sort()).toEqual([
      "body",
      "createdAt",
      "id",
      "title",
      "updatedAt",
      "version",
      "visibility",
    ]);
  });

  it("HTML に入れる JSON は pageJson と同じ項目と値で、抜粋を含めない", async () => {
    expect(await initialJsonOf(META)).toEqual(pageJson({ ...META, body: BODY }));
  });

  it("本文を持つ draft のページにも JSON を入れない", async () => {
    expect(await initialJsonOf({ ...META, visibility: "draft" })).toBeNull();
  });
});
