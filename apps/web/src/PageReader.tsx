import type { WikiLinkClick } from "@personal-wiki/editor";
import { extractDerived } from "@personal-wiki/markdown";
import { useEffect, useMemo, useRef, useState } from "react";
import { Backlinks } from "./Backlinks";
import { BodyEditor, type BodyEditorHandle } from "./BodyEditor";
import { formatTime } from "./format";
import { extractOutline } from "./heading-outline";
import { Link } from "./Link";
import { Outline } from "./Outline";
import type { Page } from "./pages-api";
import { RailLayout, RailSection } from "./Rail";
import { navigate, pageHrefFor, tagHref } from "./route";
import { createWikiLinks } from "./wiki-links";

interface PageReaderProps {
  page: Page;
  /** 表示したページを伝える。URL と document.title を合わせるため */
  onShown?: (page: Pick<Page, "id" | "title" | "visibility">) => void;
}

/** 本文のリンクをクリックしても開けなかったときの案内。 */
type LinkNotice = { kind: "missing"; title: string } | { kind: "error" };

/**
 * owner 以外（匿名）に見せる読み取り専用の画面。編集、公開範囲、削除、作成の操作は持たない。
 *
 * 本文は owner と同じ Live Preview のエディタを readOnly で使う。`[[` の候補（pageIndex）は渡さない。
 * draft へのリンクは API が存在しないものとして返すので、存在しないページへのリンクと同じ見た目と
 * 案内になる。案内の文も draft と存在しないページで分けない。
 */
export function PageReader({ page, onShown }: PageReaderProps) {
  const editor = useRef<BodyEditorHandle>(null);
  const outline = useMemo(() => extractOutline(page.body), [page.body]);
  const tags = useMemo(() => extractDerived(page.body).tags.map(({ tag }) => tag), [page.body]);
  const [links] = useState(() => createWikiLinks({ pageId: page.id }));
  const [linkNotice, setLinkNotice] = useState<LinkNotice | null>(null);
  const linkClick = useRef<AbortController | null>(null);

  useEffect(() => {
    onShown?.({ id: page.id, title: page.title, visibility: page.visibility });
  }, [onShown, page.id, page.title, page.visibility]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") links.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      linkClick.current?.abort();
      links.dispose();
    };
  }, [links]);

  async function handleWikiLinkClick(link: WikiLinkClick) {
    linkClick.current?.abort();
    const controller = new AbortController();
    linkClick.current = controller;
    setLinkNotice(null);
    const found = await links.lookup(link.target, controller.signal);
    if (controller.signal.aborted) return;
    if (found.kind === "found") navigate(pageHrefFor(found.page));
    else if (found.kind === "missing") setLinkNotice({ kind: "missing", title: link.target });
    else setLinkNotice({ kind: "error" });
  }

  const rail = (
    <>
      <Outline items={outline} onJump={(offset) => editor.current?.jumpTo(offset)} />
      {tags.length > 0 && (
        <RailSection title="タグ">
          <ul className="chips">
            {tags.map((tag) => (
              <li key={tag}>
                <Link className="chip chip-link" href={tagHref(tag)}>
                  {tag}
                </Link>
              </li>
            ))}
          </ul>
        </RailSection>
      )}
      <Backlinks pageId={page.id} />
      <RailSection title="情報">
        <dl className="facts">
          <dt>更新</dt>
          <dd>{formatTime(page.updatedAt)}</dd>
          <dt>作成</dt>
          <dd>{formatTime(page.createdAt)}</dd>
        </dl>
      </RailSection>
    </>
  );

  return (
    <RailLayout rail={rail}>
      <article className="note">
        {linkNotice !== null && (
          <section className="message message-warn" role="alert">
            <p>
              {linkNotice.kind === "error"
                ? "リンク先を調べられませんでした。通信を確かめて、もう一度クリックしてください。"
                : `「${linkNotice.title}」のページはありません。`}
            </p>
            <div className="actions">
              <button type="button" className="button" onClick={() => setLinkNotice(null)}>
                閉じる
              </button>
            </div>
          </section>
        )}
        <h1 className="note-title">{page.title}</h1>
        <BodyEditor
          ref={editor}
          value={page.body}
          readOnly
          links={links}
          onWikiLinkClick={(link) => void handleWikiLinkClick(link)}
        />
      </article>
    </RailLayout>
  );
}
