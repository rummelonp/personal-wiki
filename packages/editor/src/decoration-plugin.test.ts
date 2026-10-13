import { Decoration, EditorView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import { createEditor } from "./create-editor";
import { decorationPlugin, invalidateDecorations } from "./decoration-plugin";
import type { ImeEvent } from "./ime";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

it("rebuilds once the background parser reaches a scrolled-to viewport", async () => {
  // 初期 parse の時間予算では末尾まで届かない長さにする。
  const doc = `${"段落 **強調** テキスト\n\n".repeat(120_000)}末尾 [[Amazon Web Services|AWS]]`;
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, {
    doc,
    extensions: EditorView.theme({
      "&": { height: "300px" },
      ".cm-scroller": { overflow: "auto" },
    }),
  });
  const v = view;
  v.dispatch({ effects: EditorView.scrollIntoView(doc.length) });

  await vi.waitFor(
    () => {
      const last = [...v.contentDOM.querySelectorAll(".cm-line")].at(-1)?.textContent;
      expect(last).toBe("末尾 AWS");
    },
    { timeout: 10_000 },
  );
});

/**
 * builder が CodeMirror の transaction を経由しない外部データ
 * （React ref 経由で非同期に届く page title 一覧など）を読む場合、その変化は
 * docChanged/selectionSet などのどれにも当たらないため、何もしなければ古い
 * decoration が次の操作まで残る。invalidateDecorations を呼べば builder が
 * 再実行されることを確かめる。
 */
it("rebuilds when invalidateDecorations is called even without a doc/selection change", () => {
  let marker = "before";
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, {
    doc: "text",
    extensions: decorationPlugin({
      name: "external-dep-test",
      build: () => ({
        decorations: Decoration.set([
          Decoration.mark({ class: `cm-marker-${marker}` }).range(0, 4),
        ]),
      }),
    }),
  });
  const v = view;
  expect(v.contentDOM.querySelector(".cm-marker-before")).not.toBeNull();

  marker = "after";
  // 何もしない transaction（decoration の再構築条件に当たらない）。
  v.dispatch({});
  expect(v.contentDOM.querySelector(".cm-marker-after")).toBeNull();

  invalidateDecorations(v);
  expect(v.contentDOM.querySelector(".cm-marker-after")).not.toBeNull();
});

/**
 * IME 不変条件 1。page title 一覧の更新は composition 中にも届く。その間は dispatch せず、
 * composition の終了後に 1 回だけ組み直す。`compositionend` の直後は `isComposing` が
 * false に戻っているが、確定文字列の DOM 変更がまだ読まれていないので、そこでも待つ。
 */
it("holds invalidateDecorations during composition and rebuilds once after it settles", async () => {
  let marker = "before";
  let builds = 0;
  let transactions = 0;
  const events: ImeEvent[] = [];
  host = document.createElement("div");
  document.body.append(host);
  view = createEditor(host, {
    doc: "text",
    onImeEvent: (event) => events.push(event),
    extensions: [
      decorationPlugin({
        name: "external-dep-test",
        build: () => {
          builds += 1;
          return {
            decorations: Decoration.set([
              Decoration.mark({ class: `cm-marker-${marker}` }).range(0, 4),
            ]),
          };
        },
      }),
      EditorView.updateListener.of((update) => {
        transactions += update.transactions.length;
      }),
    ],
  });
  const v = view;
  const buildsBefore = builds;

  v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
  marker = "after";
  invalidateDecorations(v);
  invalidateDecorations(v);
  v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
  invalidateDecorations(v);
  expect(transactions).toBe(0);
  expect(builds).toBe(buildsBefore);
  expect(events.filter((e) => e.kind === "decoration-invalidation-held")).toHaveLength(3);

  // 終了の通知（`compositionSettled`）の 1 回で、保留した 3 回分をまとめて組み直す
  await vi.waitFor(() => expect(v.contentDOM.querySelector(".cm-marker-after")).not.toBeNull());
  expect(transactions).toBe(1);
  expect(builds).toBe(buildsBefore + 1);

  // composition が終われば、その場で dispatch する
  marker = "later";
  invalidateDecorations(v);
  expect(transactions).toBe(2);
  expect(v.contentDOM.querySelector(".cm-marker-later")).not.toBeNull();
});
