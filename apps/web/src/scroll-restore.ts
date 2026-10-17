import { useEffect, useLayoutEffect } from "react";

/*
 * 一覧やページから別の画面を開いて戻ったとき、元の画面のスクロール位置を戻す。
 *
 * ブラウザの復元は戻る（popstate）の時点で 1 度だけ動く。そのとき画面は取り直す前の短い状態
 * （読み込み中の 1 行）なので、位置が 0 に丸められ、内容が届いても戻らない。
 * そこで位置を履歴のエントリの state に持ち、内容が描かれた後に自分で戻す。
 * 同じ URL が履歴に何度あっても、再読み込みのあとでも、エントリごとの位置が戻る。
 * 本文のあるページは、y に加えてヘッダーの下端に見えていた本文の行も持ち、y の代わりにその行の位置へ戻す。
 * history.scrollRestoration は auto のままにする。画面が残ったままの戻り（同じページの hash の移動）は、
 * ブラウザの復元が正しいので任せる。
 *
 * 位置はスクロールが止まるたびにも書く。戻る操作や進む操作（popstate）で離れるときは、その時点の
 * history.state がもう移った先のものなので、離れる側のエントリには書けない。
 */

const STATE_KEY = "scroll";

/**
 * ヘッダーの下端に見えていた本文の行。スクロール量（y）は、画面の外の行の高さが推定値のままか
 * 測った後かで同じ内容を指さなくなるので、本文の画面は行で位置を持つ。
 */
export interface ScrollAnchor {
  /** 本文の中での行頭の添字 */
  offset: number;
  /** 行の上端の、ヘッダーの下端からの距離（px）。行の途中が上端に見えていたときは負 */
  delta: number;
}

/** 本文の画面が、見えている行を読み、その行を元の位置へ戻す手段 */
export interface ScrollAnchorSource {
  /** 行で位置を言い表せないとき（本文の上端がヘッダーの下に在る、など）は null */
  read: () => ScrollAnchor | null;
  /** 戻す操作を始められたら true。false なら呼び出し側が y で戻す */
  apply: (anchor: ScrollAnchor) => boolean;
}

/** 履歴のエントリに持つ、離れる前の位置。 */
interface Saved {
  y: number;
  /** 一覧で読み込んでいた件数。「さらに表示」で読み足した分まで同じ長さに戻すのに使う */
  count?: number;
  /** 本文の画面で、y の代わりに戻す行。行で戻せないときは y で戻す */
  anchor?: ScrollAnchor;
}

/** 復元の対象。popstate か初回の読み込みで決め、画面が描かれたときに使い切る */
let pending: { url: string; saved: Saved } | null = null;

/** 復元を受け持つ画面（useRestoreScroll を呼んでいる画面と、その前に出るスケルトン）の数 */
let consumers = 0;

/** 描画が済んでいる画面の URL。popstate で同じ URL へ戻るときは、画面が残っているので復元しない */
let settledUrl: string | null = null;

/** 一覧が今読み込んでいる件数。一覧の画面が出ている間だけ持つ */
let loadedCount: number | undefined;

/** 表示中の本文。無ければ位置は y だけを書く */
let anchorSource: ScrollAnchorSource | null = null;

let timer: ReturnType<typeof setTimeout> | undefined;

/** スクロールが止まってから書くまでの間。replaceState は呼びすぎると Safari が止めるので間引く */
const WRITE_DELAY_MS = 200;

