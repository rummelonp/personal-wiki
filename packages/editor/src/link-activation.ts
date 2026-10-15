import { type Extension, Facet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export interface LinkActivation {
  /** 解決済みの絶対 URL（`<a>` element の `href` プロパティの値） */
  readonly href: string;
  /** 既定で新しいタブに開くリンクか（外部リンクと中クリック）。修飾キーは `event` 側にある */
  readonly newTab: boolean;
  /** 起点のマウスイベント。修飾キーの組み合わせをそのまま起動先へ渡すために要る */
  readonly event: MouseEvent;
}

export type LinkActivator = (activation: LinkActivation) => void;

/**
 * 修飾クリックと中クリックの起動先。新しいタブ、新しいウィンドウ、ダウンロードの
 * 振り分けは OS とブラウザの設定（と将来増える修飾キー）に依るので、既定の
 * `dispatchToHiddenAnchor` は判断せずブラウザへ丸ごと委ねる。
 * 差し替えるのは起動を観測したいテストと、ブラウザ既定に載せられない組み込み先だけ。
 */
export const linkActivator = Facet.define<LinkActivator, LinkActivator>({
  combine: (values) => values[0] ?? dispatchToHiddenAnchor,
});

/** Ctrl/Cmd/Shift/Alt のいずれかを伴うクリックか。素のクリックだけが editor 自身の遷移に乗る。 */
export function isModifiedClick(event: MouseEvent): boolean {
  return event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
}

/**
 * 起動に使う隠し `<a>`。document ごとに 1 つ作って置いたままにする。
 * クリックのたびに作って外すと、Alt+click の download が始まらないことがある——Chromium は
 * download の起動を click の dispatch とは別に進めるため、その時点で起点の `<a>` が
 * document から外れていると黙って捨てる（`setTimeout(…, 0)` で外すのでも間に合わない）。
 * 新しいタブ、新しいウィンドウは dispatch の中で始まるので、失敗は download にだけ出る。
 */
let hiddenAnchor: HTMLAnchorElement | null = null;

function activationAnchor(): HTMLAnchorElement {
  // isConnected を見るのは、host 側が body を差し替えた後も生きた anchor を返すため
  if (hiddenAnchor?.isConnected) return hiddenAnchor;
  const anchor = document.createElement("a");
  anchor.style.display = "none";
  document.body.append(anchor);
  hiddenAnchor = anchor;
  return anchor;
}

/**
 * editor の外に置いた `<a>` へ、同じ修飾キーを持つ synthetic click を送る。
 * editor 内の `<a>` を直接追従させないのは、readonly な view と埋め込みの nested view にも
 * 同じ `<a>` が描かれ、native の追従と editor 自身の遷移が二重に走るため（`click` で常に
 * `preventDefault` する）。`window.open` と違い、修飾キーの解釈をブラウザに残せる。
 */
function dispatchToHiddenAnchor({ href, newTab, event }: LinkActivation): void {
  const anchor = activationAnchor();
  anchor.href = href;
  // 中クリックは修飾キーを持たないので、新しいタブで開くことは target で表す。
  // anchor は使い回すので、前回の起動の target を必ず消してから設定する。
  anchor.removeAttribute("target");
  anchor.removeAttribute("rel");
  if (newTab) {
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  }
  anchor.dispatchEvent(
    // bubbles させないのは、この click が document 上のハンドラから見て
    // editor 内のクリックと区別できない偽の入力になるため
    new MouseEvent("click", {
      bubbles: false,
      cancelable: true,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
    }),
  );
}

function anchorAt(event: MouseEvent): HTMLAnchorElement | null {
  const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
  return target instanceof HTMLAnchorElement ? target : null;
}

function activate(view: EditorView, anchor: HTMLAnchorElement, event: MouseEvent): void {
  event.preventDefault();
  view.state.facet(linkActivator)({
    // href プロパティは相対 URL を document の base で解決した絶対 URL を返す
    href: anchor.href,
    newTab: anchor.target === "_blank" || event.button === 1,
    event,
  });
}

const activationHandlers = EditorView.domEventHandlers({
  mousedown(event) {
    if (!anchorAt(event)) return false;
    // 起動自体は click / auxclick で行う。ここで既定を止めるのは、リンクを開くだけのつもりの
    // 操作で選択が伸びたり（Shift）、中クリックの autoscroll が始まったりしないようにするため。
    // 素のクリックの既定（カーソル移動）は各リンク extension が自分の経路で止める。
    if (event.button === 1 || (event.button === 0 && isModifiedClick(event)))
      event.preventDefault();
    return false;
  },
  click(event, view) {
    const anchor = anchorAt(event);
    if (!anchor) return false;
    // 素のクリックでも native の追従は必ず止める。遷移先の決定は editor（と host）の責務で、
    // `href` は新しいタブやダウンロードをブラウザに任せるための表現にすぎない。
    event.preventDefault();
    if (!isModifiedClick(event)) return false;
    activate(view, anchor, event);
    return true;
  },
  auxclick(event, view) {
    if (event.button !== 1) return false;
    const anchor = anchorAt(event);
    if (!anchor) return false;
    activate(view, anchor, event);
    return true;
  },
});

/**
 * `<a href>` として描いたリンク（WikiLink、markdown link、autolink）の起動を editor が握る。
 * 素のクリックは各 extension の JS 経路に残し、修飾クリックと中クリックだけを
 * `linkActivator` へ渡す。
 */
export function linkActivation(): Extension {
  return activationHandlers;
}
