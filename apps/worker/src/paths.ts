import { WORKER_PATH_SEGMENTS } from "@personal-wiki/domain";

/** パスの先頭の segment が WORKER_PATH_SEGMENTS（packages/domain の page-path.ts）に入るか。 */
export function isWorkerPath(pathname: string): boolean {
  return WORKER_PATH_SEGMENTS.includes(pathname.split("/")[1] ?? "");
}
