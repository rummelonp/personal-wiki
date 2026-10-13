/*
 * 先頭の path segment の予約。Worker の配信（spa.ts）と `/<title>` の URL（pages/urls.ts）が
 * 同じ一覧から判定し、片方だけに足して食い違わないようにする。
 */

/**
 * Worker が自分で応答する先頭の segment。SPA の index.html を返さず、未定義のパスは JSON の 404 にする。
 * - `.well-known`: MCP クライアントは 401 の後に OAuth のメタデータを取りに来る。HTML を返すと
 *   JSON の解析に失敗する
 * - `assets`: Static Assets のハッシュ付きファイルの置き場。`/assets/*` は普段 Worker を通らないが、
 *   `/assets` そのものや run_worker_first の設定が変わったときにも HTML を返さない
 */
export const WORKER_PATH_SEGMENTS: readonly string[] = [
  "api",
  "mcp",
  "_auth",
  ".well-known",
  "assets",
];

/**
 * `/<title>` の URL に使わない先頭の segment。Worker の分に、SPA が開く `/p/<id>` の `p` を足す。
 * `p` は SPA の画面なので index.html を返す必要があり、WORKER_PATH_SEGMENTS には入れない。
 */
export const RESERVED_TITLE_SEGMENTS: readonly string[] = [...WORKER_PATH_SEGMENTS, "p"];

/** パスの先頭の segment が WORKER_PATH_SEGMENTS に入るか。 */
export function isWorkerPath(pathname: string): boolean {
  return WORKER_PATH_SEGMENTS.includes(pathname.split("/")[1] ?? "");
}
