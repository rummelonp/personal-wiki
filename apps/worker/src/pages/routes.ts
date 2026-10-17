import {
  ANONYMOUS_SEARCH_MIN_CHARS,
  MAX_BODY_BYTES,
  prepareSearchQuery,
  searchQueryLength,
} from "@personal-wiki/domain";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { allowAnonymousRead, requireOwner, requireScope } from "../auth/middleware";
import { readableVisibilityOf } from "../auth/principal";
import type { AppEnv } from "../env";
import { isPageId } from "./id";
import {
  appendToPageAs,
  createPageAs,
  describeWriteError,
  findPageByInputId,
  linkRewritesField,
  MAX_REQUEST_BYTES,
  type PageWriteContext,
  restoreRevisionAs,
  setVisibilityAs,
  stepLinkRewritesAs,
  updatePageAs,
  VISIBILITY_NOT_ALLOWED_MESSAGE,
  type WriteMetric,
} from "./operations";
import {
  clientNameLookup,
  findRevision,
  listRevisions,
  parseRevisionCursor,
  parseVersion,
} from "./revision-history";
import { actorOf } from "./revisions";
import {
  type Cursor,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  listBacklinks,
  listBacklinksByTitle,
  listPageTitles,
  listRecentPages,
  listTagCounts,
  parseCursor,
  prepareTagFilter,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  searchPages,
  searchQueryErrorFields,
  TITLES_MAX_LIMIT,
  tagFilterErrorFields,
} from "./search";
import {
  type AppendError,
  deletePage,
  findPageByTitle,
  type Page,
  REBUILD_MAX_LIMIT,
  rebuildDerived,
  resolvePagesByTitle,
  type Visibility,
  type WriteError,
} from "./store";

export interface PagesRoutesOptions {
  now: () => number;
  recordWrite: (metric: WriteMetric) => void;
}

type PagesContext = Context<AppEnv>;

/**
 * `/api/pages/resolve` が 1 回に受け付ける title の数。D1 へのクエリは件数に関係なく 1 回で、
 * この上限は 1 回の正規化と応答の大きさを抑える。URL に収まることは保証しない（title は 1 件で
 * percent-encoding 後に数 KB になりうる）。クライアントは件数とエンコード後の URL の長さの両方で
 * 分けて呼ぶ。
 */
export const RESOLVE_MAX_TITLES = 50;

function errorResponse(
  c: PagesContext,
  status: ContentfulStatusCode,
  error: string,
  extra: Record<string, unknown> = {},
): Response {
  return c.json({ error, ...extra }, status);
}

/** 版の ETag。強い比較で If-Match と突き合わせる。 */
const etagOf = (version: number) => `"${version}"`;

function pageResponse(
  c: PagesContext,
  page: Page,
  status: 200 | 201 = 200,
  extra: Record<string, unknown> = {},
): Response {
  c.header("ETag", etagOf(page.version));
  return c.json(
    {
      id: page.id,
      title: page.title,
      body: page.body,
      visibility: page.visibility,
      version: page.version,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
      ...extra,
    },
    status,
  );
}

function writeErrorResponse(
  c: PagesContext,
  error: WriteError | AppendError,
): Response | Promise<Response> {
  if (error.reason === "not_found") return c.notFound();
  const { status, body } = describeWriteError(error);
  return c.json(body, status);
}

type FieldSpec = Record<string, "string" | "number" | "string_or_null">;

type ParsedBody = { ok: true; value: Record<string, unknown> } | { ok: false; response: Response };

/** 本文を JSON の object として読む。大きすぎる本文は解析せずに 413 にする。 */
async function readJsonObject(c: PagesContext): Promise<ParsedBody> {
  const length = Number(c.req.header("Content-Length"));
  if (length > MAX_REQUEST_BYTES) {
    return {
      ok: false,
      response: errorResponse(c, 413, "body_too_large", { max: MAX_BODY_BYTES }),
    };
  }
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return { ok: false, response: errorResponse(c, 400, "invalid_json") };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { ok: false, response: errorResponse(c, 400, "invalid_json") };
  }
  return { ok: true, value: json as Record<string, unknown> };
}

