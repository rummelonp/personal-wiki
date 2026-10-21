import { normalizePath, type Plugin, type Rolldown } from "vite";

/** 印の `<template>` の属性。Worker（apps/worker/src/page-html.ts）も同じ名前で探す。 */
export const PAGE_VIEW_PRELOAD_ATTRIBUTE = "data-page-view-preload";

/**
 * index.html の head に、ページの画面の chunk と、それが静的に import する chunk の modulepreload を、印の
 * `<template>` で包んで置く。ページの画面は入口の chunk が動的 import で読むので、そのままでは入口を実行し終える
 * まで取り始めない。Worker はページの URL の HTML でだけ `<template>` を外し、入口の chunk と並べて取らせる。
 * chunk の名前は build ごとに変わるので、Worker は名前を知らずに印だけを探す。
 *
 * `<template>` の中身は文書に属さないので、Worker が書き換えない HTML（トップや絞り込みの画面、404）では
 * ブラウザが取りに行かない。Vite の preload の helper が読み込み済みとみなすのは文書の `<link>` の href だけで、
 * `<template>` の中は見ないので、画面の中でページへ移るときは依存の chunk を並べて取る。
 *
 * 入口から静的にたどれる chunk は入口の script が既に読むので除く。ページの画面の chunk が見つからなければ
 * build を止める（ファイル名を変えたときに、黙って印が無くなるのを防ぐ）。
 */
export function pageViewPreload(pageViewModule: string): Plugin {
  let base = "/";
  let moduleId = "";
  return {
    name: "page-view-preload",
    apply: "build",
    configResolved(config) {
      // href は /p/<id> などの深い URL で解決されるので、絶対の base でないと壊れる
      if (!config.base.startsWith("/")) {
        throw new Error(`base は / で始まる絶対パスにする（${config.base}）`);
      }
      base = config.base;
      moduleId = normalizePath(`${config.root}/${pageViewModule}`);
    },
    transformIndexHtml: {
      // ctx.bundle は build の post の段にだけ入る
      order: "post",
      handler(html, ctx) {
        const bundle = ctx.bundle;
        if (bundle === undefined) return html;
        const chunks = new Map<string, Rolldown.OutputChunk>();
        for (const file of Object.values(bundle)) {
          if (file.type === "chunk") chunks.set(file.fileName, file);
        }
        const pageView = [...chunks.values()].find(
          (chunk) => chunk.isDynamicEntry && chunk.facadeModuleId === moduleId,
        );
        if (pageView === undefined) {
          throw new Error(`${pageViewModule} を動的 import する chunk が build の出力に無い`);
        }

        const reach = (from: string[], skip: Set<string>): string[] => {
          const seen = new Set<string>();
          const visit = (fileName: string) => {
            if (seen.has(fileName) || skip.has(fileName)) return;
            const chunk = chunks.get(fileName);
            if (chunk === undefined) return;
            seen.add(fileName);
            for (const imported of chunk.imports) visit(imported);
          };
          for (const fileName of from) visit(fileName);
          return [...seen];
        };
        const entries = [...chunks.values()].filter((chunk) => chunk.isEntry);
        const loadedByEntry = new Set(
          reach(
            entries.map((chunk) => chunk.fileName),
            new Set(),
          ),
        );
        const files = reach([pageView.fileName], loadedByEntry);
        return {
          html,
          tags: [
            {
              tag: "template",
              attrs: { [PAGE_VIEW_PRELOAD_ATTRIBUTE]: true },
              children: files.map((fileName) => ({
                tag: "link",
                // crossorigin は、入口の script と Vite の helper が作る link と同じ取得の設定にそろえる
                attrs: { rel: "modulepreload", href: `${base}${fileName}`, crossorigin: true },
              })),
              injectTo: "head" as const,
            },
          ],
        };
      },
    },
  };
}
