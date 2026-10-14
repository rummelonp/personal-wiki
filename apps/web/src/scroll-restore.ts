import { useLayoutEffect } from "react";

/*
 * 一覧からページを開いて戻ったとき、一覧のスクロール位置を戻す。
 *
 * ブラウザの復元は戻る（popstate）の時点で 1 度だけ動く。そのとき画面は一覧を取り直す前の短い
 * 状態（読み込み中の 1 行）なので、位置が 0 に丸められ、一覧が届いても戻らない。
 * そこで位置を履歴のエントリの state に持ち、一覧が描かれた後に自分で戻す。
 * 同じ URL が履歴に何度あっても、再読み込みのあとでも、エントリごとの位置が戻る。
 * history.scrollRestoration は auto のままにする。ページどうしの戻りはブラウザの復元に任せる。
 *
 * 位置はスクロールが止まるたびにも書く。戻る・進む（popstate）で離れるときは、その時点の
 * history.state がもう移った先のものなので、離れる側のエントリには書けない。
 */

const STATE_KEY = "scroll";

/** 履歴のエントリに持つ、離れる前の位置。 */
interface Saved {
  y: number;
  /** 一覧で読み込んでいた件数。「さらに表示」で読み足した分まで同じ長さに戻すのに使う */
  count?: number;
}

/** 復元の対象。popstate か初回の読み込みで決め、一覧が描かれたときに使い切る */
let pending: { url: string; saved: Saved } | null = null;

/** 一覧が今読み込んでいる件数。一覧の画面が出ている間だけ持つ */
let loadedCount: number | undefined;

let timer: ReturnType<typeof setTimeout> | undefined;

/** スクロールが止まってから書くまでの間。replaceState は呼びすぎると Safari が止めるので間引く */
const WRITE_DELAY_MS = 200;

const currentUrl = (): string => `${window.location.pathname}${window.location.search}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function savedOf(state: unknown): Saved | null {
  if (!isRecord(state)) return null;
  const saved = state[STATE_KEY];
  if (!isRecord(saved) || typeof saved.y !== "number") return null;
  return typeof saved.count === "number" ? { y: saved.y, count: saved.count } : { y: saved.y };
}

function writeCurrentEntry(): void {
  clearTimeout(timer);
  timer = undefined;
  const saved: Saved =
    loadedCount === undefined ? { y: window.scrollY } : { y: window.scrollY, count: loadedCount };
  const state = isRecord(history.state) ? history.state : {};
  history.replaceState({ ...state, [STATE_KEY]: saved }, "", window.location.href);
}

/** 履歴に積む遷移の直前に呼ぶ。この後で先頭へ戻す前の位置を、今のエントリに書く。 */
export function rememberScroll(): void {
  pending = null;
  writeCurrentEntry();
}

/**
 * 置き換えの遷移で書き込む state。位置は URL に紐づくので、パスかクエリが変わるときは捨てる
 * （正の URL への置き換えで、別の画面の位置を持ち越さない）。
 */
export function stateForReplace(href: string): unknown {
  const state: unknown = history.state ?? null;
  if (!isRecord(state) || !(STATE_KEY in state)) return state;
  const next = new URL(href, window.location.href);
  if (next.pathname === window.location.pathname && next.search === window.location.search) {
    return state;
  }
  const { [STATE_KEY]: _dropped, ...rest } = state;
  return rest;
}

/** 戻す対象の一覧が、最初から読み込む件数。対象でなければ undefined */
export function restoreCount(): number | undefined {
  return pending !== null && pending.url === currentUrl() ? pending.saved.count : undefined;
}

/** アプリの起動時に 1 度呼ぶ。 */
export function installScrollRestore(): void {
  const saved = savedOf(history.state);
  pending = saved === null ? null : { url: currentUrl(), saved };

  window.addEventListener("popstate", () => {
    const entry = savedOf(history.state);
    pending = entry === null ? null : { url: currentUrl(), saved: entry };
  });
  window.addEventListener(
    "scroll",
    () => {
      if (pending !== null) {
        // 復元の待ち中は、短い画面に丸められた位置で上書きしない。覚えた位置まで届いていれば
        // （一覧でない画面をブラウザが復元したとき）、待つ対象ではなかったので通常の記録に戻る
        if (window.scrollY < pending.saved.y) return;
        pending = null;
      }
      clearTimeout(timer);
      timer = setTimeout(writeCurrentEntry, WRITE_DELAY_MS);
    },
    { passive: true },
  );
  // 再読み込みやタブを閉じる直前に、書き残した位置を確定する
  window.addEventListener("pagehide", () => {
    if (pending === null) writeCurrentEntry();
  });
}

/**
 * 一覧の画面で呼ぶ。件数を履歴に残し、戻る・進む・再読み込みで開いた一覧が描かれたとき
 * （ready が true になったとき）、覚えていた位置へ戻す。位置は描画の前に戻して、先頭が一瞬見えるのを避ける。
 */
export function useRestoreScroll(ready: boolean, count: number): void {
  useLayoutEffect(() => {
    loadedCount = ready ? count : undefined;
    return () => {
      loadedCount = undefined;
    };
  }, [ready, count]);

  useLayoutEffect(() => {
    if (!ready || pending === null || pending.url !== currentUrl()) return;
    const { y } = pending.saved;
    pending = null;
    window.scrollTo(0, y);
  }, [ready]);
}
