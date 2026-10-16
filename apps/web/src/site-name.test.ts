import { afterEach, describe, expect, it, vi } from "vitest";
import { siteNameTitle } from "./site-name-title";

const HTML = '<head><title>personal-wiki</title></head><div id="root"></div>';

function transform(siteName: string | undefined, html = HTML): string {
  const hook = siteNameTitle(siteName).transformIndexHtml;
  if (typeof hook !== "function") throw new Error("transformIndexHtml が関数でない");
  return hook.call({} as never, html, {} as never) as string;
}

describe("siteNameTitle", () => {
  it("title の中身をサイト名にし、HTML の特殊文字はエスケープする", () => {
    expect(transform("rummelonp wiki")).toContain("<title>rummelonp wiki</title>");
    expect(transform(`A & <B> "C" $&`)).toContain(
      "<title>A &amp; &lt;B&gt; &quot;C&quot; $&amp;</title>",
    );
  });

  it("サイト名が無いか空なら HTML を変えない", () => {
    expect(transform(undefined)).toBe(HTML);
    expect(transform("  ")).toBe(HTML);
  });
});

describe("SITE_NAME", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("VITE_SITE_NAME があればそれを使い、無ければ既定の名前", async () => {
    vi.stubEnv("VITE_SITE_NAME", " rummelonp wiki ");
    vi.resetModules();
    expect((await import("./site-name")).SITE_NAME).toBe("rummelonp wiki");

    vi.stubEnv("VITE_SITE_NAME", "");
    vi.resetModules();
    expect((await import("./site-name")).SITE_NAME).toBe("personal-wiki");
  });
});
