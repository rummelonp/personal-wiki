import { readdirSync, readFileSync } from "node:fs";
import {
  foldKeepingUnderscore,
  RESERVED_TITLE_SEGMENTS,
  WORKER_PATH_SEGMENTS,
} from "@personal-wiki/domain";
import { describe, expect, it } from "vitest";
import { stripJsonc } from "./deploy-config.mjs";

const PUBLIC_DIR = new URL("../../web/public/", import.meta.url);
const WRANGLER_PATH = new URL("../wrangler.jsonc", import.meta.url);

// public にあって Worker を通すファイル（CSP などのヘッダーを Worker が付けるもの）。
// run_worker_first の除外には入れない。title の予約語には、Worker を通す場合も入れる
// （spa.ts は ASSETS のファイルをページより先に返す）。
const WORKER_SERVED_PUBLIC_FILES: readonly string[] = [];

// public のファイルに由来しない予約語。`p` は SPA の `/p/<id>`。
// `index.html` は Static Assets の html_handling が `/` への 307 にするので、`index` と合わせて予約する。
const NON_FILE_RESERVED = ["p", "index", "index.html"];

/** public の直下のファイル名。ディレクトリは、予約語と除外の対応を決められないので許さない。 */
function publicFileNames(): string[] {
  const entries = readdirSync(PUBLIC_DIR, { withFileTypes: true });
  const dirs = entries.filter((e) => !e.isFile()).map((e) => e.name);
  expect(dirs, "apps/web/public の直下はファイルだけにする").toEqual([]);
  return entries.map((e) => e.name);
}

/** ファイル名が塞ぐ `/<title>` の先頭 segment。`.html` は拡張子なしの名前でも開ける。 */
function reservedNamesOf(fileName: string): string[] {
  const names = [fileName];
  if (fileName.endsWith(".html")) names.push(fileName.slice(0, -".html".length));
  return names.map(foldKeepingUnderscore);
}

/** run_worker_first の `!/<name>` のうち、1 つのファイルを指すもの。 */
function excludedFileNames(): string[] {
  const config = JSON.parse(stripJsonc(readFileSync(WRANGLER_PATH, "utf8")));
  const patterns: string[] = config.assets.run_worker_first;
  expect(patterns[0]).toBe("/*");
  return patterns
    .filter((p) => p.startsWith("!/") && p !== "!/assets/*")
    .map((p) => p.slice("!/".length));
}

describe("apps/web/public と RESERVED_TITLE_SEGMENTS、run_worker_first の対応", () => {
  it("run_worker_first の除外は、public にあって Worker を通さないファイルを 1 つずつ指す", () => {
    const files = new Set(publicFileNames());
    const excluded = excludedFileNames();
    expect(excluded.filter((name) => !files.has(name))).toEqual([]);
    expect(excluded.filter((name) => WORKER_SERVED_PUBLIC_FILES.includes(name))).toEqual([]);
    expect(new Set(excluded).size).toBe(excluded.length);
  });

  it("Worker を通さない public のファイルは、すべて run_worker_first から除かれている", () => {
    const excluded = new Set(excludedFileNames());
    const direct = publicFileNames().filter((name) => !WORKER_SERVED_PUBLIC_FILES.includes(name));
    expect(direct.filter((name) => !excluded.has(name))).toEqual([]);
  });

  it("WORKER_SERVED_PUBLIC_FILES は public にあるファイルだけを挙げる", () => {
    const files = new Set(publicFileNames());
    expect(WORKER_SERVED_PUBLIC_FILES.filter((name) => !files.has(name))).toEqual([]);
  });

  it("public のファイルの名前は、すべて RESERVED_TITLE_SEGMENTS に入っている", () => {
    const names = publicFileNames().flatMap(reservedNamesOf);
    expect(names.filter((name) => !RESERVED_TITLE_SEGMENTS.includes(name))).toEqual([]);
  });

  it("RESERVED_TITLE_SEGMENTS の各語は、Worker のパス、public のファイル、固定の予約語のどれかに由来する", () => {
    const known = new Set([
      ...WORKER_PATH_SEGMENTS.map(foldKeepingUnderscore),
      ...NON_FILE_RESERVED,
      ...publicFileNames().flatMap(reservedNamesOf),
    ]);
    expect(RESERVED_TITLE_SEGMENTS.filter((segment) => !known.has(segment))).toEqual([]);
  });
});
