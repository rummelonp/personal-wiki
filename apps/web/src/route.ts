import { canonicalPagePath, pageIdPath, parsePagePath } from "@personal-wiki/domain/page-path";
import { useSyncExternalStore } from "react";

/**
 * SPA のパスは `/`、`/p/<id>`、`/<title>` だけ。最上位のパスは title に使うので、`/search` や
 * `/new` のようなパスは増やさない。検索はクエリ（`/?q=`）で表す。
 * ページの URL の読み方は Worker（OGP の差し込み）と同じ parsePagePath に任せる。
 */
export type Route =
  | { name: "home"; query: string; tag: string }
  | { name: "page"; id: string }
  | { name: "title"; title: string }
  | { name: "unknown" };

export function parseRoute(pathname: string, search: string): Route {
  if (pathname === "/") {
    const params = new URLSearchParams(search);
    return { name: "home", query: params.get("q") ?? "", tag: params.get("tag") ?? "" };
  }
  const path = parsePagePath(pathname);
  if (path === null) return { name: "unknown" };
  return path.kind === "id" ? { name: "page", id: path.id } : { name: "title", title: path.title };
}

export function homeHref(query = ""): string {
  const q = query.trim();
  return q === "" ? "/" : `/?q=${encodeURIComponent(q)}`;
}

/** タグで絞った一覧。パスは増やさず、クエリで表す。 */
export const tagHref = (tag: string): string => `/?tag=${encodeURIComponent(tag)}`;

export const pageHref = pageIdPath;

/**
 * ページへのリンク。public は `/<title>`、draft と予約語の title は `/p/<id>`。
 * Worker の canonical と同じ URL にし、匿名に渡る URL と履歴を 1 つにそろえる。
 */
export const pageHrefFor = canonicalPagePath;

const NAVIGATE_EVENT = "personal-wiki:navigate";

export function navigate(href: string, options: { replace?: boolean } = {}): void {
  if (options.replace === true) history.replaceState(null, "", href);
  else history.pushState(null, "", href);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

function subscribe(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  window.addEventListener(NAVIGATE_EVENT, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(NAVIGATE_EVENT, listener);
  };
}

// snapshot は文字列にする。オブジェクトを返すと呼ぶたびに別の値になり、再描画が止まらなくなる。
const currentLocation = () => `${window.location.pathname}${window.location.search}`;

/**
 * URL の hash（`#` 付き、無ければ空文字列）。hash だけが変わる遷移（`navigate`、戻る・進む）でも再描画する。
 * `useRoute` は hash を見ないので、ページの中の位置はこちらで追う。
 */
export function useHash(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash);
}

/** URL のパス。hash だけが変わる遷移でも再描画するのは `useHash` と同じ。 */
export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function useRoute(): Route {
  const location = useSyncExternalStore(subscribe, currentLocation);
  const index = location.indexOf("?");
  return index < 0
    ? parseRoute(location, "")
    : parseRoute(location.slice(0, index), location.slice(index));
}
