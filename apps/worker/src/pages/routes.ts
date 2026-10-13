import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { requireToken } from "../auth/middleware";
import type { AppEnv } from "../env";
import { isPageId } from "./id";
import { actorOf } from "./revisions";
import {
  type AppendError,
  appendToPage,
  createPage,
  deletePage,
  findPageById,
  findPageByTitle,
  type Page,
  updatePage,
  type WriteError,
} from "./store";

/** 書き込み 1 回分の計測値。D1 の書き込み行数（無料枠 10 万行/日）を保存 1 回あたりで集計するために出す。 */
export interface WriteMetric {
  op: "create" | "update" | "append" | "delete";
  rowsWritten: number;
  /** 追記で版の競合により読み直した場合の試行回数 */
  attempts?: number;
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

function writeErrorResponse(c: PagesContext, error: WriteError | AppendError): Response {
  switch (error.reason) {
    case "invalid_title":
      return errorResponse(c, 400, "invalid_title", {
        message: "title が空か、空白だけになっている",
      });
    case "body_too_large":
      return errorResponse(c, 413, "body_too_large");
    case "not_found":
      return errorResponse(c, 404, "not_found");
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
        const result = await createPage(c.env.DB, {
          title: parsed.value.title as string,
          body: parsed.value.body as string,
          actor: actorOf(c.get("principal")),
          now: now(),
        });
        if (!result.ok) return writeErrorResponse(c, result);
        recordWrite({ op: "create", rowsWritten: result.rowsWritten });
        c.header("Location", `/api/pages/${result.page.id}`);
        return pageResponse(c, result.page, 201);
      })
      // title は `/` や `#` を含みうるので、パスに埋め込まずクエリで受け取る
      .get("/api/pages/by-title", requireToken("read"), async (c) => {
        const title = c.req.query("title");
        if (title === undefined) return errorResponse(c, 400, "missing_field", { field: "title" });
        const page = await findPageByTitle(c.env.DB, title);
        if (page === null) return errorResponse(c, 404, "not_found");
        return pageResponse(c, page);
      })
      .get("/api/pages/:id", requireToken("read"), async (c) => {
        const id = c.req.param("id");
        const page = isPageId(id) ? await findPageById(c.env.DB, id) : null;
        if (page === null) return errorResponse(c, 404, "not_found");
        return pageResponse(c, page);
      })
      .put("/api/pages/:id", requireToken("write"), async (c) => {
        const id = c.req.param("id");
        if (!isPageId(id)) return errorResponse(c, 404, "not_found");
        const ifMatch = requireIfMatch(c);
        if (!ifMatch.ok) return ifMatch.response;
        const parsed = await readJsonBody(c, { title: "string", body: "string" }, [
          "title",
          "body",
        ]);
        if (!parsed.ok) return parsed.response;
        const result = await updatePage(c.env.DB, {
          id,
          expectedVersion: ifMatch.version,
          title: parsed.value.title as string,
          body: parsed.value.body as string,
          actor: actorOf(c.get("principal")),
          now: now(),
        });
        if (!result.ok) return writeErrorResponse(c, result);
        recordWrite({ op: "update", rowsWritten: result.rowsWritten });
        return pageResponse(c, result.page);
      })
      .post("/api/pages/:id/append", requireToken("write"), async (c) => {
        const id = c.req.param("id");
        if (!isPageId(id)) return errorResponse(c, 404, "not_found");
        const parsed = await readJsonBody(c, { text: "string" }, ["text"]);
        if (!parsed.ok) return parsed.response;
        const text = parsed.value.text as string;
        if (text === "") return errorResponse(c, 400, "invalid_field", { field: "text" });
        const result = await appendToPage(c.env.DB, {
          id,
          text,
          actor: actorOf(c.get("principal")),
          now: now(),
        });
        if (!result.ok) return writeErrorResponse(c, result);
        recordWrite({ op: "append", rowsWritten: result.rowsWritten, attempts: result.attempts });
        return pageResponse(c, result.page);
      })
      .delete("/api/pages/:id", requireToken("write"), async (c) => {
        const id = c.req.param("id");
        if (!isPageId(id)) return errorResponse(c, 404, "not_found");
        const ifMatch = requireIfMatch(c);
        if (!ifMatch.ok) return ifMatch.response;
        const result = await deletePage(c.env.DB, {
          id,
          expectedVersion: ifMatch.version,
          now: now(),
        });
        if (!result.ok) return writeErrorResponse(c, result);
        recordWrite({ op: "delete", rowsWritten: result.rowsWritten });
        return c.body(null, 204);
      })
  );
}
