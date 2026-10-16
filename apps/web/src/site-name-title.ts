import type { Plugin } from "vite";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * index.html の `<title>` の中身をサイト名にする。Vite の `%VITE_*%` の置換は値をエスケープしないので、
 * `&` や `<` を含む名前が HTML を壊さないよう、この plugin で置き換える。
 * Worker は、ページの URL でこの `<title>` の前に `ページの title - ` を差し込む。
 */
export function siteNameTitle(siteName: string | undefined): Plugin {
  const name = siteName?.trim();
  return {
    name: "site-name-title",
    transformIndexHtml(html) {
      if (name === undefined || name === "") return html;
      return html.replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(name)}</title>`);
    },
  };
}
