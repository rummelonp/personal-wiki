import {
  findControlChar,
  findNul,
  MAX_BODY_BYTES,
  MAX_TITLE_BYTES,
  type PageInputProblem,
  utf8ByteLength,
} from "@personal-wiki/domain/page-input";
import { SEARCH_MAX_QUERY_CHARS } from "@personal-wiki/domain/search";
import { singleLineTitle } from "@personal-wiki/domain/title";
import { formatCount, inputProblemMessage } from "./input-messages";

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

/** title_conflict で、同じ title とみなされたページ。読める範囲に無ければサーバーは返さない。 */
export interface ExistingPage {
  id: string;
  title: string;
  visibility: Visibility;
}

/** 呼び出し側が分岐する失敗だけを区別する。それ以外は message を表示するだけでよい。 */
export type ApiFailure =
  | { ok: false; reason: "unauthorized" }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "version_conflict"; currentVersion: number | null }
  | { ok: false; reason: "title_conflict"; message: string; existing?: ExistingPage }
  /**
   * 送った title か本文が保存の規則に合わない。直さない限り何度送っても通らないので、再試行を勧めない。
   * problem は応答から組み立て直した問題で、位置を求められない応答では null。
   */
  | { ok: false; reason: "invalid_input"; problem: PageInputProblem | null; message: string }
  | { ok: false; reason: "error"; message: string };

