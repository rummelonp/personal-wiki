import { INITIAL_PAGE_ELEMENT_ID } from "@personal-wiki/domain/initial-page";
import { normalizeTitleKey } from "@personal-wiki/domain/title";
import { isPage, type Page } from "./pages-api";
import { subscribe } from "./route";

/** 初回の表示に使えるかを突き合わせる、ページの URL が指すもの。 */
export type InitialPageTarget = { by: "id"; id: string } | { by: "title"; title: string };

let initial: Page | null = null;
let stopWatching: (() => void) | null = null;

function currentNavigationType(): string | undefined {
  const [entry] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
  return entry?.type;
}

/**
 * Worker が public のページの HTML に入れた、`/api/pages/:id` と同じ形のページを受け取る。起動時に 1 度呼ぶ。
 * 受け取れるのは直接開いたときと再読み込みのときだけで、それ以外は initialPageFor が null を返し、
 * 画面は JSON を引く。
 * - 戻る、進むで開いた HTML は、ブラウザが取り直さずに履歴に残した版を使うことがあり、古い本文でありうる
 * - パスが変わったら捨てる。SPA の中の移動で、起動したときの版を出さない
 * 要素は読んだら取り除き、本文の大きさの文字列を DOM に残さない。
 */
export function readInitialPage(navigationType = currentNavigationType()): void {
  discardInitialPage();
  const element = document.getElementById(INITIAL_PAGE_ELEMENT_ID);
  if (element === null) return;
  element.remove();
  if (navigationType === "back_forward") return;
  let value: unknown;
  try {
    value = JSON.parse(element.textContent ?? "");
  } catch {
    return;
  }
  if (!isPage(value) || value.visibility !== "public") return;
  initial = value;
  const pathname = window.location.pathname;
  stopWatching = subscribe(() => {
    if (window.location.pathname !== pathname) discardInitialPage();
  });
}

/**
 * 受け取ったページが target と同じページなら返す。何度呼んでも同じ値を返す（StrictMode の 2 度の描画で
 * 食い違わないよう、ここでは捨てない）。title は Worker が HTML のページを引いたのと同じ title_key で比べる。
 */
export function initialPageFor(target: InitialPageTarget): Page | null {
  if (initial === null) return null;
  if (target.by === "id") return initial.id === target.id ? initial : null;
  const wanted = normalizeTitleKey(target.title);
  const own = normalizeTitleKey(initial.title);
  return wanted.ok && own.ok && wanted.value === own.value ? initial : null;
}

/** 受け取ったページを捨てる。最初のページの画面が開いた後は、使ったかどうかに関係なく捨てる。 */
export function discardInitialPage(): void {
  initial = null;
  stopWatching?.();
  stopWatching = null;
}
