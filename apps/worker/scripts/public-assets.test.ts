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
const INDEX_HTML_PATH = new URL("../../web/index.html", import.meta.url);
const OAUTH_ROUTES_PATH = new URL("../src/auth/oauth-routes.ts", import.meta.url);

// public にあって Worker を通すファイル（CSP などのヘッダーを Worker が付けるもの）。
// run_worker_first の除外には入れない。title の予約語には、Worker を通す場合も入れる
// （spa.ts は ASSETS のファイルをページより先に返す）。
const WORKER_SERVED_PUBLIC_FILES: readonly string[] = [];

// public のファイルに由来しない予約語。`p` は SPA の `/p/<id>`。
// `index.html` は Static Assets の html_handling が `/` への 307 にするので、`index` と合わせて予約する。
const NON_FILE_RESERVED = ["p", "index", "index.html"];

// Static Assets の設定として読まれ、自身は配信されないファイル。`/<名前>` は Worker に届くので、
// 予約語にも run_worker_first の除外にも入れない。
const ASSET_CONFIG_FILES: readonly string[] = ["_headers"];

/** public の直下で配信されるファイル名。ディレクトリは、予約語と除外の対応を決められないので許さない。 */
function publicFileNames(): string[] {
  const entries = readdirSync(PUBLIC_DIR, { withFileTypes: true });
  const dirs = entries.filter((e) => !e.isFile()).map((e) => e.name);
  expect(dirs, "apps/web/public の直下はファイルだけにする").toEqual([]);
  return entries.map((e) => e.name).filter((name) => !ASSET_CONFIG_FILES.includes(name));
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

/** `rel` が icon か apple-touch-icon の `<link>` の href。属性の並びには依らない。 */
function iconHrefsOf(html: string): string[] {
  return [...html.matchAll(/<link\s[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => /\brel="(?:apple-touch-)?icon"/.test(tag))
    .map((tag) => /\bhref="([^"]+)"/.exec(tag)?.[1] ?? "");
}

/**
 * OAuth の画面の `ICON_LINKS`。oauth-routes.ts は workerd 専用の import（CSS と cloudflare:workers）を
 * 持ち、この node のテストでは読み込めないので、ソースから定数の本文を取り出す。
 */
function oauthIconLinks(): string {
  const source = readFileSync(OAUTH_ROUTES_PATH, "utf8");
  const body = /\bconst ICON_LINKS = `([^`]*)`/.exec(source)?.[1];
  expect(body, "oauth-routes.ts に ICON_LINKS の定義が見つからない").toBeDefined();
  expect(body).not.toContain("${");
  return body ?? "";
}

describe("OAuth の画面の icon の link", () => {
  it("SPA の index.html の icon と、run_worker_first の除外の両方に含まれる", () => {
    const hrefs = iconHrefsOf(oauthIconLinks());
    expect(hrefs).not.toEqual([]);
    const spa = iconHrefsOf(readFileSync(INDEX_HTML_PATH, "utf8"));
    expect(hrefs.filter((href) => !spa.includes(href))).toEqual([]);
    const excluded = excludedFileNames().map((name) => `/${name}`);
    expect(hrefs.filter((href) => !excluded.includes(href))).toEqual([]);
  });
});

/** `_headers` の、パスの行から次のパスの行までに並ぶヘッダーの行。 */
function headerRulesOf(path: string): string[] {
  const lines = readFileSync(new URL("_headers", PUBLIC_DIR), "utf8").split("\n");
  const start = lines.indexOf(path);
  expect(start, `_headers に ${path} の規則が無い`).not.toBe(-1);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => !/^\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).map((line) => line.trim());
}

describe("apps/web/public/_headers", () => {
  // 本番の Static Assets は .txt を charset なしの text/plain で返し、ブラウザで ASCII でない文字が化ける。
  // ローカルの wrangler dev は charset を付けて返すので、E2E では確かめられない。
  it("robots.txt の Content-Type に charset=utf-8 を付ける", () => {
    expect(headerRulesOf("/robots.txt")).toContain("Content-Type: text/plain; charset=utf-8");
  });
});

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
