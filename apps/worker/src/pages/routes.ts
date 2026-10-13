import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { requireToken } from "../auth/middleware";
import type { AppEnv } from "../env";
import { isPageId } from "./id";
import { actorOf } from "./revisions";
import {
  type Cursor,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  listBacklinks,
  listRecentPages,
  parseCursor,
  prepareSearchQuery,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  searchPages,
} from "./search";
import {
  type AppendError,
  appendToPage,
  createPage,
  deletePage,
  findPageById,
  findPageByTitle,
  MAX_BODY_BYTES,
  MAX_TITLE_BYTES,
  type Page,
  REBUILD_MAX_LIMIT,
  rebuildDerived,
  updatePage,
  type WriteError,
} from "./store";

/**
 * 書き込み 1 回分の計測値。D1 の書き込み行数（無料枠 10 万行/日）を保存 1 回あたりで集計し、
 * どの actor がどのページに書いたかを後から追えるようにする。本文は含めない。
 */
export interface WriteMetric {
  op: "create" | "update" | "append" | "delete" | "rebuild";
  /** revisions.actor と同じ形式 */
  actor: string;
  /** 書いたページ。作り直しは 1 回で複数ページを扱いうるので付けない */
  pageId?: string;
  rowsWritten: number;
  /** 追記で版の競合により読み直した場合の試行回数 */
  attempts?: number;
  /** 作り直しで失敗したページの id */
  failed?: string[];
}

export interface PagesRoutesOptions {
  now: () => number;
  recordWrite: (metric: WriteMetric) => void;
}

type PagesContext = Context<AppEnv>;

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

function pageResponse(c: PagesContext, page: Page, status: 200 | 201 = 200): Response {
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
    },
    status,
  );
}

function writeErrorResponse(
  c: PagesContext,
  error: WriteError | AppendError,
): Response | Promise<Response> {
  switch (error.reason) {
    case "invalid_title":
      return errorResponse(c, 400, "invalid_title", {
        message: "title が空か、空白だけになっている",
      });
    case "title_too_long":
      return errorResponse(c, 400, "title_too_long", { max: MAX_TITLE_BYTES });
    case "body_too_large":
      return errorResponse(c, 413, "body_too_large", { max: MAX_BODY_BYTES });
    case "not_found":
      return c.notFound();
    case "version_conflict":
      return errorResponse(c, 409, "version_conflict", {
        message: "版が合わない。最新版を読み直してから保存し直す",
        currentVersion: error.currentVersion,
      });
    case "title_conflict":
      return errorResponse(c, 409, "title_conflict", {
        message: "同じ title のページがすでにある",
      });
    case "append_conflict":
      return errorResponse(c, 409, "append_conflict", {
        message: "他の保存と競合し続けた。同じ追記をそのまま送り直してよい",
      });
  }
}

/**
 * JSON を解析する前に Content-Length で拒む上限。巨大な JSON の解析で CPU を使い切らないようにする。
 * 正当なリクエストを拒まないよう、title と本文を上限まで入れ、全文字を JSON の最長のエスケープ
 * （制御文字の \u00XX で 1 バイトが 6 バイト）にした大きさに、キーと記号の分を足して決める。
 * Content-Length の無いリクエストは解析後の本文の検査に任せる。
 */
const MAX_REQUEST_BYTES = (MAX_TITLE_BYTES + MAX_BODY_BYTES) * 6 + 1024;

type FieldSpec = Record<string, "string" | "number" | "string_or_null">;

type ParsedBody = { ok: true; value: Record<string, unknown> } | { ok: false; response: Response };

/**
 * JSON の object を読み、spec に無いキーを拒む。
 * 黙って捨てると、AI が `content` などの誤ったキーで送ったり、visibility を変えたつもりになったりしても
 * 気づけないので 400 にする。visibility は owner だけが変えられる。
 */
