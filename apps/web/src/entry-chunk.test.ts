import { fileURLToPath } from "node:url";
import { build, type Rolldown } from "vite";
import { describe, expect, it } from "vitest";
import { PAGE_VIEW_PRELOAD_ATTRIBUTE } from "./page-view-preload";

const root = fileURLToPath(new URL("..", import.meta.url));

// トップは一覧だけを描くので、エディタと Markdown の解析器を描画の前に読むと FCP と LCP が遅れる。
// ページの画面は page-view-loader が読み込む
const EDITOR_MODULE =
  /\/node_modules\/@(?:codemirror|lezer)\/|\/packages\/(?:editor|markdown)\/src\//;
// quick switcher が入口から使う title の候補の検索は、CodeMirror に依存しない
const ALLOWED_IN_ENTRY = /\/packages\/editor\/src\/(?:page-index|title-similarity)\.ts$/;

interface BuildOutput {
  chunks: Map<string, Rolldown.OutputChunk>;
  html: string;
}

let built: Promise<BuildOutput> | undefined;

/** 実際の vite.config.ts で 1 度だけ build し、同じ出力を各テストで見る。 */
function buildOutput(): Promise<BuildOutput> {
  built ??= build({
    root,
    configFile: `${root}/vite.config.ts`,
    logLevel: "silent",
    build: { write: false },
  }).then((result) => {
    if (Array.isArray(result) || !("output" in result))
      throw new Error("build の出力が 1 つでない");
    const chunks = new Map<string, Rolldown.OutputChunk>();
    let html = "";
    for (const file of result.output) {
      if (file.type === "chunk") chunks.set(file.fileName, file);
      else if (file.fileName === "index.html") html = String(file.source);
    }
    return { chunks, html };
  });
  return built;
}

/** fileNames から静的な import でたどれる chunk。skip の chunk とその先はたどらない。 */
function reachable(
  chunks: Map<string, Rolldown.OutputChunk>,
  fileNames: Iterable<string>,
  skip: Set<string> = new Set(),
): Set<string> {
  const loaded = new Set<string>();
  const visit = (fileName: string) => {
    const chunk = chunks.get(fileName);
    if (chunk === undefined || loaded.has(fileName) || skip.has(fileName)) return;
    loaded.add(fileName);
    for (const imported of chunk.imports) visit(imported);
  };
  for (const fileName of fileNames) visit(fileName);
  return loaded;
}

/** 印の `<template>`。中の link は文書に属さず、ブラウザは取りに行かない。 */
const PRELOAD_TEMPLATE = new RegExp(
  `<template ${PAGE_VIEW_PRELOAD_ATTRIBUTE}>([\\s\\S]*?)</template>`,
  "g",
);

const moduleIdsOf = (chunks: Map<string, Rolldown.OutputChunk>, fileNames: Iterable<string>) =>
  [...fileNames].flatMap((fileName) => chunks.get(fileName)?.moduleIds ?? []);

describe("入口の chunk", () => {
  it("入口の chunk と index.html の modulepreload に、エディタと Markdown の解析器を入れない", async () => {
    const { chunks, html } = await buildOutput();
    const entry = [...chunks.values()].find((chunk) => chunk.isEntry);
    expect(entry).toBeDefined();
    expect(html).toContain(`src="/${entry?.fileName}"`);
    const preloaded = [
      ...html
        .replace(PRELOAD_TEMPLATE, "")
        .matchAll(/<link rel="modulepreload"[^>]*href="\/([^"]+)"/g),
    ].map((match) => match[1] ?? "");

    // 入口が静的に import する chunk も、入口と一緒に描画の前に読まれる
    const loaded = reachable(chunks, [entry?.fileName ?? "", ...preloaded]);
    const misplaced = moduleIdsOf(chunks, loaded).filter(
      (id) => EDITOR_MODULE.test(id) && !ALLOWED_IN_ENTRY.test(id),
    );
    expect(misplaced).toEqual([]);
    // 照合の形がモジュールの id の書き方とずれて、何も当たらないまま通ることを防ぐ
    expect(moduleIdsOf(chunks, chunks.keys()).some((id) => EDITOR_MODULE.test(id))).toBe(true);
  }, 60_000);
});

describe("ページの画面の chunk の印", () => {
  it("head の印の template の中で、ページの画面の chunk と、入口から読まないその静的な依存を modulepreload で 1 つずつ指す", async () => {
    const { chunks, html } = await buildOutput();
    const head = html.slice(0, html.indexOf("</head>"));
    const templates = [...head.matchAll(PRELOAD_TEMPLATE)];
    expect(templates).toHaveLength(1);
    expect([...html.matchAll(PRELOAD_TEMPLATE)]).toHaveLength(1);
    const tags = [...(templates[0]?.[1] ?? "").matchAll(/<link\b[^>]*>/g)].map((match) => match[0]);
    for (const tag of tags) {
      expect(tag).toMatch(/\srel="modulepreload"/);
      // 入口の script と同じ取得の設定でないと、入口の動的 import が同じ chunk を取り直す
      expect(tag).toMatch(/\scrossorigin[\s>]/);
    }
    const marked = tags.map((tag) => /\shref="\/([^"]+)"/.exec(tag)?.[1] ?? "");
    // template の外で指すと、Worker が書き換えない HTML でも取りに行き、Vite の preload の helper も読み込み済みとみなす
    const outside = html.replace(PRELOAD_TEMPLATE, "");
    for (const fileName of marked) expect(outside).not.toContain(fileName);

    const pageView = [...chunks.values()].find(
      (chunk) => chunk.isDynamicEntry && chunk.facadeModuleId?.endsWith("/src/PageView.tsx"),
    );
    expect(pageView).toBeDefined();
    const entries = [...chunks.values()].filter((chunk) => chunk.isEntry);
    const loadedByEntry = reachable(
      chunks,
      entries.map((chunk) => chunk.fileName),
    );
    const expected = reachable(chunks, [pageView?.fileName ?? ""], loadedByEntry);
    expect(marked[0]).toBe(pageView?.fileName);
    expect(new Set(marked)).toEqual(expected);
    expect(marked).toHaveLength(expected.size);
    // 印を付けた chunk が実際にエディタを含む（画面の chunk を取り違えていない）
    expect(moduleIdsOf(chunks, marked).some((id) => /\/node_modules\/@codemirror\//.test(id))).toBe(
      true,
    );
  }, 60_000);
});