/**
 * JSON の object を読み、spec に無いキーを拒む。
 * 黙って捨てると、AI が `content` などの誤ったキーで送ったり、visibility を変えたつもりになったりしても
 * 気づけないので 400 にする。visibility は owner だけが専用のルートで変えられる。
 */
async function readJsonBody(
  c: PagesContext,
  spec: FieldSpec,
  required: readonly string[],
): Promise<ParsedBody> {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  for (const key of Object.keys(value)) {
    if (key === "visibility") {
      return {
        ok: false,
        response: errorResponse(c, 400, "visibility_not_allowed", {
          message: VISIBILITY_NOT_ALLOWED_MESSAGE,
        }),
      };
    }
    if (!Object.hasOwn(spec, key)) {
      return { ok: false, response: errorResponse(c, 400, "unknown_field", { field: key }) };
    }
  }
  for (const [key, type] of Object.entries(spec)) {
    const field = value[key];
    if (field === undefined) {
      if (required.includes(key)) {
        return { ok: false, response: errorResponse(c, 400, "missing_field", { field: key }) };
      }
      continue;
    }
    const valid =
      type === "string_or_null"
        ? typeof field === "string" || field === null
        : typeof field === type;
    if (!valid) {
      return { ok: false, response: errorResponse(c, 400, "invalid_field", { field: key }) };
    }
  }
  return { ok: true, value };
}

function isVisibility(value: unknown): value is Visibility {
  return value === "public" || value === "draft";
}

type IfMatch = { kind: "missing" } | { kind: "invalid" } | { kind: "version"; version: number };

/**
 * `"3"`（ETag の形）と `3`（版の番号そのもの）を受け付ける。`*` や複数の ETag、弱い ETag は
 * 版を特定しないので受け付けない。
 */
function parseIfMatch(header: string | undefined): IfMatch {
  if (header === undefined) return { kind: "missing" };
  const match = /^\s*(?:"([1-9][0-9]{0,14})"|([1-9][0-9]{0,14}))\s*$/.exec(header);
  const digits = match?.[1] ?? match?.[2];
  if (digits === undefined) return { kind: "invalid" };
  return { kind: "version", version: Number(digits) };
}

