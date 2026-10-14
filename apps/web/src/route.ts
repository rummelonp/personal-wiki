import { canonicalPagePath, pageIdPath, parsePagePath } from "@personal-wiki/domain/page-path";
import { useSyncExternalStore } from "react";
import { rememberScroll, stateForReplace } from "./scroll-restore";

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

/**
 * 履歴に積む遷移でパスかクエリが変わるときは、先頭までスクロールを戻す。SPA の遷移はブラウザの
 * 読み込みと違い、前の画面のスクロール位置が残る（入力欄の focus でずれた位置も残り、移った先が
 * 先頭を通り過ぎて表示される）。hash だけの変化と置き換えは同じ画面の中の移動なので戻さない。
 * 戻る・進む（popstate）の位置はブラウザの復元に任せる。ただし一覧は取り直す間に短くなって復元が 0 に
 * 丸められるので、離れる直前の位置を履歴のエントリに書き、一覧が描かれた後に自分で戻す
 * （scroll-restore。その state を壊さないよう、置き換えでも state を引き継ぐ）。
 * hash が指す位置へは、移った先が描画された後に use-fragment-jump が動かす。
 */
export function navigate(href: string, options: { replace?: boolean } = {}): void {
  if (options.replace === true) {
    history.replaceState(stateForReplace(href), "", href);
  } else {
    const next = new URL(href, window.location.href);
    const moves =
      next.pathname !== window.location.pathname || next.search !== window.location.search;
    rememberScroll();
    history.pushState(null, "", href);
    if (moves) window.scrollTo(0, 0);
  }
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
