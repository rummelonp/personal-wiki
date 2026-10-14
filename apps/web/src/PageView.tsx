import { useCallback, useEffect, useRef, useState } from "react";
import { clearBodyFocusRequest } from "./body-focus";
import { setDocumentTitle } from "./document-title";
import { NotFound } from "./NotFound";
import { PageEditor } from "./PageEditor";
import { PageReader } from "./PageReader";
import { failureMessage, findPageByTitle, getPage, type Page, type PageSummary } from "./pages-api";
import { navigate, pageHrefFor } from "./route";
import { SignInNotice } from "./SignInNotice";

/** ページの URL が指すもの。`/p/<id>` は id、`/<title>` は title で引く。 */
export type PageTarget = { by: "id"; id: string } | { by: "title"; title: string };

type State =
  | { status: "loading" }
  | { status: "ready"; page: Page }
  | { status: "not_found" }
  | { status: "unauthorized" }
  | { status: "error"; message: string };

interface PageViewProps {
  target: PageTarget;
  /** owner なら編集の画面、それ以外は読み取り専用の画面で開く。切り替わるときは作り直させる（key） */
  owner: boolean;
  /**
   * 添付（画像）を使える環境か。`/api/me` の features。
   * 作った時点の値で固定される（エディタを作り直さない限り反映されない）。
   * 後から変わりうるなら、key に含めて画面ごと作り直させる。
   */
  attachments: boolean;
}

/**
 * ページの URL を開く。取得の後、アドレスバーを正の URL（public は `/<title>`、draft は `/p/<id>`）に
 * 置き換え、title と公開範囲が変わればまた置き換える。
 *
 * 置き換えた URL は同じページを指すので、その後のルートの変化では取り直さない。取り直すと
 * 編集中のエディタが作り直され、変換中の文字が消える。
 */
export function PageView({ target, owner, attachments }: PageViewProps) {
  const [state, setState] = useState<State>({ status: "loading" });
  /** 表示中のページの正の URL のパス。アドレスバーがこれと同じなら、ルートが変わっても取り直さない */
  const shownPath = useRef<string | null>(null);
  /** 取得の応答を待っている id。作成直後の focus の印を、編集の画面が受け取らずに終わったとき消すのに使う */
  const pendingId = useRef<string | null>(null);
  const targetKey = target.by === "id" ? `id:${target.id}` : `title:${target.title}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: target の中身は targetKey が表す
  useEffect(() => {
    if (shownPath.current !== null && shownPath.current === window.location.pathname) return;
    shownPath.current = null;
    let cancelled = false;
    setState({ status: "loading" });
    const request = target.by === "id" ? getPage(target.id) : findPageByTitle(target.title);
    const id = target.by === "id" ? target.id : null;
    pendingId.current = id;
    void request.then((res) => {
      if (cancelled) return;
      pendingId.current = null;
      if (res.ok) {
        setState({ status: "ready", page: res.value });
        return;
      }
      // 開けなかったページの印を残すと、後でそのページを開いたときに作成直後でなくても focus する
      if (id !== null) clearBodyFocusRequest(id);
      if (res.reason === "not_found") setState({ status: "not_found" });
      else if (res.reason === "unauthorized") setState({ status: "unauthorized" });
      else setState({ status: "error", message: failureMessage(res, "取得できなかった") });
    });
    return () => {
      cancelled = true;
      if (id === null || pendingId.current !== id) return;
      pendingId.current = null;
      // 取得の途中で別のページや画面に移ったときの片付け。StrictMode は後片付けの直後に同じ id で
      // effect を付け直すので、同じ tick の中では消さず、付け直されなかったときだけ消す
      queueMicrotask(() => {
        if (pendingId.current !== id) clearBodyFocusRequest(id);
      });
    };
  }, [targetKey]);

  // ページを表示していない間は、前に開いたページの title を残さない。表示した後は onShown が決める
  useEffect(() => {
    if (state.status !== "ready") setDocumentTitle(null);
  }, [state.status]);

  const show = useCallback((page: Pick<PageSummary, "id" | "title" | "visibility">) => {
    const path = pageHrefFor(page);
    shownPath.current = path;
    setDocumentTitle(page.title);
    // 戻るで前の URL に戻れるよう、置き換えにする（同じページの URL を履歴に重ねない）
    if (window.location.pathname !== path) {
      navigate(`${path}${window.location.hash}`, { replace: true });
    }
  }, []);

  switch (state.status) {
    case "loading":
      return <p className="narrow muted">読み込み中…</p>;
    case "unauthorized":
      return <SignInNotice expired />;
    case "not_found":
      return owner && target.by === "title" ? (
        <NotFound creatableTitle={target.title} />
      ) : (
        <NotFound />
      );
    case "error":
      return (
        <p className="message message-error" role="alert">
          {state.message}
        </p>
      );
    case "ready":
      return owner ? (
        <PageEditor
          key={state.page.id}
          page={state.page}
          attachments={attachments}
          onShown={show}
        />
      ) : (
        <PageReader
          key={state.page.id}
          page={state.page}
          attachments={attachments}
          onShown={show}
        />
      );
  }
}
