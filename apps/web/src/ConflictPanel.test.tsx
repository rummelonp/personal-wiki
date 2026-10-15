import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page as browserPage } from "vitest/browser";
import { ConflictPanel } from "./ConflictPanel";
import { NoticeDockProvider } from "./Notice";
import type { Page } from "./pages-api";
import "./theme.css";
import "./styles.css";

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  for (const style of document.querySelectorAll("style[data-test]")) style.remove();
  await browserPage.viewport(414, 800);
});

const SERVER: Page = {
  id: "p1",
  title: "題",
  body: "サーバーの本文",
  visibility: "draft",
  version: 2,
  createdAt: 0,
  updatedAt: 0,
};

function mount(localBody = "手元の本文") {
  const onOverwrite = vi.fn();
  const onTakeServer = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (busy: boolean) =>
    act(() =>
      root?.render(
        <ConflictPanel
          server={SERVER}
          local={{ title: "題", body: localBody }}
          busy={busy}
          onOverwrite={onOverwrite}
          onTakeServer={onTakeServer}
        />,
      ),
    );
  render(false);
  return { render, onOverwrite, onTakeServer };
}

const button = (label: string) => {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`${label} のボタンが無い`);
  return found;
};

describe("衝突の操作の確認", () => {
  it("確認の問いを、実行とやめるの両方のボタンの説明に結ぶ", () => {
    mount();
    act(() => button("手元で上書き").click());
    const question = document.querySelector(".notice-question");
    expect(question?.id).toBeTruthy();
    expect(button("上書きする").getAttribute("aria-describedby")).toBe(question?.id);
    expect(button("やめる").getAttribute("aria-describedby")).toBe(question?.id);
  });

  it.each([
    ["サーバーの版を取り込む", "手元の変更を破棄して"],
    ["手元で上書き", "サーバーの版を破棄して"],
  ])("%s の確認の問いは、失われる側を言い切る", (label, lost) => {
    mount();
    act(() => button(label).click());
    expect(document.querySelector(".notice-question")?.textContent).toContain(lost);
  });

  it.each(["サーバーの版を取り込む", "手元で上書き"])(
    "%s の確認をやめると、押したボタンに focus が戻る",
    (choice) => {
      mount();
      act(() => button(choice).click());
      expect(document.activeElement).toBe(button("やめる"));
      act(() => button("やめる").click());
      expect(document.activeElement).toBe(button(choice));
    },
  );

  it("戻る先のボタンが押せないときは、通知の見出しに focus を戻す", () => {
    const { render } = mount();
    act(() => button("手元で上書き").click());
    render(true);
    act(() => button("やめる").click());
    expect(button("手元で上書き").disabled).toBe(true);
    expect(document.activeElement).toBe(document.querySelector(".notice-title"));
  });

  it("実行は、選んだ側の処理だけを呼ぶ", () => {
    const { onOverwrite, onTakeServer } = mount();
    act(() => button("手元で上書き").click());
    act(() => button("上書きする").click());
    expect(onOverwrite).toHaveBeenCalledTimes(1);
    expect(onTakeServer).not.toHaveBeenCalled();
  });

  it("凡例は、差分の前にあり、差分をスクロールする欄の外に置く", () => {
    mount();
    const legend = document.querySelector(".diff-legend");
    const diff = document.querySelector(".diff");
    expect(legend?.textContent).toContain("サーバーだけにある行");
    expect(diff).not.toBeNull();
    expect(legend?.compareDocumentPosition(diff as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(document.querySelector(".notice-details")?.contains(legend as Node)).toBe(false);
  });

  it("本文に差分が無いときは、凡例を出さない", () => {
    mount(SERVER.body);
    expect(document.body.textContent).toContain("本文に差分はありません。");
    expect(document.querySelector(".diff-legend")).toBeNull();
  });
});

const LINES = Array.from({ length: 40 }, (_, index) => `${index + 1} 行目`);

/** 台の中に置く。差分の欄の高さは、台と通知の CSS で決まる。 */
async function mountInDock(options: { changeAt: number; detailsMaxHeight?: number }) {
  await browserPage.viewport(393, 500);
  if (options.detailsMaxHeight !== undefined) {
    const style = document.createElement("style");
    style.dataset.test = "";
    style.textContent = `.notice-details { max-height: ${options.detailsMaxHeight}px !important; }`;
    document.head.append(style);
  }
  const server = { ...SERVER, body: LINES.join("\n") };
  const local = {
    title: "題",
    body: LINES.map((line, index) => (index === options.changeAt ? `${line}を直した` : line)).join(
      "\n",
    ),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (busy: boolean) =>
    act(() =>
      root?.render(
        <NoticeDockProvider>
          <ConflictPanel
            server={server}
            local={local}
            busy={busy}
            onOverwrite={vi.fn()}
            onTakeServer={vi.fn()}
          />
        </NoticeDockProvider>,
      ),
    );
  render(false);
  const details = document.querySelector(".notice-details") as HTMLElement;
  return { render, details };
}

const within = (inner: Element, outer: Element) => {
  const a = inner.getBoundingClientRect();
  const b = outer.getBoundingClientRect();
  return a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
};

describe("差分の欄", () => {
  it("最初の変更の前に共通の行が続いても、最初の表示で変更の行が見える", async () => {
    const { details } = await mountInDock({ changeAt: 25, detailsMaxHeight: 70 });
    expect(details.scrollHeight).toBeGreaterThan(details.clientHeight);
    const first = details.querySelector(".diff-delete") as Element;
    expect(within(first, details)).toBe(true);
  });

  it("操作で描き直しても、利用者がスクロールした位置を動かさない", async () => {
    const { render, details } = await mountInDock({ changeAt: 25, detailsMaxHeight: 70 });
    details.scrollTop = 5;
    render(true);
    expect(details.scrollTop).toBe(5);
    act(() => button("手元で上書き").click());
    expect(details.scrollTop).toBe(5);
  });

  it("差分をスクロールしても、凡例は動かず見え続ける", async () => {
    const { details } = await mountInDock({ changeAt: 25, detailsMaxHeight: 70 });
    const legend = document.querySelector(".diff-legend") as HTMLElement;
    const before = legend.getBoundingClientRect().top;
    details.scrollTop = details.scrollHeight;
    expect(legend.getBoundingClientRect().top).toBe(before);
    expect(within(legend, document.querySelector(".notice") as Element)).toBe(true);
  });

  it("先頭の行が変わっていれば、スクロールしない", async () => {
    const { details } = await mountInDock({ changeAt: 0, detailsMaxHeight: 70 });
    expect(details.scrollTop).toBe(0);
  });
});
