import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page as browserPage } from "vitest/browser";
import { Notice, NoticeDockProvider, type NoticeTone } from "./Notice";
import "./theme.css";
import "./styles.css";

let root: Root | null = null;
let container: HTMLElement | null = null;
const restore: Array<() => void> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  for (const undo of restore.splice(0)) undo();
  await browserPage.viewport(414, 800);
});

function mount(element: React.ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

const dock = () => document.querySelector<HTMLElement>(".notice-dock");
const noticeOf = (title: string) => {
  const found = [...document.querySelectorAll<HTMLElement>(".notice")].find((el) =>
    el.textContent?.includes(title),
  );
  if (!found) throw new Error(`${title} の通知が無い`);
  return found;
};

/** visual viewport を差し替える。差し替えた間の window.visualViewport がこの値になる。 */
function fakeViewport(initial: { height: number; scale?: number; offsetTop?: number }) {
  const target = new EventTarget();
  const viewport = Object.assign(target, { scale: 1, offsetTop: 0, ...initial });
  const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  restore.push(() => {
    if (original) Object.defineProperty(window, "visualViewport", original);
    else Reflect.deleteProperty(window, "visualViewport");
  });
  return {
    set(next: Partial<{ height: number; scale: number; offsetTop: number }>) {
      Object.assign(viewport, next);
      act(() => {
        viewport.dispatchEvent(new Event("resize"));
      });
    },
  };
}

function notices(tones: Array<[NoticeTone, string]>) {
  mount(
    <NoticeDockProvider>
      {tones.map(([tone, title]) => (
        <Notice key={title} tone={tone} title={title} actions={<button type="button">操作</button>}>
          <p>{title}の理由</p>
        </Notice>
      ))}
    </NoticeDockProvider>,
  );
}

describe("台の中の並びと畳み方", () => {
  it("重大度の高い通知が、出た順によらず台の上に並ぶ", () => {
    notices([
      ["info", "案内"],
      ["warn", "注意"],
      ["error", "失敗"],
    ]);
    const tops = (["失敗", "注意", "案内"] as const).map(
      (title) => noticeOf(title).getBoundingClientRect().top,
    );
    expect(tops[0]).toBeLessThan(tops[1] ?? 0);
    expect(tops[1]).toBeLessThan(tops[2] ?? 0);
  });

  it("狭い画面で通知が重なると、最も重大な 1 つ以外は理由を畳む", async () => {
    await browserPage.viewport(375, 800);
    notices([
      ["warn", "注意"],
      ["error", "失敗"],
    ]);
    expect(noticeOf("失敗").hasAttribute("data-folded")).toBe(false);
    expect(noticeOf("注意").hasAttribute("data-folded")).toBe(true);
    expect(
      getComputedStyle(noticeOf("失敗").querySelector(".notice-text") as Element).display,
    ).toBe("block");
    expect(
      getComputedStyle(noticeOf("注意").querySelector(".notice-text") as Element).display,
    ).toBe("none");
    // 見出しと操作は残る
    expect(noticeOf("注意").querySelector("h2")).not.toBeNull();
    expect(noticeOf("注意").querySelector("button")).not.toBeNull();
  });

  it("通知の重大度が変わると、畳む対象も入れ替わる", async () => {
    await browserPage.viewport(375, 800);
    // 理由の段落が無いので、畳んでも大きさは変わらない。大きさの監視では気づけず、class の監視だけが頼り
    const render = (first: NoticeTone, second: NoticeTone) =>
      act(() =>
        root?.render(
          <NoticeDockProvider>
            <Notice tone={first} title="甲" actions={<button type="button">操作</button>} />
            <Notice tone={second} title="乙" actions={<button type="button">操作</button>} />
          </NoticeDockProvider>,
        ),
      );
    mount(null);
    render("error", "warn");
    await vi.waitFor(() => expect(noticeOf("乙").hasAttribute("data-folded")).toBe(true));
    expect(noticeOf("甲").hasAttribute("data-folded")).toBe(false);
    // 最初の大きさの通知は届いてから入れ替える
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    render("warn", "error");
    await vi.waitFor(() => expect(noticeOf("甲").hasAttribute("data-folded")).toBe(true));
    expect(noticeOf("乙").hasAttribute("data-folded")).toBe(false);
    // 畳む印は data 属性なので、class の監視が自分の結果で呼び直されて回り続けることはない
    const records: MutationRecord[] = [];
    const watch = new MutationObserver((list) => records.push(...list));
    watch.observe(noticeOf("甲"), { attributes: true });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    watch.disconnect();
    expect(records).toEqual([]);
  });

  it("通知が 1 つなら畳まない", async () => {
    await browserPage.viewport(375, 800);
    notices([["warn", "注意"]]);
    expect(noticeOf("注意").hasAttribute("data-folded")).toBe(false);
  });
});

describe("キーボードと拡大", () => {
  it("キーボードで visual viewport が縮んでいる間は、通知を見出しと操作だけに畳む", async () => {
    await browserPage.viewport(375, 800);
    const viewport = fakeViewport({ height: 800 });
    notices([["error", "失敗"]]);
    const text = () => getComputedStyle(noticeOf("失敗").querySelector(".notice-text") as Element);
    expect(dock()?.hasAttribute("data-keyboard")).toBe(false);
    expect(text().display).toBe("block");

    viewport.set({ height: 450 });
    expect(dock()?.hasAttribute("data-keyboard")).toBe(true);
    expect(text().display).toBe("none");
    expect(noticeOf("失敗").querySelector("button")).not.toBeNull();

    viewport.set({ height: 800 });
    expect(dock()?.hasAttribute("data-keyboard")).toBe(false);
    expect(text().display).toBe("block");
  });

  it("URL バーの伸縮ほどの差では畳まない", async () => {
    await browserPage.viewport(375, 800);
    const viewport = fakeViewport({ height: 700 });
    notices([["error", "失敗"]]);
    expect(dock()?.hasAttribute("data-keyboard")).toBe(false);
    viewport.set({ height: 680 });
    expect(dock()?.hasAttribute("data-keyboard")).toBe(false);
  });

  it("ピンチで拡大している間は、上限を layout viewport の高さから決め、畳まない", async () => {
    await browserPage.viewport(375, 800);
    const viewport = fakeViewport({ height: 800 });
    notices([["error", "失敗"]]);
    viewport.set({ height: 300, scale: 2.6 });
    expect(dock()?.hasAttribute("data-keyboard")).toBe(false);
    expect(dock()?.style.getPropertyValue("--notice-room")).toBe(`${window.innerHeight}px`);
    expect(dock()?.style.getPropertyValue("--notice-inset")).toBe("0px");
  });

  it("差分の欄の上限は、見えている高さ（visual viewport）に対する割合で決まる", async () => {
    await browserPage.viewport(375, 800);
    const viewport = fakeViewport({ height: 400 });
    mount(
      <NoticeDockProvider>
        <Notice tone="warn" title="食い違い" details={<div className="diff">差分</div>} />
      </NoticeDockProvider>,
    );
    const limit = () =>
      Number.parseFloat(getComputedStyle(document.querySelector(".diff") as Element).maxHeight);
    expect(limit()).toBeCloseTo(100, 0);
    viewport.set({ height: 600 });
    expect(limit()).toBeCloseTo(150, 0);
  });
});

describe("台の高さの上限", () => {
  it("見えている高さ（visual viewport）に対する割合で決まる", async () => {
    await browserPage.viewport(375, 800);
    const viewport = fakeViewport({ height: 400 });
    notices([["error", "失敗"]]);
    const limit = () => Number.parseFloat(getComputedStyle(dock() as Element).maxHeight);
    expect(limit()).toBeCloseTo(240, 0);
    viewport.set({ height: 600 });
    expect(limit()).toBeCloseTo(360, 0);
  });
});

describe("台の上限に達したとき", () => {
  it("溢れている間だけ台が操作を受け取り、スクロールバーを掴める", async () => {
    await browserPage.viewport(375, 400);
    vi.stubGlobal("devicePixelRatio", 1);
    mount(
      <NoticeDockProvider>
        <Notice tone="error" title="失敗">
          <div style={{ height: 600 }}>長い</div>
        </Notice>
      </NoticeDockProvider>,
    );
    await vi.waitFor(() => expect(dock()?.hasAttribute("data-scrollable")).toBe(true));
    expect(getComputedStyle(dock() as Element).pointerEvents).toBe("auto");
    vi.unstubAllGlobals();
  });

  it("溢れていなければ、台は操作を通す", async () => {
    notices([["error", "失敗"]]);
    expect(dock()?.hasAttribute("data-scrollable")).toBe(false);
    expect(getComputedStyle(dock() as Element).pointerEvents).toBe("none");
  });
});
