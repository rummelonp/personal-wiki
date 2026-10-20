import { fileURLToPath } from "node:url";
import { build, type Rolldown } from "vite";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

// トップは一覧だけを描くので、エディタと Markdown の解析器を描画の前に読むと FCP と LCP が遅れる。
// ページの画面は page-view-loader が読み込む
const EDITOR_MODULE =
  /\/node_modules\/@(?:codemirror|lezer)\/|\/packages\/(?:editor|markdown)\/src\//;
// quick switcher が入口から使う title の候補の検索は、CodeMirror に依存しない
const ALLOWED_IN_ENTRY = /\/packages\/editor\/src\/(?:page-index|title-similarity)\.ts$/;

async function buildOutput(): Promise<Rolldown.RolldownOutput["output"]> {
  const result = await build({
    root,
    configFile: `${root}/vite.config.ts`,
    logLevel: "silent",
    build: { write: false },
  });
  if (Array.isArray(result) || !("output" in result)) throw new Error("build の出力が 1 つでない");
  return result.output;
}

describe("入口の chunk", () => {
  it("入口の chunk と index.html の modulepreload に、エディタと Markdown の解析器を入れない", async () => {
    const output = await buildOutput();
    const chunks = new Map<string, Rolldown.OutputChunk>();
    let html = "";
    for (const file of output) {
      if (file.type === "chunk") chunks.set(file.fileName, file);
      else if (file.fileName === "index.html") html = String(file.source);
    }
    const entry = [...chunks.values()].find((chunk) => chunk.isEntry);
    expect(entry).toBeDefined();
    expect(html).toContain(`src="/${entry?.fileName}"`);
    const preloaded = [...html.matchAll(/<link rel="modulepreload"[^>]*href="\/([^"]+)"/g)].map(
      (match) => match[1] ?? "",
    );

    // 入口が静的に import する chunk も、入口と一緒に描画の前に読まれる
    const loaded = new Set<string>();
    const visit = (fileName: string) => {
      const chunk = chunks.get(fileName);
      if (chunk === undefined || loaded.has(fileName)) return;
      loaded.add(fileName);
      for (const imported of chunk.imports) visit(imported);
    };
    for (const fileName of [entry?.fileName ?? "", ...preloaded]) visit(fileName);

    const moduleIdsOf = (fileNames: Iterable<string>) =>
      [...fileNames].flatMap((fileName) => chunks.get(fileName)?.moduleIds ?? []);
    const misplaced = moduleIdsOf(loaded).filter(
      (id) => EDITOR_MODULE.test(id) && !ALLOWED_IN_ENTRY.test(id),
    );
    expect(misplaced).toEqual([]);
    // 照合の形がモジュールの id の書き方とずれて、何も当たらないまま通ることを防ぐ
    expect(moduleIdsOf(chunks.keys()).some((id) => EDITOR_MODULE.test(id))).toBe(true);
  }, 60_000);
});