/** 画面に出す失敗の説明。version_conflict などは呼び出し側が分岐するので、ここでは汎用の文にする。 */
export function failureMessage(failure: ApiFailure, fallback: string): string {
  return failure.reason === "error" ||
    failure.reason === "title_conflict" ||
    failure.reason === "invalid_input"
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

/*
 * 画面に出す失敗の文は、何が起きたかと次の手を、です・ます調の完結した文で書く。
 * 通信やサーバーの不調は、時間をおけば通ることがあるので再試行を勧める。入力の誤りは、直す点を示す。
 */
const RETRY_LATER = "時間をおいて、もう一度試してください。";
const RELOAD = "ページを再読み込みしてから、もう一度試してください。";

/**
 * failureMessage の fallback に渡す、取得の失敗の文。message を持たない失敗は待てば通ることが多い。
 * 「取得できませんでした」は通知の見出しが伝える。
 */
export const LOAD_FAILED = RETRY_LATER;

/**
 * web が正しく組んでいれば起きない誤り。利用者に直せる点は無く、web の版がサーバーと食い違っている
 * ことが多いので、読み込み直しを勧める。
 */
const NOT_ACCEPTED = `サーバーに受け付けられませんでした。${RELOAD}`;

const ERROR_MESSAGES: Record<string, string> = {
  if_match_required: NOT_ACCEPTED,
  invalid_if_match: NOT_ACCEPTED,
  invalid_json: NOT_ACCEPTED,
  unknown_field: NOT_ACCEPTED,
  missing_field: NOT_ACCEPTED,
  invalid_field: NOT_ACCEPTED,
};

/**
 * 既知の code が無いときの文。5xx と 429 は待てば通ることがあり、それ以外の 4xx は待っても変わらない。
 * 429 は障害ではなく混雑による制限なので、文を分ける。番号は 429 では言葉で足りるので出さず、
 * ほかは原因を調べる手がかりとして残す。
 */
function statusMessage(status: number): string {
  if (status === 429) {
    return "一時的にアクセスが制限されています。少し待ってから、もう一度試してください。";
  }
  return status >= 500
    ? `サーバーで問題が起きました（HTTP ${status}）。${RETRY_LATER}`
    : `サーバーに受け付けられませんでした（HTTP ${status}）。${RELOAD}`;
}

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

const numberOf = (value: unknown): number | null => (typeof value === "number" ? value : null);

const invalidInput = (problem: PageInputProblem | null, message?: string): ApiFailure => ({
  ok: false,
  reason: "invalid_input",
  problem,
  message: problem === null ? (message ?? NOT_ACCEPTED) : inputProblemMessage(problem),
});

/**
 * 作成と保存の入力の誤りを、送る前の検査と同じ問題の形に組み立て直す。入力の誤りでなければ null。
 *
 * 位置は送った内容から求め直す。応答の line と column は人に伝える値で、エディタの位置（UTF-16 の
 * index）を持たない。数え方もエディタの行と違いうる（対の無い `\r` を改行と数えない）。
 * 応答に actual や max が無い（前の版の Worker）ときは、送った内容と domain の上限で補う。
 */
function inputFailureOf(
  code: string,
  body: Record<string, unknown>,
  sent: SentPage,
): ApiFailure | null {
  switch (code) {
    case "invalid_title":
      return invalidInput({ reason: "invalid_title" });
    case "title_too_long": {
      const bytes = numberOf(body.actual) ?? utf8ByteLength(singleLineTitle(sent.title));
      const max = numberOf(body.max) ?? MAX_TITLE_BYTES;
      return invalidInput({ reason: "title_too_long", bytes, max });
    }
    case "body_too_large": {
      // Content-Length で断った 413 は actual を持たない。送った本文が上限以下なら、本文の長さでは
      // 説明できないので位置の無い文にする
      const max = numberOf(body.max) ?? MAX_BODY_BYTES;
      const bytes = numberOf(body.actual) ?? utf8ByteLength(sent.body);
      return invalidInput(
        bytes > max ? { reason: "body_too_large", bytes, max } : null,
        "本文が大きすぎて保存できません。本文を短くするか、ページを分けてください。",
      );
    }
    case "invalid_field": {
      if (body.reason !== "control_char") return null;
      const field = body.field === "title" ? "title" : "body";
      const at =
        field === "title" ? findControlChar(singleLineTitle(sent.title)) : findNul(sent.body);
      return invalidInput(
        at === null ? null : { reason: "control_char", field, at },
        field === "title"
          ? "タイトルに見えない文字が入っていて保存できません。その文字を消してください。"
          : "本文に見えない文字（NUL）が入っていて保存できません。その文字を消してください。",
      );
    }
    default:
      return null;
  }
}

/** 一覧をタグで絞る指定の誤り。URL を手で書き換えたときに起きるので、読み込み直しを勧めない。 */
function tagFailureOf(code: string, body: Record<string, unknown>): ApiFailure | null {
  if (code !== "invalid_field" || body.field !== "tag") return null;
  const max = numberOf(body.max);
  const message =
    body.reason === "too_long"
      ? `タグが長すぎます${max === null ? "" : `（${formatCount(max)} 文字まで）`}。タグを選び直してください。`
      : "タグが空か、「#」だけです。タグを選び直してください。";
  return { ok: false, reason: "error", message };
}

function existingOf(value: unknown): ExistingPage | undefined {
  if (!isResolvedPage(value)) return undefined;
  return { id: value.id, title: value.title, visibility: value.visibility };
}

/** 作成と保存で送った内容。入力の誤りの位置を求め直すのに使う。 */
interface SentPage {
  title: string;
  body: string;
}

async function failureOf(res: Response, sent?: SentPage): Promise<ApiFailure> {
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
    const existing = existingOf(body.existing);
    return {
      ok: false,
      reason: "title_conflict",
      message: "同じタイトルのページがすでにあります。",
      ...(existing === undefined ? {} : { existing }),
    };
  }
  // 入力の誤りは書き込みの応答でだけ読む。送った内容が無いと位置を求め直せない
  const input =
    (sent === undefined ? null : inputFailureOf(code, body, sent)) ?? tagFailureOf(code, body);
  if (input !== null) return input;
  // サーバーの message は API を使う側（エージェント）向けの常体なので、画面には出さない。Worker と
  // SPA は同じデプロイで出るので、SPA が知らない code は SPA の書き漏れで、status の汎用の文で足りる。
  // 検索語の誤りは searchPages が先に固定の文へ置き換える
  return { ok: false, reason: "error", message: ERROR_MESSAGES[code] ?? statusMessage(res.status) };
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

function isResolvedPage(value: unknown): value is ResolvedPage {
  const v = recordOf(value);
  return (
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    (v.visibility === "public" || v.visibility === "draft")
  );
}

const BAD_SHAPE: ApiFailure = {
  ok: false,
  reason: "error",
  message: `サーバーの応答を読み取れませんでした。${RETRY_LATER}`,
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
    return {
      ok: false,
      reason: "error",
      message: `サーバーに接続できません。通信を確かめて、もう一度試してください。`,
    };
  }
}

const isFailure = (value: Response | ApiFailure): value is ApiFailure =>
  !(value instanceof Response);

