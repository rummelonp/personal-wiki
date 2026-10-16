// 理由は page-tools.ts の同じ import を参照
import { prepareSearchQuery } from "@personal-wiki/domain";
import * as z from "zod/v4";
import { readableVisibilityOf } from "../auth/principal";
import { isPageId } from "../pages/id";
import {
  type Cursor,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  listBacklinks,
  listBacklinksByTitle,
  listRecentPages,
  type PageList,
  type PageSummary,
  parseCursor,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_QUERY_MESSAGES,
  searchPages,
} from "../pages/search";
import { pageUrls } from "../pages/urls";
import { pageIdSchema } from "./page-tools";
import { defineTool, toolError, toolResult } from "./tool";

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

/** limit の範囲は REST の limit クエリと同じ。範囲外は schema の検証で弾く */
const limitSchema = (fallback: number, max: number) =>
  z.number().int().min(1).max(max).optional().describe(`返す件数。既定 ${fallback}、上限 ${max}`);

const cursorSchema = z
  .string()
  .optional()
  .describe("続きを取るときに、前の結果の nextCursor をそのまま渡す");

type CursorInput = { ok: true; cursor: Cursor | null } | { ok: false };

function readCursor(raw: string | undefined): CursorInput {
  if (raw === undefined) return { ok: true, cursor: null };
  const cursor = parseCursor(raw);
  return cursor === null ? { ok: false } : { ok: true, cursor };
}

const invalidCursor = () => toolError({ error: "invalid_field", field: "cursor" });

function withUrls<T extends PageSummary>(page: T, origin: string) {
  return { ...page, ...pageUrls(origin, page) };
}

function listResult({ pages, nextCursor }: PageList, origin: string) {
  return toolResult({ pages: pages.map((page) => withUrls(page, origin)), nextCursor });
}

export const searchTool = defineTool({
  name: "search",
  scope: "read",
  title: "ページを探す",
  description: [
    "title と本文の部分一致でページを探し、id、title、本文の抜粋、tags を返す。draft も含む。",
    "excerpt は一致した位置の周辺の本文で、tags はページに付いたタグの表記。",
    "title に語を含むページが先。その中と残りは、3 文字以上は全文検索で関連度の順、2 文字以下は部分一致で更新が新しい順。短い語で見つからなければ語を足す。",
    "全角半角と、英字の大文字小文字は区別しない。",
  ].join("\n"),
  inputSchema: z.strictObject({
    query: z.string().describe("探す語。全体を 1 つの語句として照合する"),
    limit: limitSchema(SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT),
  }),
  annotations: READ_ONLY,
  async run({ query, limit }, ctx) {
    const prepared = prepareSearchQuery(query);
    if (!prepared.ok) {
      return toolError({
        error: "invalid_field",
        field: "query",
        message: SEARCH_QUERY_MESSAGES[prepared.reason],
      });
    }
    const results = await searchPages(
      ctx.db,
      prepared.query,
      limit ?? SEARCH_DEFAULT_LIMIT,
      readableVisibilityOf(ctx.principal),
    );
    return toolResult({ results: results.map((hit) => withUrls(hit, ctx.origin)) });
  },
});

export const listRecentTool = defineTool({
  name: "list_recent",
  scope: "read",
  title: "最近の更新",
  description: [
    "ページを更新が新しい順に返す。draft も含む。nextCursor が null でなければ、cursor に渡して続きを取る。",
    "各件に tags（ページに付いたタグの表記）と、本文の先頭の excerpt を付ける。本文が空のページと、抜粋を作り直す前のページには excerpt が無い。",
  ].join("\n"),
  inputSchema: z.strictObject({
    limit: limitSchema(LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT),
    cursor: cursorSchema,
  }),
  annotations: READ_ONLY,
  async run({ limit, cursor }, ctx) {
    const paging = readCursor(cursor);
    if (!paging.ok) return invalidCursor();
    const list = await listRecentPages(ctx.db, {
      limit: limit ?? LIST_DEFAULT_LIMIT,
      cursor: paging.cursor,
      readable: readableVisibilityOf(ctx.principal),
    });
    return listResult(list, ctx.origin);
  },
});

export const listBacklinksTool = defineTool({
  name: "list_backlinks",
  scope: "read",
  title: "参照元",
  description: [
    "本文の `[[title]]` でそのページへリンクしているページを、更新が新しい順に返す。draft も含む。nextCursor が null でなければ、cursor に渡して続きを取る。",
    "id と title はどちらか一方だけを指定する。title で引くと、まだ作られていないページ（`[[title]]` のリンク先が無いもの）のリンク元も返る。title は大文字小文字と全角半角を区別せず、`_` と空白を同じ文字として扱う。",
    "id で引くとき、id のページが無ければ not_found。",
  ].join("\n"),
  inputSchema: z.strictObject({
    id: pageIdSchema.optional(),
    title: z.string().describe("リンク先のページの title。まだ無いページでもよい").optional(),
    limit: limitSchema(LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT),
    cursor: cursorSchema,
  }),
  annotations: READ_ONLY,
  async run({ id, title, limit, cursor }, ctx) {
    if ((id === undefined) === (title === undefined)) {
      return toolError({
        error: "invalid_arguments",
        message: "id と title のどちらか一方だけを指定する",
      });
    }
    if (id !== undefined && !isPageId(id)) return toolError({ error: "not_found" });
    const paging = readCursor(cursor);
    if (!paging.ok) return invalidCursor();
    const options = {
      limit: limit ?? LIST_DEFAULT_LIMIT,
      cursor: paging.cursor,
      readable: readableVisibilityOf(ctx.principal),
    };
    if (id === undefined) {
      const list = await listBacklinksByTitle(ctx.db, title as string, options);
      if (list === null) {
        return toolError({
          error: "invalid_field",
          field: "title",
          message: "title が空か、空白だけになっている",
        });
      }
      return listResult(list, ctx.origin);
    }
    const list = await listBacklinks(ctx.db, id, options);
    if (list === null) return toolError({ error: "not_found" });
    return listResult(list, ctx.origin);
  },
});

export const SEARCH_TOOLS = [searchTool, listRecentTool, listBacklinksTool];
