// 理由は page-tools.ts の同じ import を参照
import { prepareSearchQuery, SEARCH_MAX_QUERY_CHARS } from "@personal-wiki/domain";
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
  listUnresolvedLinks,
  type PageList,
  type PageSummary,
  parseCursor,
  prepareTagFilter,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  searchPages,
  searchQueryErrorFields,
  TAG_MAX_LENGTH,
  tagFilterErrorFields,
  UNRESOLVED_SOURCES_PER_TITLE,
} from "../pages/search";
import { findPageByTitle, pageExists } from "../pages/store";
import { pageUrls } from "../pages/urls";
import { LISTED_BODY_SHA256_NOTE } from "./body-hash";
import { pageIdSchema } from "./page-tools";
import { defineTool, toolError, toolResult } from "./tool";

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

const VERSION_NOTE =
  "各件の version は read_page の version と同じ値で、update_page と edit_page の version にそのまま渡せる。ページの保存、公開範囲の切り替え、別のページの title の変更に伴うリンクの書き換えなどで進む。オーナーがブラウザで続けて保存して版の履歴が 1 つにまとまっても、保存ごとに進む。リンクの書き換えは title の変更より遅れて進むので、誰も保存していないページの version が後から進むことがある。ローカルの写しと照合するときは、read_page で 1 件ずつ読まずに、この version を写しを取ったときの値と比べる。";

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
    "title と本文の部分一致でページを探し、id、title、version、bodySha256、本文の抜粋、tags を返す。draft も含む。",
    "excerpt は一致した位置の周辺の本文で、tags はページに付いたタグの表記。",
    VERSION_NOTE,
    LISTED_BODY_SHA256_NOTE,
    "title に語を含むページが先。その中と残りは、3 文字以上は全文検索で関連度の順、2 文字以下は部分一致で更新が新しい順。短い語で見つからなければ語を足す。",
    "全角半角と、英字の大文字小文字は区別しない。",
    `query は ${SEARCH_MAX_QUERY_CHARS} 文字まで。改行やタブなどの制御文字を含めると invalid_field になる。`,
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
        ...searchQueryErrorFields(prepared.reason),
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
    "各件に tags（ページに付いたタグの表記）、createdAt（ページを作った時刻。UNIX エポックのミリ秒で、更新しても変わらない）、本文の先頭の excerpt を付ける。本文が空のページと、抜粋を作り直す前のページには excerpt が無い。",
    VERSION_NOTE,
    LISTED_BODY_SHA256_NOTE,
    "tag を渡すと、そのタグが付いたページだけに絞る。親のタグには子のタグのページも含まれる（`work` は `work/project` が付いたページにも一致する）。全角半角と大文字小文字は区別せず、先頭の `#` はあってもなくてもよい。タグでまとめたページを見渡すのに使う。cursor を渡すときは、前の呼び出しと同じ tag を渡す。",
    `tag は表記をそろえた後で ${TAG_MAX_LENGTH} 文字まで。`,
  ].join("\n"),
  inputSchema: z.strictObject({
    tag: z
      .string()
      .optional()
      .describe("このタグ（子のタグを含む）が付いたページに絞る。例 `work`、`work/project`"),
    limit: limitSchema(LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT),
    cursor: cursorSchema,
  }),
  annotations: READ_ONLY,
  async run({ tag, limit, cursor }, ctx) {
    const filter = tag === undefined ? null : prepareTagFilter(tag);
    if (filter?.ok === false) {
      return toolError({
        error: "invalid_field",
        field: "tag",
        ...tagFilterErrorFields(filter.reason),
      });
    }
    const paging = readCursor(cursor);
    if (!paging.ok) return invalidCursor();
    const list = await listRecentPages(ctx.db, {
      limit: limit ?? LIST_DEFAULT_LIMIT,
      cursor: paging.cursor,
      tagKey: filter?.key ?? null,
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
    VERSION_NOTE,
    LISTED_BODY_SHA256_NOTE,
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

export const listUnresolvedLinksTool = defineTool({
  name: "list_unresolved_links",
  scope: "read",
  title: "行き先の無いリンク",
  description: [
    "本文の `[[title]]` のうち、行き先のページがまだ無いものを、title ごとにまとめて返す。draft のページに書かれたものも含む。wiki の棚卸しで、意図して残した未作成の語と、書き間違いやリンク切れを見分けるのに使う。",
    `各件は titleKey、sourceCount（リンク元のページ数）、sources（リンク元の新しい順に先頭 ${UNRESOLVED_SOURCES_PER_TITLE} 件）。titleKey の昇順で、nextCursor が null でなければ、cursor に渡して続きを取る。`,
    "cursor は nextCursor の値をそのまま渡す。形の検査はせず、渡した文字列より大きい titleKey を返すので、nextCursor 以外の値を渡すと、それより小さい titleKey の件は飛ばされる（エラーにはならない）。titleKey は先頭と末尾の `_` が空白として残る（`[[__init__]]` は `  init  `）ので、正規化し直した値は cursor にならない。",
    "titleKey は title を大文字小文字と全角半角、`_` と空白を畳んだ値で、本文に書かれた表記そのままではない（元の表記はリンク元を read_page で読む）。list_backlinks の title と、そのページを作った後の read_page の title にそのまま渡せる。",
    "リンク元をすべて見るには、titleKey を list_backlinks の title に渡す。",
    "id と title はどちらも省略できる。どちらか一方を渡すと、そのページの本文にある行き先の無いリンクだけを返す（sourceCount は 1）。ページが無ければ not_found。",
    "ページを作ると、そのページへのリンクは一覧から消える。title を変えた直後は、他のページに残る `[[旧 title]]` も出る。rewrite_links を remaining が 0 になるまで呼ぶと消える。",
    "添付の embed（`![[a.png]]`）は含まない。",
  ].join("\n"),
  inputSchema: z.strictObject({
    id: pageIdSchema.optional(),
    title: z.string().describe("このページの本文にあるリンクだけに絞る。ページの title").optional(),
    limit: limitSchema(LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT),
    cursor: cursorSchema,
  }),
  annotations: READ_ONLY,
  async run({ id, title, limit, cursor }, ctx) {
    if (id !== undefined && title !== undefined) {
      return toolError({
        error: "invalid_arguments",
        message: "id と title は同時に指定できない",
      });
    }
    const readable = readableVisibilityOf(ctx.principal);
    let sourceId: string | null = null;
    if (id !== undefined || title !== undefined) {
      if (id !== undefined && !isPageId(id)) return toolError({ error: "not_found" });
      if (id === undefined) {
        const page = await findPageByTitle(ctx.db, title as string, readable);
        if (page === null) return toolError({ error: "not_found" });
        sourceId = page.id;
      } else {
        if (!(await pageExists(ctx.db, id))) return toolError({ error: "not_found" });
        sourceId = id;
      }
    }
    const { links, nextCursor } = await listUnresolvedLinks(ctx.db, {
      limit: limit ?? LIST_DEFAULT_LIMIT,
      after: cursor === undefined || cursor === "" ? null : cursor,
      sourceId,
      readable,
    });
    return toolResult({
      links: links.map((link) => ({
        ...link,
        sources: link.sources.map((source) => withUrls(source, ctx.origin)),
      })),
      nextCursor,
    });
  },
});

export const SEARCH_TOOLS = [
  searchTool,
  listRecentTool,
  listBacklinksTool,
  listUnresolvedLinksTool,
];
