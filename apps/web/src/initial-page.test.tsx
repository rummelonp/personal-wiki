import { afterEach, describe, expect, it } from "vitest";
import { discardInitialPage, initialPageFor, readInitialPage } from "./initial-page";
import type { Page } from "./pages-api";
import { navigate, parseRoute } from "./route";

const PAGE: Page = {
  id: "AAAAAAAAAAAAAAAAAAAAAA",
  title: "Open Note",
  body: "本文",
  visibility: "public",
  version: 3,
  createdAt: 1,
  updatedAt: 2,
};

const startUrl = location.href;

/** Worker が head に入れるのと同じ要素を置く。 */
function embed(text: string): HTMLScriptElement {
  const script = document.createElement("script");
  script.type = "application/json";
  script.id = "initial-page";
  script.textContent = text;
  document.head.append(script);
  return script;
}

afterEach(() => {
  discardInitialPage();
  document.getElementById("initial-page")?.remove();
  history.replaceState(null, "", startUrl);
});

describe("initialPageFor", () => {
  it("HTML に入っていたページを、id でも title の URL でも同じページに返し、要素を取り除く", () => {
    history.replaceState(null, "", `/p/${PAGE.id}`);
    const script = embed(JSON.stringify(PAGE));
    readInitialPage("navigate");
    expect(script.isConnected).toBe(false);
    expect(initialPageFor({ by: "id", id: PAGE.id })).toEqual(PAGE);
    // Worker と同じく title_key で比べる（大文字小文字と `_`）
    for (const path of ["/Open_Note", "/open%20note"]) {
      const route = parseRoute(path, "");
      if (route.name !== "title") throw new Error(path);
      expect(initialPageFor({ by: "title", title: route.title }), path).toEqual(PAGE);
    }
  });

  it("再読み込みでも使い、何度呼んでも同じページを返す", () => {
    embed(JSON.stringify(PAGE));
    readInitialPage("reload");
    expect(initialPageFor({ by: "id", id: PAGE.id })).toEqual(PAGE);
    expect(initialPageFor({ by: "id", id: PAGE.id })).toEqual(PAGE);
  });

  it("別のページの id や title には返さない", () => {
    embed(JSON.stringify(PAGE));
    readInitialPage("navigate");
    expect(initialPageFor({ by: "id", id: "BBBBBBBBBBBBBBBBBBBBBB" })).toBeNull();
    expect(initialPageFor({ by: "title", title: "Other Note" })).toBeNull();
  });

  it("要素が無い、壊れている、形が違う、draft のときは null", () => {
    readInitialPage("navigate");
    expect(initialPageFor({ by: "id", id: PAGE.id })).toBeNull();
    for (const text of [
      "{",
      "",
      JSON.stringify({ ...PAGE, version: "3" }),
      JSON.stringify({ ...PAGE, visibility: "draft" }),
    ]) {
      const script = embed(text);
      readInitialPage("navigate");
      expect(script.isConnected, text).toBe(false);
      expect(initialPageFor({ by: "id", id: PAGE.id }), text).toBeNull();
    }
  });

  it("戻る、進むで開いた HTML のページは使わない", () => {
    const script = embed(JSON.stringify(PAGE));
    readInitialPage("back_forward");
    expect(script.isConnected).toBe(false);
    expect(initialPageFor({ by: "id", id: PAGE.id })).toBeNull();
  });

  it("SPA の中でパスが変わったら捨て、同じパスに戻っても使わない", () => {
    history.replaceState(null, "", `/p/${PAGE.id}`);
    embed(JSON.stringify(PAGE));
    readInitialPage("navigate");
    // hash だけの移動は同じ画面の中なので捨てない
    navigate(`/p/${PAGE.id}#top`);
    expect(initialPageFor({ by: "id", id: PAGE.id })).toEqual(PAGE);
    navigate("/");
    navigate(`/p/${PAGE.id}`);
    expect(initialPageFor({ by: "id", id: PAGE.id })).toBeNull();
  });

  it("discardInitialPage の後は返さない", () => {
    embed(JSON.stringify(PAGE));
    readInitialPage("navigate");
    discardInitialPage();
    expect(initialPageFor({ by: "id", id: PAGE.id })).toBeNull();
  });
});
