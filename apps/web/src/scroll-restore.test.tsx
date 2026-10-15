import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installScrollRestore,
  rememberScroll,
  restoreCount,
  stateForReplace,
  useHoldScrollRestore,
  useRestoreScroll,
  useRestoreScrollAfterMount,
} from "./scroll-restore";

/*
 * 履歴のエントリは本物の history に書く。戻る操作と進む操作（popstate）は、移った先のエントリの state を
 * replaceState で置いてから popstate を投げて再現する（ブラウザは移った時点で history.state が
 * 移った先のものになる）。
 */

interface Entry {
  search: string;
  y?: number;
  count?: number;
}

const stateOf = (entry: Entry) =>
  entry.y === undefined ? null : { scroll: { y: entry.y, count: entry.count } };

function popTo(entry: Entry): void {
  history.replaceState(stateOf(entry), "", entry.search);
  window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
}

function List({
  ready,
  count = 0,
  settled = true,
}: {
  ready: boolean;
  count?: number;
  settled?: boolean;
}) {
  useRestoreScroll(ready, count, settled);
  return null;
}

function Page({ ready }: { ready: boolean }) {
  useRestoreScrollAfterMount(ready);
  return null;
}

/** ブラウザが復元や丸めで位置を動かしたときに届く scroll イベントを再現する */
function scrollTo(y: number): void {
  window.scrollTo(0, y);
  window.dispatchEvent(new Event("scroll"));
}

let container: HTMLDivElement;
let root: Root;
let filler: HTMLDivElement;

let uninstall: () => void;

beforeAll(() => {
  uninstall = installScrollRestore();
});

afterAll(() => uninstall());

beforeEach(() => {
  filler = document.createElement("div");
  filler.style.height = "5000px";
  document.body.append(filler);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  history.replaceState(null, "", "?t=start");
  window.scrollTo(0, 0);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  filler.remove();
  // 残った復元の対象を捨てる
  popTo({ search: "?t=start" });
});

const mount = (ready: boolean, count?: number) =>
  act(() => root.render(<List ready={ready} {...(count === undefined ? {} : { count })} />));

describe("履歴のエントリごとの位置", () => {
  it("履歴に積む遷移の直前に、今のエントリへ位置と件数を書く", () => {
    mount(true, 40);
    window.scrollTo(0, 300);
    rememberScroll();
    expect(history.state).toEqual({ scroll: { y: 300, count: 40 } });
  });

  it("戻る・進むで離れるときは、スクロールが止まった後の位置が書いてある", async () => {
    window.scrollTo(0, 250);
    await vi.waitFor(() => expect(history.state?.scroll?.y).toBe(250), { timeout: 2000 });
  });

  it("戻ったエントリの一覧が描かれたとき、そのエントリの位置へ戻す", () => {
    popTo({ search: "?t=a", y: 400, count: 40 });
    expect(restoreCount()).toBe(40);
    mount(false);
    expect(window.scrollY).toBe(0);
    mount(true, 40);
    expect(window.scrollY).toBe(400);
    // 使い切る。次に同じ URL を開き直しても戻さない
    expect(restoreCount()).toBeUndefined();
  });

  it("同じ URL が履歴に 2 回あっても、エントリごとの位置へ戻す（戻る・進むの連鎖）", () => {
    const first: Entry = { search: "?t=same", y: 100, count: 20 };
    const second: Entry = { search: "?t=same", y: 700, count: 60 };
    for (const [entry, expected] of [
      [first, 100],
      [second, 700],
      [first, 100],
    ] as const) {
      // 間に別の画面（ページ）を挟む。一覧が出たままの同じ URL への移動は、画面が残るので復元しない
      act(() => root.render(null));
      popTo(entry);
      expect(restoreCount()).toBe(entry.count);
      mount(false);
      window.scrollTo(0, 0);
      mount(true, entry.count);
      expect(window.scrollY).toBe(expected);
    }
  });

  it("リンクのクリック（履歴に積む遷移）の後は、待っていた復元をしない", () => {
    popTo({ search: "?t=a", y: 400 });
    rememberScroll();
    history.pushState(null, "", "?t=a");
    mount(true);
    expect(window.scrollY).toBe(0);
    expect(restoreCount()).toBeUndefined();
  });

  it("別のエントリの一覧には適用しない", () => {
    popTo({ search: "?t=a", y: 400, count: 40 });
    history.replaceState(null, "", "?t=b");
    expect(restoreCount()).toBeUndefined();
    mount(true, 20);
    expect(window.scrollY).toBe(0);
  });

  it("位置のない（初めて開いた）エントリには何もしない", () => {
    popTo({ search: "?t=fresh" });
    mount(true, 20);
    expect(window.scrollY).toBe(0);
    expect(restoreCount()).toBeUndefined();
  });

  it("再読み込みのあと、history.state の位置から戻す", () => {
    history.replaceState(stateOf({ search: "?t=reload", y: 333, count: 30 }), "", "?t=reload");
    // 起動時の installScrollRestore を、再読み込みの後の起動として呼び直す
    uninstall();
    uninstall = installScrollRestore();
    expect(restoreCount()).toBe(30);
    mount(true, 30);
    expect(window.scrollY).toBe(333);
  });
});