function requireIfMatch(
  c: PagesContext,
): { ok: true; version: number } | { ok: false; response: Response } {
  const ifMatch = parseIfMatch(c.req.header("If-Match"));
  if (ifMatch.kind === "missing") {
    return {
      ok: false,
      response: errorResponse(c, 428, "if_match_required", {
        message: "If-Match に取得時の ETag を付ける",
      }),
    };
  }
  if (ifMatch.kind === "invalid") {
    return { ok: false, response: errorResponse(c, 400, "invalid_if_match") };
  }
  return { ok: true, version: ifMatch.version };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

/** `limit` クエリを読む。無ければ既定値。整数で 1 以上 max 以下でなければ 400。 */
function readLimit(c: PagesContext, fallback: number, max: number): Parsed<number> {
  const raw = c.req.query("limit");
  if (raw === undefined) return { ok: true, value: fallback };
  const limit = /^[0-9]{1,6}$/.test(raw) ? Number(raw) : 0;
  if (limit < 1 || limit > max) {
    return { ok: false, response: errorResponse(c, 400, "invalid_field", { field: "limit", max }) };
  }
  return { ok: true, value: limit };
}

/** `cursor` クエリを読む。無ければ null。応答の nextCursor 以外の値は 400。 */
function readCursor(c: PagesContext): Parsed<Cursor | null> {
  const raw = c.req.query("cursor");
  if (raw === undefined) return { ok: true, value: null };
  const cursor = parseCursor(raw);
  if (cursor === null) {
    return { ok: false, response: errorResponse(c, 400, "invalid_field", { field: "cursor" }) };
  }
  return { ok: true, value: cursor };
}

/** 一覧 API の limit と cursor を読む。 */
function readPaging(
  c: PagesContext,
  max = LIST_MAX_LIMIT,
): Parsed<{ limit: number; cursor: Cursor | null }> {
  const limit = readLimit(c, LIST_DEFAULT_LIMIT, max);
  if (!limit.ok) return limit;
  const cursor = readCursor(c);
  if (!cursor.ok) return cursor;
  return { ok: true, value: { limit: limit.value, cursor: cursor.value } };
}

/**
 * `/api/pages` のルートを app に登録する。書き込みは owner と token だけが呼べる。読み取りは
 * anonymous も呼べ、title での取得と一覧系は public だけを返す（readableVisibilityOf）。
 * 匿名から見た draft の title、存在しない id、削除済みの id は、どれも notFound の同じ 404 にする。
 * ページの id は形式が違えば D1 を引かずに 404 にする。
 *
 * 認可の宣言はハンドラと同じ method と path の登録に、ハンドラより前に付ける。子の app を route() で
 * 合成したり、prefix の use() で一括に掛けたりすると、宣言の検査がルートを見つけられない。
 */
export function registerPageRoutes(app: Hono<AppEnv>, { now, recordWrite }: PagesRoutesOptions) {
  const writeContext = (c: PagesContext): PageWriteContext => ({
    db: c.env.DB,
    principal: c.get("principal"),
    now,
    recordWrite,
  });
  return (
    app
      .post("/api/pages", requireScope("write"), async (c) => {
        const parsed = await readJsonBody(c, { title: "string", body: "string" }, [
          "title",
          "body",
        ]);
        if (!parsed.ok) return parsed.response;
        const result = await createPageAs(writeContext(c), {
          title: parsed.value.title as string,
          body: parsed.value.body as string,
        });
        if (!result.ok) return writeErrorResponse(c, result);
        c.header("Location", `/api/pages/${result.page.id}`);
        return pageResponse(c, result.page, 201);
      })
      // title は `/` や `#` を含みうるので、パスに埋め込まずクエリで受け取る
      .get("/api/pages/by-title", allowAnonymousRead(), async (c) => {
        const title = c.req.query("title");
        if (title === undefined) return errorResponse(c, 400, "missing_field", { field: "title" });
        const page = await findPageByTitle(
          c.env.DB,
          title,
          readableVisibilityOf(c.get("principal")),
        );
        if (page === null) return c.notFound();
        return pageResponse(c, page);
      })
      // まだ無いページの画面が、その title へのリンク元を出すのに使う。リンク先の有無で応答を変えず、
      // 匿名には draft の title でも存在しない title でも同じ public のリンク元を返す。
      // `/api/pages/:id/backlinks` より前に登録する。後ろだと "by-title" を id として先に 404 にする
      .get("/api/pages/by-title/backlinks", allowAnonymousRead(), async (c) => {
        const title = c.req.query("title");
        if (title === undefined) return errorResponse(c, 400, "missing_field", { field: "title" });
        const paging = readPaging(c);
        if (!paging.ok) return paging.response;
        const list = await listBacklinksByTitle(c.env.DB, title, {
          ...paging.value,
          readable: readableVisibilityOf(c.get("principal")),
        });
        if (list === null) return errorResponse(c, 400, "invalid_field", { field: "title" });
        return c.json({ pages: list.pages, nextCursor: list.nextCursor });
      })
      // wikilink の解決に使う。応答は入力と同じ順、同じ件数で、解決できない title は page が null。
      // 匿名には draft も null で返し、存在しない title と区別させない。`/api/pages/:id` より前に登録する
      .get("/api/pages/resolve", allowAnonymousRead(), async (c) => {
        const titles = c.req.queries("title");
        if (titles === undefined) return errorResponse(c, 400, "missing_field", { field: "title" });
        if (titles.length > RESOLVE_MAX_TITLES) {
          return errorResponse(c, 400, "invalid_field", {
            field: "title",
            max: RESOLVE_MAX_TITLES,
          });
        }
        const pages = await resolvePagesByTitle(
          c.env.DB,
          titles,
          readableVisibilityOf(c.get("principal")),
        );
        return c.json({ results: titles.map((title, i) => ({ title, page: pages[i] ?? null })) });
      })
      // `/api/pages/:id` より前に登録する。後ろだと :id のハンドラが "recent" を id として先に 404 にする
      .get("/api/pages/recent", allowAnonymousRead(), async (c) => {
        const paging = readPaging(c);
        if (!paging.ok) return paging.response;
        const rawTag = c.req.query("tag");
        const tag = rawTag === undefined ? null : prepareTagFilter(rawTag);
        if (tag?.ok === false) {
          return errorResponse(c, 400, "invalid_field", {
            field: "tag",
            ...tagFilterErrorFields(tag.reason),
          });
        }
        // 匿名の draft の指定は 400 にせず、200 の空の一覧で返す。principal で応答の形を分けないので、
        // 匿名の draft の指定は存在しない tag の指定と同じに見える
        const visibility = c.req.query("visibility");
        if (visibility !== undefined && !isVisibility(visibility)) {
          return errorResponse(c, 400, "invalid_field", { field: "visibility" });
        }
        const readable = readableVisibilityOf(c.get("principal"));
        // 結果は必ず空なので DB を引かない。引くと合う行が無いまま生きている全行を読む
        if (readable === "public" && visibility === "draft") {
          return c.json({ pages: [], nextCursor: null });
        }
        const { pages, nextCursor } = await listRecentPages(c.env.DB, {
          ...paging.value,
          tagKey: tag?.key ?? null,
          visibility: visibility ?? null,
          readable,
        });
        return c.json({ pages, nextCursor });
      })
      // 抜粋とタグを返さない軽い一覧。`/api/pages/:id` より前に登録する
      .get("/api/pages/titles", allowAnonymousRead(), async (c) => {
        const paging = readPaging(c, TITLES_MAX_LIMIT);
        if (!paging.ok) return paging.response;
        const { pages, nextCursor } = await listPageTitles(c.env.DB, {
          ...paging.value,
          readable: readableVisibilityOf(c.get("principal")),
        });
        return c.json({ pages, nextCursor });
      })
      // visibility の扱いと、draft を読めない主体の draft の指定を DB を引かずに空で返す理由は
      // /api/pages/recent と同じ
      .get("/api/tags", allowAnonymousRead(), async (c) => {
        const visibility = c.req.query("visibility");
        if (visibility !== undefined && !isVisibility(visibility)) {
          return errorResponse(c, 400, "invalid_field", { field: "visibility" });
        }
        const readable = readableVisibilityOf(c.get("principal"));
        if (readable === "public" && visibility === "draft") return c.json({ tags: [] });
        const tags = await listTagCounts(c.env.DB, readable, visibility ?? null);
        return c.json({ tags });
      })
      .get("/api/search", allowAnonymousRead(), async (c) => {
        const raw = c.req.query("q");
        if (raw === undefined) return errorResponse(c, 400, "missing_field", { field: "q" });
        const query = prepareSearchQuery(raw);
        if (!query.ok) {
          return errorResponse(c, 400, "invalid_field", {
            field: "q",
            ...searchQueryErrorFields(query.reason),
          });
        }
        const principal = c.get("principal");
        if (
          principal.kind === "anonymous" &&
          searchQueryLength(query.query) < ANONYMOUS_SEARCH_MIN_CHARS
        ) {
          return errorResponse(c, 400, "query_too_short", {
            field: "q",
            min: ANONYMOUS_SEARCH_MIN_CHARS,
            message: `検索語が短すぎる（ログインしていない検索は ${ANONYMOUS_SEARCH_MIN_CHARS} 文字以上）`,
          });
        }
        const limit = readLimit(c, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
        if (!limit.ok) return limit.response;
        const results = await searchPages(
          c.env.DB,
          query.query,
          limit.value,
          readableVisibilityOf(principal),
        );
        return c.json({ results });
      })
      // draft も id を知っていれば読めるので、principal に関係なく visibility で絞らない
      .get("/api/pages/:id", allowAnonymousRead(), async (c) => {
        const page = await findPageByInputId(c.env.DB, c.req.param("id"));
        if (page === null) return c.notFound();
        return pageResponse(c, page);
      })
      .get("/api/pages/:id/backlinks", allowAnonymousRead(), async (c) => {
        const id = c.req.param("id");
        if (!isPageId(id)) return c.notFound();
        const paging = readPaging(c);
        if (!paging.ok) return paging.response;
        const list = await listBacklinks(c.env.DB, id, {
          ...paging.value,
          readable: readableVisibilityOf(c.get("principal")),
        });
        if (list === null) return c.notFound();
        return c.json({ pages: list.pages, nextCursor: list.nextCursor });
      })
      // 履歴は read の scope を持つ principal だけに出す。匿名は public のページでも 401 で、ページを引く前に
      // 断るので、id の有無や draft かどうかで応答が変わらない
      .get("/api/pages/:id/revisions", requireScope("read"), async (c) => {
        const id = c.req.param("id");
        if (!isPageId(id)) return c.notFound();
        const limit = readLimit(c, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
        if (!limit.ok) return limit.response;
        const rawCursor = c.req.query("cursor");
        const before = rawCursor === undefined ? null : parseRevisionCursor(rawCursor);
        if (before === null && rawCursor !== undefined) {
          return errorResponse(c, 400, "invalid_field", { field: "cursor" });
        }
        const list = await listRevisions(c.env.DB, id, {
          limit: limit.value,
          before,
          clientName: clientNameLookup(c.env, new URL(c.req.url).origin),
        });
        if (list === null) return c.notFound();
        return c.json(list);
      })
      .get("/api/pages/:id/revisions/:version", requireScope("read"), async (c) => {
        const id = c.req.param("id");
        const version = parseVersion(c.req.param("version"));
        if (!isPageId(id) || version === null) return c.notFound();
        const found = await findRevision(
          c.env.DB,
          id,
          version,
          clientNameLookup(c.env, new URL(c.req.url).origin),
        );
        if (!found.ok) {
          return found.reason === "page_not_found"
            ? c.notFound()
            : errorResponse(c, 404, "revision_not_found");
        }
        return c.json({ pageId: id, ...found.revision });
      })
      // 本文は読まない（戻す版は path、照合する版は If-Match で渡す）。PUT と同じく書き込める principal だけが呼べる
      .post("/api/pages/:id/revisions/:version/restore", requireScope("write"), async (c) => {
        const id = c.req.param("id");
        const version = parseVersion(c.req.param("version"));
        if (!isPageId(id) || version === null) return c.notFound();
        const ifMatch = requireIfMatch(c);
        if (!ifMatch.ok) return ifMatch.response;
        const result = await restoreRevisionAs(writeContext(c), {
          id,
          version,
          expectedVersion: ifMatch.version,
        });
        if (!result.ok) {
          return result.reason === "revision_not_found"
            ? errorResponse(c, 404, "revision_not_found")
            : writeErrorResponse(c, result);
        }
        return pageResponse(c, result.page);
      })
      .put("/api/pages/:id", requireScope("write"), async (c) => {
        const id = c.req.param("id");
        if (!isPageId(id)) return c.notFound();
        const ifMatch = requireIfMatch(c);
        if (!ifMatch.ok) return ifMatch.response;
        const parsed = await readJsonBody(c, { title: "string", body: "string" }, [
          "title",
          "body",
        ]);
        if (!parsed.ok) return parsed.response;
        const result = await updatePageAs(writeContext(c), {
          id,
          expectedVersion: ifMatch.version,
          title: parsed.value.title as string,
          body: parsed.value.body as string,
        });
        if (!result.ok) return writeErrorResponse(c, result);
        return pageResponse(c, result.page, 200, linkRewritesField(result));
      })
      .post("/api/pages/:id/append", requireScope("write"), async (c) => {
        const id = c.req.param("id");
        if (!isPageId(id)) return c.notFound();
        const parsed = await readJsonBody(c, { text: "string" }, ["text"]);
        if (!parsed.ok) return parsed.response;
        const text = parsed.value.text as string;
        if (text === "") return errorResponse(c, 400, "invalid_field", { field: "text" });
        const result = await appendToPageAs(writeContext(c), { id, text });
        if (!result.ok) return writeErrorResponse(c, result);
        return pageResponse(c, result.page);
      })
      // owner だけが呼べる。token と MCP からは scope に関係なく変えられないようにし、
      // プロンプトインジェクションで draft が公開される経路を塞ぐ
      .put("/api/pages/:id/visibility", requireOwner(), async (c) => {
        const id = c.req.param("id");
        if (!isPageId(id)) return c.notFound();
        const parsed = await readJsonObject(c);
        if (!parsed.ok) return parsed.response;
        for (const key of Object.keys(parsed.value)) {
          if (key !== "visibility") {
            return errorResponse(c, 400, "unknown_field", { field: key });
          }
        }
        const visibility = parsed.value.visibility;
        if (visibility === undefined) {
          return errorResponse(c, 400, "missing_field", { field: "visibility" });
        }
        if (!isVisibility(visibility)) {
          return errorResponse(c, 400, "invalid_field", { field: "visibility" });
        }
        // If-Match は任意。付いていれば、確かめた版と違う本文を公開しないよう照合する
        const ifMatch = parseIfMatch(c.req.header("If-Match"));
        if (ifMatch.kind === "invalid") return errorResponse(c, 400, "invalid_if_match");
        const result = await setVisibilityAs(
          writeContext(c),
          ifMatch.kind === "version"
            ? { id, visibility, expectedVersion: ifMatch.version }
            : { id, visibility },
        );
        if (!result.ok) return writeErrorResponse(c, result);
        return pageResponse(c, result.page);
      })
      .delete("/api/pages/:id", requireScope("write"), async (c) => {
        const id = c.req.param("id");
        if (!isPageId(id)) return c.notFound();
        const ifMatch = requireIfMatch(c);
        if (!ifMatch.ok) return ifMatch.response;
        const actor = actorOf(c.get("principal"));
        const result = await deletePage(c.env.DB, {
          id,
          expectedVersion: ifMatch.version,
          actor,
          now: now(),
        });
        if (!result.ok) return writeErrorResponse(c, result);
        recordWrite({ op: "delete", actor, pageId: id, rowsWritten: result.rowsWritten });
        return c.body(null, 204);
      })
      // title の変更で積んだリンクの書き換えを 1 ページ分進める（pages/link-rewrites.ts）。応答は
      // draft のリンク元の id と title を含みうるので、書き込める principal だけが呼べる。
      // remaining が 0 になるまで繰り返す。conflict ならそのまま呼び直せばよい
      .post("/api/link-rewrites/step", requireScope("write"), async (c) => {
        const parsed = await readJsonBody(c, { targetPageId: "string" }, []);
        if (!parsed.ok) return parsed.response;
        const targetPageId = (parsed.value.targetPageId as string | undefined) ?? null;
        if (targetPageId !== null && !isPageId(targetPageId)) {
          return errorResponse(c, 400, "invalid_field", { field: "targetPageId" });
        }
        return c.json(await stepLinkRewritesAs(writeContext(c), { targetPageId }));
      })
  );
}

/**
 * 管理用のルート。派生データの作り直しは冪等で、ページの内容も版も変えないので write の scope で許す
 * （owner も通る）。owner 専用にしないのは、作り直しを呼ぶのがスクリプトで、write の token は
 * ページの保存で同じだけ書き込み枠を使えるため、owner に限っても守れるものが増えないから。
 *
 * 作り直しは CPU 10ms に収まるよう 1 ページずつ進む。全ページを作り直すには、応答の next を
 * 次のリクエストの after に渡し、next が null になるまで繰り返す:
 *   POST /api/admin/derived/rebuild  {"after": null}
 *   → {"rebuilt": 1, "skipped": 0, "failed": [], "next": "<id>", "rowsWritten": 9}
 * failed に入ったページは派生データが古いまま残る。応答が返らない場合は rebuildDerived を参照。
 */
export function registerAdminRoutes(
  app: Hono<AppEnv>,
  { recordWrite }: Pick<PagesRoutesOptions, "recordWrite">,
) {
  return app.post("/api/admin/derived/rebuild", requireScope("write"), async (c) => {
    const parsed = await readJsonBody(c, { after: "string_or_null", limit: "number" }, []);
    if (!parsed.ok) return parsed.response;
    const after = (parsed.value.after as string | null | undefined) ?? null;
    const limit = (parsed.value.limit as number | undefined) ?? 1;
    if (!Number.isInteger(limit) || limit < 1 || limit > REBUILD_MAX_LIMIT) {
      return errorResponse(c, 400, "invalid_field", { field: "limit", max: REBUILD_MAX_LIMIT });
    }
    const result = await rebuildDerived(c.env.DB, { after, limit });
    recordWrite({
      op: "rebuild",
      actor: actorOf(c.get("principal")),
      rowsWritten: result.rowsWritten,
      failed: result.failed,
    });
    return c.json(result);
  });
}
