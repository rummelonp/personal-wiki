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

describe("通知の読み上げの範囲", () => {
  it("role は見出し、本文、操作を包む要素に付き、details は含めない", () => {
    mount(
      <Notice
        inline
        tone="warn"
        title="食い違っています"
        actions={<button type="button">取り込む</button>}
        details={<pre>長い差分</pre>}
      >
        <p>理由</p>
      </Notice>,
    );
    const alert = document.querySelector("[role='alert']");
    expect(alert?.querySelector("h2")?.textContent).toBe("食い違っています");
    expect(alert?.querySelector("button")).not.toBeNull();
    expect(alert?.textContent).not.toContain("長い差分");
    expect(document.body.textContent).toContain("長い差分");
    expect(alert?.getAttribute("aria-labelledby")).toBe(alert?.querySelector("h2")?.id);
  });

  it("silent にすると live region にならない", () => {
    mount(
      <Notice inline tone="info" silent title="進み具合">
        <p>1/3</p>
      </Notice>,
    );
    expect(document.querySelector("[role]")).toBeNull();
  });
});

describe("通知が出たときの focus", () => {
  function mountClaiming(before?: () => HTMLElement) {
    const anchor = before?.();
    anchor?.focus();
    mount(
      <NoticeDockProvider>
        <Notice
          tone="warn"
          title="操作が要ります"
          claimFocus
          actions={<button type="button">選ぶ</button>}
        />
      </NoticeDockProvider>,
    );
    return anchor;
  }

  it("文字を打っていなければ、見出しへ移す", () => {
    mountClaiming();
    expect(document.activeElement).toBe(noticeOf("操作が要ります").querySelector("h2"));
  });

  it("本文や title を打っている最中（contenteditable、input）は奪わない", () => {
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    editable.tabIndex = 0;
    document.body.append(editable);
    restore.push(() => editable.remove());
    mountClaiming(() => editable);
    expect(document.activeElement).toBe(editable);

    act(() => root?.unmount());
    container?.remove();
    const input = document.createElement("input");
    document.body.append(input);
    restore.push(() => input.remove());
    mountClaiming(() => input);
    expect(document.activeElement).toBe(input);
  });

  it("claimFocus が無い通知は、focus を動かさない", () => {
    mount(
      <NoticeDockProvider>
        <Notice tone="info" title="お知らせ" />
      </NoticeDockProvider>,
    );
    expect(document.activeElement).toBe(document.body);
  });
});

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

  it("DOM の順（Tab の順）も、見た目と同じく重大度の高い順で、同じ重大度の中は出た順", () => {
    notices([
      ["info", "案内"],
      ["warn", "注意"],
      ["error", "失敗"],
      ["warn", "注意 2"],
    ]);
    const titles = [...document.querySelectorAll(".notice-dock > .notice h2")].map(
      (h) => h.textContent,
    );
    expect(titles).toEqual(["失敗", "注意", "注意 2", "案内"]);
    const buttons = [...document.querySelectorAll<HTMLElement>(".notice-dock button")];
    const visual = [...buttons].sort(
      (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
    );
    expect(buttons).toEqual(visual);
  });

  it("後から出た重大な通知が手前に入っても、focus 中の通知の focus は外れない", async () => {
    const render = (withError: boolean) =>
      act(() =>
        root?.render(
          <NoticeDockProvider>
            <Notice tone="info" title="案内" actions={<button type="button">案内の操作</button>} />
            {withError && (
              <Notice
                tone="error"
                title="失敗"
                actions={<button type="button">失敗の操作</button>}
              />
            )}
          </NoticeDockProvider>,
        ),
      );
    mount(null);
    render(false);
    const infoButton = noticeOf("案内").querySelector("button") as HTMLButtonElement;
    infoButton.focus();
    render(true);
    await vi.waitFor(() =>
      expect([...document.querySelectorAll(".notice-dock h2")].map((h) => h.textContent)).toEqual([
        "失敗",
        "案内",
      ]),
    );
    expect(document.activeElement).toBe(infoButton);
  });

  it("重大度が上がった通知は、手前へ動く", async () => {
    const render = (second: NoticeTone) =>
      act(() =>
        root?.render(
          <NoticeDockProvider>
            <Notice tone="info" title="甲" />
            <Notice tone={second} title="乙" />
          </NoticeDockProvider>,
        ),
      );
    mount(null);
    render("info");
    render("error");
    await vi.waitFor(() =>
      expect([...document.querySelectorAll(".notice-dock h2")].map((h) => h.textContent)).toEqual([
        "乙",
        "甲",
      ]),
    );
  });

  describe("重大度が上がった通知が focus を持っているとき", () => {
    const titles = () =>
      [...document.querySelectorAll(".notice-dock h2")].map((h) => h.textContent);
    const render = (second: NoticeTone, claimFocus = false) =>
      act(() =>
        root?.render(
          <NoticeDockProvider>
            <Notice tone="info" title="甲" actions={<button type="button">甲の操作</button>} />
            <Notice
              tone={second}
              title="乙"
              claimFocus={claimFocus}
              actions={<button type="button">乙の操作</button>}
            />
          </NoticeDockProvider>,
        ),
      );

    it("moveBefore で動かし、focus は残る", async () => {
      mount(null);
      render("info");
      const button = noticeOf("乙").querySelector("button") as HTMLButtonElement;
      button.focus();
      render("error");
      await vi.waitFor(() => expect(titles()).toEqual(["乙", "甲"]));
      expect(document.activeElement).toBe(button);
    });

    it("moveBefore が無い環境の insertBefore でも、focus を戻す", async () => {
      mount(null);
      render("info");
      Object.defineProperty(dock(), "moveBefore", { value: undefined });
      const inserted = vi.spyOn(dock() as HTMLElement, "insertBefore");
      const button = noticeOf("乙").querySelector("button") as HTMLButtonElement;
      button.focus();
      render("error");
      await vi.waitFor(() => expect(titles()).toEqual(["乙", "甲"]));
      expect(inserted).toHaveBeenCalled();
      expect(document.activeElement).toBe(button);
    });

    it("見出しへ focus を移した直後に動く通知も、insertBefore で focus を保つ", async () => {
      mount(null);
      render("info");
      Object.defineProperty(dock(), "moveBefore", { value: undefined });
      // 後から出た claimFocus の通知は、見出しへ focus を移してから手前へ並べ替えられる
      act(() => {
        const heading = noticeOf("乙").querySelector("h2") as HTMLElement;
        heading.tabIndex = -1;
        heading.focus();
      });
      render("error", true);
      await vi.waitFor(() => expect(titles()).toEqual(["乙", "甲"]));
      expect(document.activeElement).toBe(noticeOf("乙").querySelector("h2"));
    });
  });

  it("重大度が往復しても、同じ重大度の中は台に出た順", async () => {
    const render = (second: NoticeTone) =>
      act(() =>
        root?.render(
          <NoticeDockProvider>
            <Notice tone="info" title="甲" />
            <Notice tone={second} title="乙" />
          </NoticeDockProvider>,
        ),
      );
    const titles = () =>
      [...document.querySelectorAll(".notice-dock h2")].map((h) => h.textContent);
    mount(null);
    render("info");
    render("error");
    await vi.waitFor(() => expect(titles()).toEqual(["乙", "甲"]));
    render("info");
    await vi.waitFor(() => expect(titles()).toEqual(["甲", "乙"]));
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
    await browserPage.viewport(375, 700);
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

  it("details を持つ通知は台の上限に自分で収まり、スクロールするのは details の欄だけ", async () => {
    await browserPage.viewport(375, 659);
    fakeViewport({ height: 659 });
    mount(
      <NoticeDockProvider>
        <Notice
          tone="warn"
          title="食い違い"
          actions={<button type="button">操作</button>}
          details={
            <div className="notice-details">
              <div style={{ height: 1000 }}>差分</div>
            </div>
          }
        >
          <p>理由</p>
        </Notice>
      </NoticeDockProvider>,
    );
    const el = dock() as HTMLElement;
    const details = document.querySelector(".notice-details") as HTMLElement;
    const notice = noticeOf("食い違い");
    expect(notice.getBoundingClientRect().height).toBeLessThanOrEqual(
      el.getBoundingClientRect().height - 24 + 1,
    );
    expect(details.scrollHeight).toBeGreaterThan(details.clientHeight);
    expect(el.scrollHeight).toBeLessThanOrEqual(el.clientHeight + 1);
    expect(el.hasAttribute("data-more-below")).toBe(false);
    // 見出しと操作は details の上に残り、details をスクロールしても動かない
    const action = notice.querySelector("button") as HTMLElement;
    const before = action.getBoundingClientRect().top;
    details.scrollTop = 200;
    expect(action.getBoundingClientRect().top).toBe(before);
  });
});

describe("details の欄の高さ", () => {
  it("短い details は、内容の高さのまま。下限の高さで余白を足さない", async () => {
    await browserPage.viewport(375, 659);
    fakeViewport({ height: 659 });
    mount(
      <NoticeDockProvider>
        <Notice
          tone="warn"
          title="食い違い"
          details={
            <div className="notice-details">
              <div style={{ height: 40 }}>差分</div>
            </div>
          }
        />
      </NoticeDockProvider>,
    );
    const details = document.querySelector(".notice-details") as HTMLElement;
    expect(details.getBoundingClientRect().height).toBeCloseTo(40, 0);
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

  it("details を持つ通知の下限の高さが収まる分だけ、台の上限を広げる。広げる先にも限りがある", async () => {
    await browserPage.viewport(375, 700);
    const viewport = fakeViewport({ height: 700 });
    mount(
      <NoticeDockProvider>
        <Notice
          tone="warn"
          title="食い違い"
          details={
            <div className="notice-details">
              <div style={{ height: 1000 }}>差分</div>
            </div>
          }
        />
      </NoticeDockProvider>,
    );
    const limit = () => Number.parseFloat(getComputedStyle(dock() as Element).maxHeight);
    // 下限の高さ（20rem）と台の余白（上下 0.75rem ずつ）を足した 344px
    expect(limit()).toBeCloseTo(420, 0);
    await browserPage.viewport(375, 500);
    viewport.set({ height: 500 });
    expect(limit()).toBeCloseTo(344, 0);
    // 見える高さの 0.85 でも収まらない低さでは、限りで止めて台の中をスクロールさせる
    await browserPage.viewport(375, 360);
    viewport.set({ height: 360 });
    expect(limit()).toBeCloseTo(306, 0);
  });
});

describe("台の外形", () => {
  it("台の地は余白まで不透明で、後ろの本文を透かさず、余白の操作も後ろへ通さない", () => {
    document.body.style.cssText = "margin:0";
    mount(
      <>
        <p id="behind">後ろの本文</p>
        <NoticeDockProvider>
          <Notice tone="error" title="失敗" />
        </NoticeDockProvider>
      </>,
    );
    const style = getComputedStyle(dock() as Element);
    expect(style.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(style.backgroundColor).toBe(getComputedStyle(document.body).backgroundColor);
    expect(style.pointerEvents).toBe("auto");
    document.body.style.cssText = "";
  });
});

describe("台の上限に達して中でスクロールするとき", () => {
  function tall() {
    mount(
      <NoticeDockProvider>
        <Notice tone="error" title="失敗">
          <div style={{ height: 600 }}>長い</div>
        </Notice>
      </NoticeDockProvider>,
    );
  }
  const hint = (edge: "before" | "after") =>
    getComputedStyle(dock() as Element, `::${edge}`).content;
  const hintRect = (edge: "before" | "after") => {
    const style = getComputedStyle(dock() as Element, `::${edge}`);
    return { height: Number.parseFloat(style.height), position: style.position };
  };

  it("続きのある側の端だけに、淡くぼかす手がかりを出す", async () => {
    await browserPage.viewport(375, 400);
    tall();
    const el = dock() as HTMLElement;
    await vi.waitFor(() => expect(el.hasAttribute("data-more-below")).toBe(true));
    expect(el.hasAttribute("data-more-above")).toBe(false);
    expect(hint("after")).not.toBe("none");
    expect(hint("before")).toBe("none");
    expect(hintRect("after").position).toBe("sticky");

    el.scrollTop = 60;
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(el.hasAttribute("data-more-above")).toBe(true);
    expect(el.hasAttribute("data-more-below")).toBe(true);
    expect(hint("before")).not.toBe("none");

    el.scrollTop = el.scrollHeight;
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(el.hasAttribute("data-more-above")).toBe(true);
    expect(el.hasAttribute("data-more-below")).toBe(false);
    expect(hint("after")).toBe("none");
  });

  it("手がかりは通知の配置と台の高さを動かさず、操作を覆っても押せる", async () => {
    await browserPage.viewport(375, 400);
    tall();
    const el = dock() as HTMLElement;
    await vi.waitFor(() => expect(el.hasAttribute("data-more-below")).toBe(true));
    // 手がかりが負の margin で打ち消されていなければ、先頭の手がかりは通知を押し下げ、
    // 末尾の手がかりは台のスクロールの長さを伸ばす。両方を出した状態と出さない状態を比べる
    el.setAttribute("data-more-above", "");
    const notice = noticeOf("失敗");
    expect(getComputedStyle(el, "::before").content).not.toBe("none");
    expect(getComputedStyle(el, "::after").content).not.toBe("none");
    const withHints = { top: notice.offsetTop, scrollHeight: el.scrollHeight };
    expect(getComputedStyle(el, "::after").pointerEvents).toBe("none");
    expect(getComputedStyle(el, "::before").pointerEvents).toBe("none");
    el.removeAttribute("data-more-above");
    el.removeAttribute("data-more-below");
    expect({ top: notice.offsetTop, scrollHeight: el.scrollHeight }).toEqual(withHints);
  });

  it("先頭の手がかりは、台の端に届いた details の上に描かれる", async () => {
    await browserPage.viewport(375, 280);
    fakeViewport({ height: 280 });
    mount(
      <NoticeDockProvider>
        <Notice
          tone="warn"
          title="食い違い"
          actions={<button type="button">操作</button>}
          details={
            <div className="notice-details">
              <div style={{ height: 1000, background: "rgb(255, 0, 0)" }}>差分</div>
            </div>
          }
        />
      </NoticeDockProvider>,
    );
    const el = dock() as HTMLElement;
    const details = document.querySelector(".notice-details") as HTMLElement;
    el.scrollTop = el.scrollHeight;
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(el.hasAttribute("data-more-above")).toBe(true);
    // 台の先頭の端に details が届いている状態で、手がかりが details に隠れていないかを見る
    const edge = el.getBoundingClientRect().top;
    expect(details.getBoundingClientRect().top).toBeLessThanOrEqual(edge);
    expect(details.getBoundingClientRect().bottom).toBeGreaterThan(edge + 40);

    const shot = await browserPage.screenshot({ save: false });
    const bitmap = await createImageBitmap(
      await (await fetch(`data:image/png;base64,${shot}`)).blob(),
    );
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d") as CanvasRenderingContext2D;
    context.drawImage(bitmap, 0, 0);
    const scale = bitmap.width / window.innerWidth;
    const x = Math.round((details.getBoundingClientRect().left + 40) * scale);
    const y = Math.round((edge + 2) * scale);
    const [r = 0, g = 0, b = 0] = context.getImageData(x, y, 1, 1).data;
    const [br = 0, bg = 0, bb = 0] = (
      getComputedStyle(document.body).backgroundColor.match(/\d+/g) ?? []
    ).map(Number);
    const distance = (to: [number, number, number]) => Math.hypot(r - to[0], g - to[1], b - to[2]);
    expect(distance([br, bg, bb]), "手がかりが details の背後に回っている").toBeLessThan(
      distance([255, 0, 0]),
    );
  });

  it("上限に達していなければ、何も出さない", () => {
    notices([["error", "失敗"]]);
    const el = dock() as HTMLElement;
    expect(el.hasAttribute("data-more-above")).toBe(false);
    expect(el.hasAttribute("data-more-below")).toBe(false);
    expect(hint("before")).toBe("none");
    expect(hint("after")).toBe("none");
  });
});
