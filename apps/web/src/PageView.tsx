import { useCallback, useEffect, useRef, useState } from "react";
import { setDocumentTitle } from "./document-title";
import { Loading } from "./Loading";
import { NotFound } from "./NotFound";
import { Notice } from "./Notice";
import { consumeNewPageTitle, markNewPageCreated } from "./new-page";
import { PageEditor } from "./PageEditor";
import { PageReader } from "./PageReader";
import {
  failureMessage,
  findPageByTitle,
  getPage,
  LOAD_FAILED,
  type Page,
  type PageSummary,
} from "./pages-api";
import { RailLayout } from "./Rail";
import { navigate, pageHrefFor } from "./route";
import { SignInNotice } from "./SignInNotice";
import { useRestoreScrollAfterMount } from "./scroll-restore";

/**
 * ページの URL が指すもの。`/p/<id>` は id、`/<title>` は title で引く。`/?new` はまだ作っていない
 * ページで、serial と title は新規作成の画面を開いた 1 回分（NewPageRequest）。
 */
export type PageTarget =
  | { by: "id"; id: string }
  | { by: "title"; title: string }
  | { by: "new"; serial: number; title: string };

type State =
  | { status: "loading" }
  | { status: "ready"; page: Page }
  | { status: "new"; serial: number; title: string }
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
 *
 * `/?new` は取得を待たずに、同じ描画の中で編集の画面を出す（新規作成の画面を開く操作の中で
 * title 欄に focus するため）。作れたら `/p/<id>` に置き換えるが、上と同じ理由で作り直さず、
 * 作る前の編集の画面をそのまま使い続ける。
 */
export function PageView({ target, owner, attachments }: PageViewProps) {
  const [state, setState] = useState<State>(() =>
    target.by === "new"
      ? { status: "new", serial: target.serial, title: target.title }
      : { status: "loading" },
  );
  /** 表示中のページの正の URL のパス。アドレスバーがこれと同じなら、ルートが変わっても取り直さない */
  const shownPath = useRef<string | null>(null);
  const targetKey =
    target.by === "id"
      ? `id:${target.id}`
      : target.by === "title"
        ? `title:${target.title}`
        : `new:${target.serial}`;
  useRestoreScrollAfterMount(state.status === "ready");

  // effect で切り替えると、編集の画面の mount が開く操作の後になる
  if (target.by === "new" && !(state.status === "new" && state.serial === target.serial)) {
    setState({ status: "new", serial: target.serial, title: target.title });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: target の中身は targetKey が表す
  useEffect(() => {
    if (target.by === "new") {
      shownPath.current = null;
      return;
    }
    if (shownPath.current !== null && shownPath.current === window.location.pathname) return;
    shownPath.current = null;
    let cancelled = false;
    setState({ status: "loading" });
    const request = target.by === "id" ? getPage(target.id) : findPageByTitle(target.title);
    void request.then((res) => {
      if (cancelled) return;
      if (res.ok) setState({ status: "ready", page: res.value });
      else if (res.reason === "not_found") setState({ status: "not_found" });
      else if (res.reason === "unauthorized") setState({ status: "unauthorized" });
      else setState({ status: "error", message: failureMessage(res, LOAD_FAILED) });
    });
    return () => {
      cancelled = true;
    };
  }, [targetKey]);

  // 開く操作で渡された title は使い捨て。受け取ったら空に戻し、同じ title でもう一度作らせない
  const newTargetSerial = target.by === "new" ? target.serial : null;
  useEffect(() => {
    if (newTargetSerial !== null) consumeNewPageTitle(newTargetSerial);
  }, [newTargetSerial]);

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

  const newSerial = state.status === "new" ? state.serial : null;
  const showCreated = useCallback(
    (page: Pick<PageSummary, "id" | "title" | "visibility">) => {
      if (newSerial !== null) markNewPageCreated(newSerial);
      show(page);
    },
    [newSerial, show],
  );

  if (target.by === "new" && !owner) return <SignInNotice />;
  switch (state.status) {
    case "loading":
      return <Loading />;
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
        <RailLayout rail={null}>
          <Notice inline tone="error" title="ページを取得できませんでした">
            <p>{state.message}</p>
          </Notice>
        </RailLayout>
      );
    case "new":
      // owner が変わると key で作り直されるので、ここに来るのは owner だけ
      return (
        <PageEditor
          key={`new:${state.serial}`}
          page={null}
          newTitle={state.title}
          attachments={attachments}
          onShown={showCreated}
        />
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