async function readJsonBody(
  c: PagesContext,
  spec: FieldSpec,
  required: readonly string[],
): Promise<ParsedBody> {
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
  const value = json as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (key === "visibility") {
      return {
        ok: false,
        response: errorResponse(c, 400, "visibility_not_allowed", {
          message: "visibility は API から変えられない。ページは draft で作られる",
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
function readPaging(c: PagesContext): Parsed<{ limit: number; cursor: Cursor | null }> {
  const limit = readLimit(c, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
  if (!limit.ok) return limit;
  const cursor = readCursor(c);
  if (!cursor.ok) return cursor;
  return { ok: true, value: { limit: limit.value, cursor: cursor.value } };
}

/**
 * `/api/pages` のルートを app に登録する。token principal だけを受け付ける（owner と anonymous の
 * 経路は別の Work Item）。ページの id は形式が違えば D1 を引かずに 404 にする。
 *
 * 認可の宣言はハンドラと同じ method・path の登録に、ハンドラより前に付ける。子の app を route() で
 * 合成したり、prefix の use() で一括に掛けたりすると、宣言の検査がルートを見つけられない。
 */
export function registerPageRoutes(app: Hono<AppEnv>, { now, recordWrite }: PagesRoutesOptions) {
  return (
    app
      .post("/api/pages", requireToken("write"), async (c) => {
        const parsed = await readJsonBody(c, { title: "string", body: "string" }, [
          "title",
          "body",
        ]);
        if (!parsed.ok) return parsed.response;
        const actor = actorOf(c.get("principal"));
        const result = await createPage(c.env.DB, {
          title: parsed.value.title as string,
          body: parsed.value.body as string,
          actor,
          now: now(),
        });
        if (!result.ok) return writeErrorResponse(c, result);
        recordWrite({
          op: "create",
          actor,
          pageId: result.page.id,
          rowsWritten: result.rowsWritten,
        });
        c.header("Location", `/api/pages/${result.page.id}`);
        return pageResponse(c, result.page, 201);
      })
      // title は `/` や `#` を含みうるので、パスに埋め込まずクエリで受け取る
      .get("/api/pages/by-title", requireToken("read"), async (c) => {
        const title = c.req.query("title");
        if (title === undefined) return errorResponse(c, 400, "missing_field", { field: "title" });
        const page = await findPageByTitle(c.env.DB, title);
        if (page === null) return c.notFound();
        return pageResponse(c, page);
      })
      // `/api/pages/:id` より前に登録する。後ろだと :id のハンドラが "recent" を id として先に 404 にする
      .get("/api/pages/recent", requireToken("read"), async (c) => {
        const paging = readPaging(c);
        if (!paging.ok) return paging.response;
        const { pages, nextCursor } = await listRecentPages(c.env.DB, paging.value);
        return c.json({ pages, nextCursor });
      })
      .get("/api/search", requireToken("read"), async (c) => {
        const raw = c.req.query("q");
        if (raw === undefined) return errorResponse(c, 400, "missing_field", { field: "q" });
        const query = prepareSearchQuery(raw);
        if (!query.ok) {
          return errorResponse(c, 400, "invalid_field", {
            field: "q",
            message: query.reason === "empty" ? "q が空か、空白だけになっている" : "q が長すぎる",
          });
        }
        const limit = readLimit(c, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
        if (!limit.ok) return limit.response;
        return c.json({ results: await searchPages(c.env.DB, query.query, limit.value) });
      })
      .get("/api/pages/:id", requireToken("read"), async (c) => {
        const id = c.req.param("id");
        const page = isPageId(id) ? await findPageById(c.env.DB, id) : null;
        if (page === null) return c.notFound();
        return pageResponse(c, page);
      })
      .get("/api/pages/:id/backlinks", requireToken("read"), async (c) => {
        const id = c.req.param("id");
        if (!isPageId(id)) return c.notFound();
        const paging = readPaging(c);
        if (!paging.ok) return paging.response;
        const list = await listBacklinks(c.env.DB, id, paging.value);
        if (list === null) return c.notFound();
        return c.json({ pages: list.pages, nextCursor: list.nextCursor });
      })
      .put("/api/pages/:id", requireToken("write"), async (c) => {
        const id = c.req.param("id");
        if (!isPageId(id)) return c.notFound();
        const ifMatch = requireIfMatch(c);
        if (!ifMatch.ok) return ifMatch.response;
        const parsed = await readJsonBody(c, { title: "string", body: "string" }, [
          "title",
          "body",
        ]);
        if (!parsed.ok) return parsed.response;
        const actor = actorOf(c.get("principal"));
        const result = await updatePage(c.env.DB, {
          id,
          expectedVersion: ifMatch.version,
          title: parsed.value.title as string,
          body: parsed.value.body as string,
          actor,
          now: now(),
        });
        if (!result.ok) return writeErrorResponse(c, result);
        recordWrite({ op: "update", actor, pageId: id, rowsWritten: result.rowsWritten });
        return pageResponse(c, result.page);
      })
      .post("/api/pages/:id/append", requireToken("write"), async (c) => {
        const id = c.req.param("id");
        if (!isPageId(id)) return c.notFound();
        const parsed = await readJsonBody(c, { text: "string" }, ["text"]);
        if (!parsed.ok) return parsed.response;
        const text = parsed.value.text as string;
        if (text === "") return errorResponse(c, 400, "invalid_field", { field: "text" });
        const actor = actorOf(c.get("principal"));
        const result = await appendToPage(c.env.DB, { id, text, actor, now: now() });
        if (!result.ok) return writeErrorResponse(c, result);
        recordWrite({
          op: "append",
          actor,
          pageId: id,
          rowsWritten: result.rowsWritten,
          attempts: result.attempts,
        });
        return pageResponse(c, result.page);
      })
      .delete("/api/pages/:id", requireToken("write"), async (c) => {
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
  );
}

/**
 * 管理用のルート。派生データの作り直しは冪等で、ページの内容も版も変えないので write の scope で許す。
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
  return app.post("/api/admin/derived/rebuild", requireToken("write"), async (c) => {
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