describe("復元の待ち中", () => {
  it("ブラウザの復元が位置に届いてから画面が縮んでも、読み込みが済んだときに戻す（一覧から別の一覧）", () => {
    mount(true, 20);
    popTo({ search: "?t=a", y: 400, count: 40 });
    // popstate の時点では前の一覧が残っているので、ブラウザの復元は位置に届く
    scrollTo(400);
    mount(false);
    scrollTo(0);
    expect(history.state?.scroll?.y).toBe(400);
    mount(true, 40);
    expect(window.scrollY).toBe(400);
  });

  it("同じ URL へ戻るときは、画面が残っているのでブラウザの復元に任せる", () => {
    mount(true, 20);
    popTo({ search: "?t=start", y: 400, count: 20 });
    expect(restoreCount()).toBeUndefined();
  });

  it("受け持つ画面が無いときは、スクロールで待つのをやめて通常の記録に戻る", () => {
    popTo({ search: "?t=a", y: 400 });
    scrollTo(10);
    expect(restoreCount()).toBeUndefined();
    mount(true);
    expect(window.scrollY).toBe(10);
  });

  it("再読み込みの起動中の帯でブラウザの復元が丸めても、待ちを捨てずに一覧で戻す", () => {
    history.replaceState(stateOf({ search: "?t=reload", y: 333, count: 30 }), "", "?t=reload");
    uninstall();
    uninstall = installScrollRestore();
    function Skeleton() {
      useHoldScrollRestore();
      return null;
    }
    act(() => root.render(<Skeleton />));
    scrollTo(47);
    expect(restoreCount()).toBe(30);
    mount(true, 30);
    expect(window.scrollY).toBe(333);
  });

  it("一覧の下に続く内容（タグ）が済むまで、戻さない", () => {
    popTo({ search: "?t=a", y: 400, count: 40 });
    act(() => root.render(<List ready count={40} settled={false} />));
    expect(window.scrollY).toBe(0);
    act(() => root.render(<List ready count={40} settled />));
    expect(window.scrollY).toBe(400);
  });

  it("ページは、取得して本文が描かれた後に戻す", () => {
    popTo({ search: "?t=page", y: 800 });
    act(() => root.render(<Page ready={false} />));
    scrollTo(0);
    expect(window.scrollY).toBe(0);
    act(() => root.render(<Page ready />));
    expect(window.scrollY).toBe(800);
  });

  it("ページを描いた直後の戻るでは、ページが戻した先の一覧の復元を使わない", () => {
    history.replaceState(null, "", "?t=page");
    // 戻るが、ページを描いた後で、ページの effect より先に届いた状況（後の兄弟の layout effect で投げる）
    function BackRightAfterShown() {
      useLayoutEffect(() => popTo({ search: "?t=list", y: 400, count: 40 }), []);
      return null;
    }
    act(() =>
      root.render(
        <>
          <Page ready />
          <BackRightAfterShown />
        </>,
      ),
    );
    expect(window.scrollY).toBe(0);
    expect(restoreCount()).toBe(40);
    mount(true, 40);
    expect(window.scrollY).toBe(400);
  });

  it("popstate で、離れる側の書き込みの待ちを捨てる（移った先のエントリを上書きしない）", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      scrollTo(250);
      popTo({ search: "?t=b", y: 50 });
      vi.advanceTimersByTime(1000);
      expect(history.state?.scroll?.y).toBe(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it("位置の保存に失敗しても、例外を投げない（WebKit の SecurityError）", () => {
    const spy = vi.spyOn(history, "replaceState").mockImplementation(() => {
      throw new DOMException("too many calls", "SecurityError");
    });
    try {
      expect(() => rememberScroll()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("stateForReplace", () => {
  it("パスもクエリも同じ置き換えでは、位置を引き継ぐ", () => {
    history.replaceState({ scroll: { y: 10 }, other: 1 }, "", "?t=x");
    expect(stateForReplace("?t=x#h")).toEqual({ scroll: { y: 10 }, other: 1 });
  });

  it("URL が変わる置き換えでは、位置だけを捨てる", () => {
    history.replaceState({ scroll: { y: 10 }, other: 1 }, "", "?t=x");
    expect(stateForReplace("?t=y")).toEqual({ other: 1 });
  });

  it("state が無ければ null のまま", () => {
    expect(stateForReplace("?t=y")).toBeNull();
  });
});
