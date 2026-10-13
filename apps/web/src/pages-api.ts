export type Visibility = "public" | "draft";

export interface Page {
  id: string;
  title: string;
  body: string;
  visibility: Visibility;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface PageSummary {
  id: string;
  title: string;
  visibility: Visibility;
  updatedAt: number;
}

/** 最近の更新の 1 件。 */
export interface ListedPage extends PageSummary {
  /**
   * 本文の先頭 120 文字の抜粋。保存時に作る派生データで、それ以前に作ったページと本文が空のページには無い。
   */
  excerpt?: string;
  /** タグの表記。本文に最初に現れた表記で、tag_key の順 */
  tags: string[];
}

/** 検索結果の 1 件。ListedPage に代入できる（一覧の行は同じ部品で描く）。 */
export interface SearchHit extends PageSummary {
  /** 一致した位置の周辺 64 文字の抜粋。ListedPage.excerpt（先頭 120 文字）と違い、検索語が当たった箇所を見せる。 */
  excerpt: string;
  tags: string[];
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface PageList<T extends PageSummary = PageSummary> {
  pages: T[];
  nextCursor: string | null;
}

/** 呼び出し側が分岐する失敗だけを区別する。それ以外は message を表示するだけでよい。 */
export type ApiFailure =
  | { ok: false; reason: "unauthorized" }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "version_conflict"; currentVersion: number | null }
  | { ok: false; reason: "title_conflict"; message: string }
  | { ok: false; reason: "error"; message: string };

/** 画面に出す失敗の説明。version_conflict などは呼び出し側が分岐するので、ここでは汎用の文にする。 */
export function failureMessage(failure: ApiFailure, fallback: string): string {
  return failure.reason === "error" || failure.reason === "title_conflict"
    ? failure.message
    : fallback;
}

export type ApiResult<T> = { ok: true; value: T } | ApiFailure;

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * 同一オリジンで飛行中の keepalive の本文は合計 64 KiB までで、超えると fetch が失敗する。
 * 複数のタブやページの保存が重なる余裕を見て、1 件は 60,000 バイトまでにし、超えたら通常の fetch にする。
 */
const KEEPALIVE_MAX_BYTES = 60_000;

const ERROR_MESSAGES: Record<string, string> = {
  invalid_title: "title が空か、空白だけになっている",
  title_too_long: "title が長すぎる",
  body_too_large: "本文が大きすぎて保存できない",
  if_match_required: "版の指定が欠けている",
  invalid_if_match: "版の指定が正しくない",
  invalid_json: "リクエストの形が正しくない",
  unknown_field: "リクエストの形が正しくない",
  missing_field: "リクエストの形が正しくない",
  invalid_field: "リクエストの形が正しくない",
};

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

async function failureOf(res: Response): Promise<ApiFailure> {
  if (res.status === 401) return { ok: false, reason: "unauthorized" };
  if (res.status === 404) return { ok: false, reason: "not_found" };
  const body = recordOf(await readJson(res));
  const code = typeof body.error === "string" ? body.error : "";
  if (res.status === 409 && code === "version_conflict") {
    const current = body.currentVersion;
    return {
      ok: false,
      reason: "version_conflict",
      currentVersion: typeof current === "number" ? current : null,
    };
  }
  if (res.status === 409 && code === "title_conflict") {
    return { ok: false, reason: "title_conflict", message: "同じ title のページがすでにある" };
  }
  // サーバーの message は原因を具体的に書いている（検索語の誤りなど）ので、固定の文より優先する
  const message =
    (typeof body.message === "string" ? body.message : undefined) ??
    ERROR_MESSAGES[code] ??
    `サーバーが ${res.status} を返した`;
  return { ok: false, reason: "error", message };
}

function isPage(value: unknown): value is Page {
  const v = recordOf(value);
  return (
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    typeof v.body === "string" &&
    (v.visibility === "public" || v.visibility === "draft") &&
    typeof v.version === "number" &&
    typeof v.createdAt === "number" &&
    typeof v.updatedAt === "number"
  );
}

function isSummary(value: unknown): value is PageSummary {
  const v = recordOf(value);
  return (
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    (v.visibility === "public" || v.visibility === "draft") &&
    typeof v.updatedAt === "number"
  );
}

const isTags = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((t) => typeof t === "string");

function isListedPage(value: unknown): value is ListedPage {
  const v = recordOf(value);
  return (
    isSummary(value) && isTags(v.tags) && (v.excerpt === undefined || typeof v.excerpt === "string")
  );
}

function isSearchHit(value: unknown): value is SearchHit {
  const v = recordOf(value);
  return isSummary(value) && isTags(v.tags) && typeof v.excerpt === "string";
}

const BAD_SHAPE: ApiFailure = {
  ok: false,
  reason: "error",
  message: "サーバーの応答の形が想定と違う",
};

/** 通信の失敗（オフラインなど）を ApiFailure にそろえる。 */
async function request(
  fetchFn: Fetch,
  path: string,
  init: RequestInit = {},
): Promise<Response | ApiFailure> {
  try {
    return await fetchFn(path, { credentials: "same-origin", cache: "no-store", ...init });
  } catch {
    return { ok: false, reason: "error", message: "サーバーに接続できない" };
  }
}

const isFailure = (value: Response | ApiFailure): value is ApiFailure =>
  !(value instanceof Response);

async function pageResult(res: Response | ApiFailure): Promise<ApiResult<Page>> {
  if (isFailure(res)) return res;
  if (!res.ok) return failureOf(res);
  const json = await readJson(res);
  return isPage(json) ? { ok: true, value: json } : BAD_SHAPE;
}

const jsonInit = (method: string, body: unknown, extra: RequestInit = {}): RequestInit => ({
  method,
  ...extra,
  headers: { "Content-Type": "application/json", ...(extra.headers as object | undefined) },
  body: JSON.stringify(body),
});

/** If-Match は取得時の ETag と同じ形（`"3"`）で送る。 */
const ifMatch = (version: number) => ({ "If-Match": `"${version}"` });

export async function getPage(id: string, fetchFn: Fetch = fetch): Promise<ApiResult<Page>> {
  return pageResult(await request(fetchFn, `/api/pages/${encodeURIComponent(id)}`));
}

export async function findPageByTitle(
  title: string,
  fetchFn: Fetch = fetch,
): Promise<ApiResult<Page>> {
  return pageResult(
    await request(fetchFn, `/api/pages/by-title?title=${encodeURIComponent(title)}`),
  );
}

export async function createPage(
  input: { title: string; body: string },
  fetchFn: Fetch = fetch,
): Promise<ApiResult<Page>> {
  return pageResult(await request(fetchFn, "/api/pages", jsonInit("POST", input)));
}

export interface UpdateOptions {
  /** ページを離れる途中の保存で、fetch が中断されないようにする。 */
  keepalive?: boolean;
}

export async function updatePage(
  id: string,
  version: number,
  input: { title: string; body: string },
  options: UpdateOptions = {},
  fetchFn: Fetch = fetch,
): Promise<ApiResult<Page>> {
  const payload = JSON.stringify(input);
  const keepalive =
    options.keepalive === true && new TextEncoder().encode(payload).length <= KEEPALIVE_MAX_BYTES;
  return pageResult(
    await request(fetchFn, `/api/pages/${encodeURIComponent(id)}`, {
      ...jsonInit("PUT", input, { headers: ifMatch(version) }),
      keepalive,
    }),
  );
}

export async function setVisibility(
  id: string,
  version: number,
  visibility: Visibility,
  fetchFn: Fetch = fetch,
): Promise<ApiResult<Page>> {
  return pageResult(
    await request(
      fetchFn,
      `/api/pages/${encodeURIComponent(id)}/visibility`,
      jsonInit("PUT", { visibility }, { headers: ifMatch(version) }),
    ),
  );
}

/** DELETE も cookie 付きの変更系なので、JSON の Content-Type と本文を付ける（CSRF 対策）。 */
export async function deletePage(
  id: string,
  version: number,
  fetchFn: Fetch = fetch,
): Promise<ApiResult<null>> {
  const res = await request(
    fetchFn,
    `/api/pages/${encodeURIComponent(id)}`,
    jsonInit("DELETE", {}, { headers: ifMatch(version) }),
  );
  if (isFailure(res)) return res;
  if (!res.ok) return failureOf(res);
  return { ok: true, value: null };
}

async function listResult<T extends PageSummary>(
  res: Response | ApiFailure,
  guard: (value: unknown) => value is T,
): Promise<ApiResult<PageList<T>>> {
  if (isFailure(res)) return res;
  if (!res.ok) return failureOf(res);
  const json = recordOf(await readJson(res));
  if (!Array.isArray(json.pages) || !json.pages.every(guard)) return BAD_SHAPE;
  const next = json.nextCursor;
  if (next !== null && typeof next !== "string") return BAD_SHAPE;
  return { ok: true, value: { pages: json.pages, nextCursor: next } };
}

export async function listRecent(
  cursor: string | null,
  options: { tag?: string; limit?: number } = {},
  fetchFn: Fetch = fetch,
): Promise<ApiResult<PageList<ListedPage>>> {
  const params = new URLSearchParams();
  if (cursor !== null) params.set("cursor", cursor);
  if (options.tag !== undefined && options.tag !== "") params.set("tag", options.tag);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.size === 0 ? "" : `?${params}`;
  return listResult(await request(fetchFn, `/api/pages/recent${query}`), isListedPage);
}

export async function listTags(fetchFn: Fetch = fetch): Promise<ApiResult<TagCount[]>> {
  const res = await request(fetchFn, "/api/tags");
  if (isFailure(res)) return res;
  if (!res.ok) return failureOf(res);
  const tags = recordOf(await readJson(res)).tags;
  if (
    !Array.isArray(tags) ||
    !tags.every((t) => typeof recordOf(t).tag === "string" && typeof recordOf(t).count === "number")
  ) {
    return BAD_SHAPE;
  }
  return { ok: true, value: tags as TagCount[] };
}

export async function listBacklinks(
  id: string,
  cursor: string | null,
  fetchFn: Fetch = fetch,
): Promise<ApiResult<PageList>> {
  const query = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  return listResult(
    await request(fetchFn, `/api/pages/${encodeURIComponent(id)}/backlinks${query}`),
    isSummary,
  );
}

/** 3 文字以上は FTS、2 文字以下は LIKE という振り分けは API が行う。 */
export async function searchPages(
  query: string,
  fetchFn: Fetch = fetch,
): Promise<ApiResult<SearchHit[]>> {
  const res = await request(fetchFn, `/api/search?q=${encodeURIComponent(query)}&limit=50`);
  if (isFailure(res)) return res;
  if (!res.ok) return failureOf(res);
  const json = recordOf(await readJson(res));
  const results = json.results;
  if (!Array.isArray(results) || !results.every(isSearchHit)) return BAD_SHAPE;
  return { ok: true, value: results };
}
