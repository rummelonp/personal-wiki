import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LinkedDraft } from "./linked-drafts";
import { PublishBar } from "./PublishBar";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLElement | null = null;
const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  if (clipboard === undefined) delete (navigator as { clipboard?: Clipboard }).clipboard;
  else Object.defineProperty(navigator, "clipboard", clipboard);
});

function render(
  visibility: "draft" | "public",
  uncreated = false,
  findLinkedDrafts?: (signal: AbortSignal) => Promise<readonly LinkedDraft[]>,
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <PublishBar
        visibility={visibility}
        uncreated={uncreated}
        disabled={false}
        externalBases={0}
        titlePending={false}
        sharePath="/設計メモ"
        pending={null}
        onChange={async () => {}}
        {...(findLinkedDrafts === undefined ? {} : { findLinkedDrafts })}
      />,
    ),
  );
}

function button(name: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (el) => el.textContent === name,
  );
  if (found === undefined) throw new Error(`ボタンが無い: ${name}`);
  return found;
}

const note = () => container?.querySelector(".publish-note")?.textContent;

function stubClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

describe("作る前のページ", () => {
  it("公開の操作を押せなくするだけで、案内の文は出さない", () => {
    render("draft", true);
    expect(button("下書き").disabled).toBe(true);
    expect(button("公開").disabled).toBe(true);
    expect(container?.textContent).toBe("下書き公開");
  });
});

describe("公開の確認", () => {
  it("取り消せない範囲まで伝え、確定とやめるの両方にその文を結び付ける", () => {
    render("draft");
    act(() => button("公開").click());
    const text = container?.querySelector(".publish-confirm p");
    expect(text?.textContent).toBe(
      "誰でもこのページを読めるようになり、最近の更新、検索、タグの一覧にも載ります。下書きに戻しても、すでに読まれた内容は取り消せません。",
    );
    expect(text?.id).not.toBe("");
    expect(button("公開する").getAttribute("aria-describedby")).toBe(text?.id);
    expect(button("やめる").getAttribute("aria-describedby")).toBe(text?.id);
  });
});

describe("公開の確認の、リンクしている下書き", () => {
  const draftsBox = () => container?.querySelector(".publish-drafts");

  it("確認を開くと調べ、届いた下書きを id の URL のリンクで並べる", async () => {
    const find = vi.fn(async () => [
      { id: "d1", title: "計画" },
      { id: "d2", title: "メモ" },
    ]);
    render("draft", false, find);
    expect(find).not.toHaveBeenCalled();
    await act(async () => button("公開").click());
    expect(find).toHaveBeenCalledTimes(1);
    expect(draftsBox()?.getAttribute("role")).toBe("status");
    const text = draftsBox()?.querySelector("p");
    expect(text?.textContent).toBe(
      "本文から 2 件の下書きにリンクしています。公開しても、読む人にはリンクではなく文字に見えます。",
    );
    const anchors = [...(draftsBox()?.querySelectorAll("a") ?? [])];
    expect(anchors.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["計画", "/p/d1"],
      ["メモ", "/p/d2"],
    ]);
    // 確定とやめるの読み上げにも、一覧の文を結び付ける
    const confirmText = container?.querySelector(".publish-confirm > p");
    expect(button("やめる").getAttribute("aria-describedby")).toBe(
      `${confirmText?.id} ${text?.id}`,
    );
    // 一覧は操作の後ろに置き、届いても操作の位置を動かさない
    const actions = container?.querySelector(".publish-confirm .actions");
    expect(actions?.nextElementSibling).toBe(draftsBox());
  });

  it("0 件なら何も足さない", async () => {
    render("draft", false, async () => []);
    await act(async () => button("公開").click());
    expect(draftsBox()?.textContent).toBe("");
    expect(button("やめる").getAttribute("aria-describedby")).toBe(
      container?.querySelector(".publish-confirm > p")?.id,
    );
  });

  it("閉じた後に届いた結果は捨て、開き直すと調べ直す", async () => {
    let release: (drafts: LinkedDraft[]) => void = () => {};
    const signals: AbortSignal[] = [];
    const find = vi.fn(
      (signal: AbortSignal) =>
        new Promise<readonly LinkedDraft[]>((resolve) => {
          signals.push(signal);
          release = resolve;
        }),
    );
    render("draft", false, find);
    await act(async () => button("公開").click());
    await act(async () => button("やめる").click());
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => release([{ id: "d1", title: "計画" }]));
    expect(container?.querySelector(".publish-confirm")).toBeNull();

    await act(async () => button("公開").click());
    expect(find).toHaveBeenCalledTimes(2);
    expect(draftsBox()?.textContent).toBe("");
  });
});

describe("URL のコピー", () => {
  it("書けたら、何をコピーしたかを知らせる", async () => {
    stubClipboard(vi.fn(async () => {}));
    render("public");
    await act(async () => button("URL をコピー").click());
    expect(note()).toBe("URL をコピーしました。");
  });

  it("書けなかったら、選んである URL をそのままコピーするよう伝える", async () => {
    stubClipboard(
      vi.fn(async () => {
        throw new Error("denied");
      }),
    );
    render("public");
    await act(async () => button("URL をコピー").click());
    expect(note()).toBe(
      "コピーできませんでした。下の URL は選択済みなので、そのままコピーしてください。",
    );
    const input = container?.querySelector<HTMLInputElement>(".publish-url");
    expect(input?.selectionStart).toBe(0);
    expect(input?.selectionEnd).toBe(input?.value.length);
  });
});