async function pageResult(res: Response | ApiFailure, sent?: SentPage): Promise<ApiResult<Page>> {
  if (isFailure(res)) return res;
  if (!res.ok) return failureOf(res, sent);
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

/** `GET /api/pages/resolve` が title ごとに返す、解決できた page。 */
export interface ResolvedPage {
  id: string;
  title: string;
  visibility: Visibility;
}

/** Worker の `RESOLVE_MAX_TITLES`（apps/worker/src/pages/routes.ts）。超えると 400 になる。 */
export const RESOLVE_MAX_TITLES = 50;

/**
 * resolve の URL の長さ（パスとクエリ）の上限。
 * Cloudflare は 16 KB まで受けるが、手前に別の proxy があると 8 KB で切るものが多い
 * （nginx と Apache の既定は約 8 KB）ので、その下に収める。保存できる title は 1024 バイトまでで、
 * 日本語の 1 件は percent-encoding 後に 3 KB 強になるため、1 件がこの上限を超えることはない。
 */
export const RESOLVE_MAX_URL_LENGTH = 7_000;

const RESOLVE_PATH = "/api/pages/resolve";

const encodedParam = (title: string) => `title=${encodeURIComponent(title)}`;

/** パスと `?` の分。 */
const RESOLVE_BASE_LENGTH = RESOLVE_PATH.length + 1;

/**
 * resolve に渡せる title か。encode 後の 1 件が URL の上限を超える title は、保存できる長さを
 * 超えているので存在しえない。問い合わせずに捨てる。
 */
export function canResolveTitle(title: string): boolean {
  return RESOLVE_BASE_LENGTH + encodedParam(title).length <= RESOLVE_MAX_URL_LENGTH;
}

/**
 * `titles` を、1 回の resolve に収まるまとまりに分ける。件数と encode 後の URL の長さの両方で区切り、
 * 順序は保つ。返すのは `titles` の添字で、`canResolveTitle` を満たさない title は含めない。
 */
export function splitResolveBatches(titles: readonly string[]): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let length = RESOLVE_BASE_LENGTH;
  titles.forEach((title, index) => {
    if (!canResolveTitle(title)) return;
    // 2 件目以降は区切りの `&` が 1 文字増える
    const cost = encodedParam(title).length + (current.length === 0 ? 0 : 1);
    if (
      current.length > 0 &&
      (current.length >= RESOLVE_MAX_TITLES || length + cost > RESOLVE_MAX_URL_LENGTH)
    ) {
      batches.push(current);
      current = [];
      length = RESOLVE_BASE_LENGTH;
      length += encodedParam(title).length;
    } else {
      length += cost;
    }
    current.push(index);
  });
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * title の page を 1 回の要求で引く。件数と URL の長さは呼び出し側が `splitResolveBatches` で
 * 収める。返す配列は `titles` と同じ順、同じ件数で、解決できない title は null。
 * 失敗（404、5xx、通信の失敗、形の違い）は ApiFailure で返す。「全部存在しない」とは区別する。
 * Worker を前の版に戻すと resolve が `/api/pages/:id` に落ちて 404 になる。
 */
export async function resolvePages(
  titles: readonly string[],
  fetchFn: Fetch = fetch,
): Promise<ApiResult<(ResolvedPage | null)[]>> {
  const res = await request(fetchFn, `${RESOLVE_PATH}?${titles.map(encodedParam).join("&")}`);
  if (isFailure(res)) return res;
  if (!res.ok) return failureOf(res);
  const results = recordOf(await readJson(res)).results;
  if (!Array.isArray(results) || results.length !== titles.length) return BAD_SHAPE;
  const pages: (ResolvedPage | null)[] = [];
  for (const result of results) {
    const page = recordOf(result).page;
    if (page === null) pages.push(null);
    else if (isResolvedPage(page)) {
      pages.push({ id: page.id, title: page.title, visibility: page.visibility });
    } else return BAD_SHAPE;
  }
  return { ok: true, value: pages };
}

export async function createPage(
  input: { title: string; body: string },
  fetchFn: Fetch = fetch,
): Promise<ApiResult<Page>> {
  return pageResult(await request(fetchFn, "/api/pages", jsonInit("POST", input)), input);
}

export interface UpdateOptions {
  /** ページを離れる途中の保存で、fetch が中断されないようにする。 */
  keepalive?: boolean;
}

/**
 * title を変えた保存で、Worker が他のページのリンクの書き換えを積んだ数。
 * skipped は、新しい title がリンクに書けないので積まなかったこと。
 */
export interface LinkRewritesQueued {
  queued: number;
  skipped?: "unsafe_title";
}

export type UpdatedPage = Page & { linkRewrites?: LinkRewritesQueued };

function parseLinkRewrites(value: unknown): LinkRewritesQueued | undefined {
  const v = recordOf(value);
  if (typeof v.queued !== "number") return undefined;
  return v.skipped === "unsafe_title"
    ? { queued: v.queued, skipped: "unsafe_title" }
    : { queued: v.queued };
}

export async function updatePage(
  id: string,
  version: number,
  input: { title: string; body: string },
  options: UpdateOptions = {},
  fetchFn: Fetch = fetch,
): Promise<ApiResult<UpdatedPage>> {
  const payload = JSON.stringify(input);
  const keepalive =
    options.keepalive === true && new TextEncoder().encode(payload).length <= KEEPALIVE_MAX_BYTES;
  const res = await pageResult(
    await request(fetchFn, `/api/pages/${encodeURIComponent(id)}`, {
      ...jsonInit("PUT", input, { headers: ifMatch(version) }),
      keepalive,
    }),
    input,
  );
  if (!res.ok) return res;
  const { linkRewrites, ...page } = res.value as UpdatedPage;
  const parsed = parseLinkRewrites(linkRewrites);
  return { ok: true, value: parsed === undefined ? page : { ...page, linkRewrites: parsed } };
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
  options: { tag?: string; visibility?: Visibility | ""; limit?: number } = {},
  fetchFn: Fetch = fetch,
): Promise<ApiResult<PageList<ListedPage>>> {
  const params = new URLSearchParams();
  if (cursor !== null) params.set("cursor", cursor);
  if (options.tag !== undefined && options.tag !== "") params.set("tag", options.tag);
  if (options.visibility !== undefined && options.visibility !== "") {
    params.set("visibility", options.visibility);
  }
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.size === 0 ? "" : `?${params}`;
  return listResult(await request(fetchFn, `/api/pages/recent${query}`), isListedPage);
}

/** Worker の `TITLES_MAX_LIMIT`。一覧の上限より大きいのは、抜粋とタグを引かないため */
export const PAGE_TITLES_LIMIT = 500;

/** id と title だけの一覧。並びと cursor は `listRecent` と同じ。 */
export async function listPageTitles(
  cursor: string | null,
  fetchFn: Fetch = fetch,
): Promise<ApiResult<PageList>> {
  const params = new URLSearchParams({ limit: String(PAGE_TITLES_LIMIT) });
  if (cursor !== null) params.set("cursor", cursor);
  return listResult(await request(fetchFn, `/api/pages/titles?${params}`), isSummary);
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

/**
 * title で書かれたリンクのリンク元。まだ無いページの画面で使う。匿名には、title が draft のページでも
 * 無いページでも同じ public のリンク元が返る。
 */
export async function listBacklinksByTitle(
  title: string,
  cursor: string | null,
  fetchFn: Fetch = fetch,
): Promise<ApiResult<PageList>> {
  const query = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
  return listResult(
    await request(
      fetchFn,
      `/api/pages/by-title/backlinks?title=${encodeURIComponent(title)}${query}`,
    ),
    isSummary,
  );
}

/** 検索語を直せば通る誤り。一覧の取得の失敗とは別に、入力を直す案内として見せる。 */
export type InvalidQuery = { ok: false; reason: "invalid_query"; message: string };

const QUERY_MESSAGES: Record<string, string> = {
  empty: "検索語が空か、空白だけになっています。語を入力してください。",
  too_long: `検索語が長すぎます。${SEARCH_MAX_QUERY_CHARS}\u00a0文字以内にしてください。`,
  control_char: "検索語にタブや改行など、目に見えない文字が入っています。取り除いてください。",
};

/** 検索語の誤りの 400 を固定の文にする。それ以外の失敗は null。 */
function invalidQueryOf(body: Record<string, unknown>): InvalidQuery | null {
  if (body.field !== "q") return null;
  if (body.error === "query_too_short") {
    return {
      ok: false,
      reason: "invalid_query",
      message:
        typeof body.min === "number"
          ? `検索語が短すぎます。${body.min}\u00a0文字以上にしてください。`
          : "検索語が短すぎます。語を足してください。",
    };
  }
  if (body.error !== "invalid_field") return null;
  const reason = typeof body.reason === "string" ? body.reason : "";
  return {
    ok: false,
    reason: "invalid_query",
    // 「この検索語では検索できません」は画面の見出しが伝える
    message: QUERY_MESSAGES[reason] ?? "別の検索語を試してください。",
  };
}

/** 3 文字以上は FTS、2 文字以下は LIKE という振り分けは API が行う。 */
export async function searchPages(
  query: string,
  fetchFn: Fetch = fetch,
): Promise<ApiResult<SearchHit[]> | InvalidQuery> {
  const res = await request(fetchFn, `/api/search?q=${encodeURIComponent(query)}&limit=50`);
  if (isFailure(res)) return res;
  if (!res.ok) {
    if (res.status === 400) {
      const invalid = invalidQueryOf(recordOf(await readJson(res.clone())));
      if (invalid !== null) return invalid;
    }
    return failureOf(res);
  }
  const json = recordOf(await readJson(res));
  const results = json.results;
  if (!Array.isArray(results) || !results.every(isSearchHit)) return BAD_SHAPE;
  return { ok: true, value: results };
}
