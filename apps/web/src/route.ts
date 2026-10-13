import { useSyncExternalStore } from "react";

/**
 * SPA のパスは `/` と `/p/<id>` だけ。`/<title>` をページの URL にする予定なので、
 * `/search` や `/new` のような最上位のパスは増やさない。検索はクエリ（`/?q=`）で表す。
 */
export type Route =
  | { name: "home"; query: string; tag: string }
  | { name: "page"; id: string }
  | { name: "unknown" };

const PAGE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function parseRoute(pathname: string, search: string): Route {
  if (pathname === "/") {
    const params = new URLSearchParams(search);
    return { name: "home", query: params.get("q") ?? "", tag: params.get("tag") ?? "" };
  }
  const match = /^\/p\/([^/]+)\/?$/.exec(pathname);
  if (match !== null && PAGE_ID_PATTERN.test(match[1] as string)) {
    return { name: "page", id: match[1] as string };
  }
  return { name: "unknown" };
}

export function homeHref(query = ""): string {
  const q = query.trim();
  return q === "" ? "/" : `/?q=${encodeURIComponent(q)}`;
}

/** タグで絞った一覧。パスは増やさず、クエリで表す。 */
export const tagHref = (tag: string): string => `/?tag=${encodeURIComponent(tag)}`;

export const pageHref = (id: string): string => `/p/${id}`;

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

export function useRoute(): Route {
  const location = useSyncExternalStore(subscribe, currentLocation);
  const index = location.indexOf("?");
  return index < 0
    ? parseRoute(location, "")
    : parseRoute(location.slice(0, index), location.slice(index));
}
