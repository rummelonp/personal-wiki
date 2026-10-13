import { createHeadingSectionExtractor } from "@personal-wiki/markdown";
import type { PageEmbedContent } from "./embed";

interface SectionMemo {
  readonly extract: (heading: string) => string | null;
  readonly byHeading: Map<string, PageEmbedContent>;
}

/**
 * 取得した内容ごとの切り出し。本文の解析は内容ごとに 1 回で、同じ page の見出し違いの embed が
 * 分け合う。内容のオブジェクトが捨てられれば一緒に捨てられる。
 */
const sectionMemos = new WeakMap<PageEmbedContent, SectionMemo>();

/**
 * 1 つの view のセクション embed（`![[Note#見出し]]`）の表示内容。page 全体の内容から見出しの範囲を
 * 切り出す。見出しが無ければ page 全体を出す。
 *
 * widget は内容のオブジェクトの同一性で本文の view を使い回すので、同じ内容と見出しには同じ
 * オブジェクトを返す。取得の内容が変わっても、切り出した文と題名が直前の build と同じなら直前の
 * オブジェクトを返す。埋め込み先の別の見出しを編集しただけで本文の view を作り直すと、スクロールや
 * 選択が失われる。
 */
export class SectionContents {
  // 直前の build と今回の build で返した内容（target と見出しの組ごと）。build ごとに入れ替え、
  // 今回の build で見なかった組は次の build で落とす。残し続けると、見出しを打つ途中の
  // `#H`、`#He` のような組が、それぞれそのときの page 全体の内容とその切り出しを抱えたまま残る。
  private previous = new Map<string, PageEmbedContent>();
  private current = new Map<string, PageEmbedContent>();

  /** decoration を組み始めるときに呼ぶ。 */
  startBuild(): void {
    this.previous = this.current;
    this.current = new Map();
  }

  resolve(target: string, content: PageEmbedContent, heading: string | null): PageEmbedContent {
    if (heading === null || content.kind !== "resolved") return content;
    let memo = sectionMemos.get(content);
    if (!memo) {
      memo = { extract: createHeadingSectionExtractor(content.text), byHeading: new Map() };
      sectionMemos.set(content, memo);
    }
    const key = JSON.stringify([target, heading]);
    let section = memo.byHeading.get(heading);
    if (!section) {
      const text = memo.extract(heading);
      const previous = this.current.get(key) ?? this.previous.get(key);
      if (text === null) {
        section = content;
      } else if (
        previous?.kind === "resolved" &&
        previous.title === content.title &&
        previous.text === text
      ) {
        section = previous;
      } else {
        section = { kind: "resolved", title: content.title, text };
      }
      memo.byHeading.set(heading, section);
    }
    // 内容ごとの切り出しは view をまたいで共有されるので、使い回した切り出しもこの view が
    // 返したものとして残す
    this.current.set(key, section);
    return section;
  }
}