const currentUrl = (): string => `${window.location.pathname}${window.location.search}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function anchorOf(value: unknown): ScrollAnchor | undefined {
  if (
    !isRecord(value) ||
    typeof value.offset !== "number" ||
    typeof value.delta !== "number" ||
    !Number.isFinite(value.offset) ||
    !Number.isFinite(value.delta)
  ) {
    return undefined;
  }
  // history.state は書き換えられうるので、負の添字は 0 に丸める。上限（doc の長さ）は本文の側で丸める
  return { offset: Math.max(0, value.offset), delta: value.delta };
}

function savedOf(state: unknown): Saved | null {
  if (!isRecord(state)) return null;
  const saved = state[STATE_KEY];
  if (!isRecord(saved) || typeof saved.y !== "number") return null;
  const anchor = anchorOf(saved.anchor);
  return {
    y: saved.y,
    ...(typeof saved.count === "number" ? { count: saved.count } : {}),
    ...(anchor === undefined ? {} : { anchor }),
  };
}

function writeCurrentEntry(): void {
  clearTimeout(timer);
  timer = undefined;
  const anchor = anchorSource?.read() ?? undefined;
  const saved: Saved = {
    y: window.scrollY,
    ...(loadedCount === undefined ? {} : { count: loadedCount }),
    ...(anchor === undefined ? {} : { anchor }),
  };
  const state = isRecord(history.state) ? history.state : {};
  try {
    history.replaceState({ ...state, [STATE_KEY]: saved }, "", window.location.href);
  } catch {
    // WebKit は replaceState の呼びすぎで SecurityError を投げる。位置を残せないだけで、遷移は止めない
  }
}

/** 履歴に積む遷移の直前に呼ぶ。遷移で離れる前の位置を、今のエントリに書く。 */
export function rememberScroll(): void {
  pending = null;
  writeCurrentEntry();
}

/**
 * 置き換えの遷移で書き込む state。位置は URL に紐づくので、パスかクエリが変わるときは捨てる。
 * 捨てないと、正の URL への置き換えで別の画面になったとき、前の画面の位置が残る。
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

/** アプリの起動時に 1 度呼ぶ。返す関数は listener を外す（テストで起動をやり直すため） */
export function installScrollRestore(): () => void {
  const listeners = new AbortController();
  const { signal } = listeners;
  const saved = savedOf(history.state);
  pending = saved === null ? null : { url: currentUrl(), saved };

  window.addEventListener(
    "popstate",
    () => {
      // 待っていた書き込みは、移る前の位置を、移った先のエントリへ書いてしまう
      clearTimeout(timer);
      timer = undefined;
      const entry = savedOf(history.state);
      const url = currentUrl();
      pending = entry === null || url === settledUrl ? null : { url, saved: entry };
    },
    { signal },
  );
  window.addEventListener(
    "scroll",
    () => {
      if (pending !== null) {
        // 復元の待ち中は、ブラウザの復元や読み込み中の短い画面に丸められた位置で上書きしない。
        // 位置に届いたかでは判断しない（届いてから短くなる画面もある）。受け持つ画面がなければ待たない
        if (consumers > 0 && pending.url === currentUrl()) return;
        pending = null;
      }
      clearTimeout(timer);
      timer = setTimeout(writeCurrentEntry, WRITE_DELAY_MS);
    },
    { passive: true, signal },
  );
  // 再読み込みやタブを閉じる直前に、書き残した位置を確定する
  window.addEventListener(
    "pagehide",
    () => {
      if (pending === null) writeCurrentEntry();
    },
    { signal },
  );
  return () => listeners.abort();
}

function enter(): () => void {
  consumers++;
  return () => {
    consumers--;
  };
}

function publish(ready: boolean, count: number | undefined): () => void {
  settledUrl = ready ? currentUrl() : null;
  loadedCount = ready ? count : undefined;
  return () => {
    settledUrl = null;
    loadedCount = undefined;
  };
}

function restoreNow(): void {
  if (pending === null || pending.url !== currentUrl()) return;
  const { y, anchor } = pending.saved;
  pending = null;
  if (anchor !== undefined && anchorSource?.apply(anchor)) return;
  window.scrollTo(0, y);
}

/**
 * 本文を持つ画面が、見えている行の読み書きを登録する。返す関数で外す。
 */
export function registerScrollAnchor(source: ScrollAnchorSource): () => void {
  anchorSource = source;
  return () => {
    if (anchorSource === source) anchorSource = null;
  };
}

/**
 * 受け持つ画面より先に出るスケルトン（起動時や lazy の読み込み中）で呼ぶ。
 * スケルトンでも画面は少しスクロールできる。呼ばないと、ブラウザの復元がスケルトンの間に丸めた位置を通常のスクロールとみなし、
 * 待っていた復元を捨ててしまう（再読み込みのあとに位置が戻らない）。
 */
export function useHoldScrollRestore(): void {
  useLayoutEffect(enter, []);
}

/**
 * 一覧の画面で呼ぶ。件数を履歴に残し、戻る、進む、再読み込みで開いた一覧が描かれたとき
 * （ready が true になったとき）、覚えていた位置へ戻す。位置は描画の前に戻して、先頭が一瞬見えるのを避ける。
 * 一覧の下に続く内容（狭い画面のタグ）が描かれる前は、短い画面に丸められるので、
 * 続く内容が済むまで settled を false にして待つ。
 */
export function useRestoreScroll(ready: boolean, count: number, settled = true): void {
  const restorable = ready && settled;
  useLayoutEffect(enter, []);
  useLayoutEffect(() => publish(ready, count), [ready, count]);
  useLayoutEffect(() => {
    if (restorable) restoreNow();
  }, [restorable]);
}

/**
 * ページの画面で呼ぶ。本文の画面（エディタ）は子の effect で作られるので、その後に動く
 * 親の effect で戻す。ready はページを取得して本文を描く状態になったとき true。
 */
export function useRestoreScrollAfterMount(ready: boolean): void {
  useLayoutEffect(enter, []);
  useLayoutEffect(() => publish(ready, undefined), [ready]);
  useEffect(() => {
    // 描いてからこの effect までの間に戻る操作で前の画面へ移っていたら、その画面の復元を使わずに残す。
    // ここで使うと、短いページの画面で位置を戻した上、続けて描かれる一覧が件数も位置も戻せなくなる
    if (ready && settledUrl === currentUrl()) restoreNow();
  }, [ready]);
}
