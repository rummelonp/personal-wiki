import { syntaxTree } from "@codemirror/language";
import type { Extension, Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { type BuiltDecorations, decorationPlugin } from "./decoration-plugin";
import { isModifiedClick } from "./link-activation";

const LINK_NODE_NAMES = new Set(["URL", "Autolink"]);

/** live-preview.ts が `[text](url)` の可視テキストに付ける属性名。URL を隠した状態でもクリックで開けるようにする。 */
export const MD_LINK_URL_ATTR = "data-md-link-url";

/**
 * リンクの URL scheme を `http`/`https`/`mailto` に限る sanitize 方針を
 * クリック時のナビゲーションにも適用する。Live Preview は URL を隠すので、読み手は遷移先をクリック前に
 * 確認できないため、`javascript:`/`data:` などを弾かないと可視テキストのクリック領域全体が
 * phishing の導線になる。embed.ts の markdown image（`![alt](url)`）は、ここから `mailto:` を
 * 除いた部分集合（`IMAGE_ALLOWED_SCHEMES`）を `<img src>` に使ってよい URL の判定に使う
 * （`<img src="mailto:...">` は画像を読み込めず、`mailto:` を許可する意味が無いため）。
 */
export const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** `[text](<url>)` の angle bracket 付き URL 記法を剥がす。素のクリック起動にも hover 表示にも使う。 */
export function stripAngleBrackets(url: string): string {
  return url.length > 1 && url.startsWith("<") && url.endsWith(">") ? url.slice(1, -1) : url;
}

function urlAt(view: EditorView, pos: number): string | null {
  let found: string | null = null;
  syntaxTree(view.state).iterate({
    from: pos,
    to: pos,
    enter: (node) => {
      if (!LINK_NODE_NAMES.has(node.name)) return true;
      found = view.state.doc.sliceString(node.from, node.to);
      return false;
    },
  });
  return found;
}

function normalize(url: string): string {
  const stripped = stripAngleBrackets(url);
  return /^[a-z][a-z0-9+.-]*:/i.test(stripped) ? stripped : `https://${stripped}`;
}

export function schemeOf(url: string): string | null {
  return /^[a-z][a-z0-9+.-]*:/i.exec(url)?.[0].toLowerCase() ?? null;
}

/**
 * 外部リンクとして `<a href>` に載せてよい URL へ正規化する。scheme が `ALLOWED_SCHEMES` に
 * 無ければ null を返し、呼び出し側は href を持たない装飾にする（`javascript:` の URL を
 * DOM に置かないことが、記法を隠す Live Preview での phishing への一次防御になる）。
 */
export function externalHref(url: string): string | null {
  const normalized = normalize(url);
  const scheme = schemeOf(normalized);
  return scheme && ALLOWED_SCHEMES.has(scheme) ? normalized : null;
}

/** scheme が allowlist 外なら開かず false を返す。呼び出し側はイベントを消費せず、既定のカーソル移動へフォールバックする。 */
function openInNewTab(url: string, event: MouseEvent): boolean {
  const href = externalHref(url);
  if (href === null) return false;
  window.open(href, "_blank", "noopener,noreferrer");
  event.preventDefault();
  return true;
}

/** `[text](url)` と `![alt](url)` の URL は live-preview.ts と embed.ts の持ち物なので装飾しない */
const URL_PARENTS_HANDLED_ELSEWHERE = new Set(["Link", "Image"]);

/**
 * autolink（GFM の裸の URL と CommonMark の `<url>`）を `<a>` にする。markdown link と違い
 * URL 自体が可視テキストなので、装飾は下線だけで、色は syntax highlight のものを残す。
 */
function buildAutolinks(view: EditorView): BuiltDecorations {
  const { state } = view;
  const decorations: Range<Decoration>[] = [];
  const seen = new Set<number>();

  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "URL") return true;
        const parent = node.node.parent;
        if (parent && URL_PARENTS_HANDLED_ELSEWHERE.has(parent.name)) return false;
        if (seen.has(node.from)) return false;
        seen.add(node.from);

        const href = externalHref(state.doc.sliceString(node.from, node.to));
        if (href === null) return false;
        decorations.push(
          Decoration.mark({
            class: "cm-autolink",
            tagName: "a",
            attributes: {
              href,
              target: "_blank",
              rel: "noopener noreferrer",
              // contenteditable の中では `<a>` が既定でドラッグ可能になり、本文の移動と競合する
              draggable: "false",
            },
          }).range(node.from, node.to),
        );
        return false;
      },
    });
  }

  return { decorations: Decoration.set(decorations, true) };
}

/**
 * 素のクリックで markdown link（`[text](url)`）と autolink（`https://...`）を新規タブで開く。
 * WikiLink（wikilink.ts の clickToNavigate）と同じく plain click をナビゲーションに使う。
 *
 * markdown link は URL を隠しているときは `URL` node が DOM に無いので、先に `MD_LINK_URL_ATTR`
 * （live-preview.ts が可視テキストへ付ける）を見る。無ければ revealed 表示や autolink とみなし、
 * クリック位置から構文木を辿る従来の経路にフォールバックする。
 * scheme が `ALLOWED_SCHEMES` に無い場合は開かず、イベントも消費しない（既定のカーソル移動に
 * フォールバックする）。
 */
const clickToOpen = EditorView.domEventHandlers({
  mousedown(event, view) {
    // 修飾クリックと中クリックは `link-activation.ts` が `<a href>` からブラウザ既定へ流す
    if (event.button !== 0 || isModifiedClick(event)) return false;
    const element =
      event.target instanceof Element ? event.target.closest(`[${MD_LINK_URL_ATTR}]`) : null;
    const attrUrl = element?.getAttribute(MD_LINK_URL_ATTR);
    if (attrUrl) {
      return openInNewTab(attrUrl, event);
    }
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    const url = urlAt(view, pos);
    if (!url) return false;
    return openInNewTab(url, event);
  },
});

/** markdown link と autolink を plain click で新規タブに開く。構文自体は CommonMark/GFM の既定 */
export function externalLinks(): Extension {
  return [decorationPlugin({ name: "autolink", build: buildAutolinks }), clickToOpen];
}
