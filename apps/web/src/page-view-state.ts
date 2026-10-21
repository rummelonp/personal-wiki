import { initialPageFor } from "./initial-page";
import { loadingTitleFor, recallTitle } from "./page-titles";
import { type ApiResult, failureMessage, LOAD_FAILED, type Page } from "./pages-api";

/**
 * ページの URL が指すもの。`/p/<id>` は id、`/<title>` は title で引く。`/?new` はまだ作っていない
 * ページで、serial と title は新規作成の画面を開いた 1 回分（NewPageRequest）。
 */
export type PageTarget =
  | { by: "id"; id: string }
  | { by: "title"; title: string }
  | { by: "new"; serial: number; title: string };

export type PageViewState =
  | { status: "loading" }
  | { status: "ready"; page: Page }
  | { status: "new"; serial: number; title: string }
  /** settled は、title の URL の空のページで被リンクの最初の取得が済んだか */
  | { status: "not_found"; settled: boolean }
  | { status: "unauthorized" }
  | { status: "error"; message: string };

/**
 * target の中身を表す文字列。target はレンダーごとに作り直されるので、取得の effect の依存にはこれを使う。
 * new は title を含めず、開いた 1 回分（serial）で区別する。
 */
export function targetKeyOf(target: PageTarget): string {
  switch (target.by) {
    case "id":
      return `id:${target.id}`;
    case "title":
      return `title:${target.title}`;
    case "new":
      return `new:${target.serial}`;
  }
}

/** 最初の描画の状態。new は取得を待たず、HTML に入っていたページがあれば取得せずに出す。 */
export function initialStateFor(target: PageTarget): PageViewState {
  if (target.by === "new") return { status: "new", serial: target.serial, title: target.title };
  const initial = initialPageFor(target);
  return initial === null ? { status: "loading" } : { status: "ready", page: initial };
}

export function loadStateFrom(res: ApiResult<Page>): PageViewState {
  if (res.ok) return { status: "ready", page: res.value };
  if (res.reason === "not_found") return { status: "not_found", settled: false };
  if (res.reason === "unauthorized") return { status: "unauthorized" };
  return { status: "error", message: failureMessage(res, LOAD_FAILED) };
}

/** 取得を待つ間の骨組みに出す title。分かる範囲で前に見た title を出す。 */
export function loadingTitleOf(target: PageTarget): string | undefined {
  switch (target.by) {
    case "title":
      return loadingTitleFor(target.title);
    case "id":
      return recallTitle(target.id);
    case "new":
      return undefined;
  }
}
