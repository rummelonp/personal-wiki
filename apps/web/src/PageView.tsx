import { useEffect, useState } from "react";
import { Link } from "./Link";
import { PageEditor } from "./PageEditor";
import { failureMessage, getPage, type Page } from "./pages-api";
import { homeHref } from "./route";
import { SignInNotice } from "./SignInNotice";

type State =
  | { status: "loading" }
  | { status: "ready"; page: Page }
  | { status: "not_found" }
  | { status: "unauthorized" }
  | { status: "error"; message: string };

export function PageView({ id }: { id: string }) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void getPage(id).then((res) => {
      if (cancelled) return;
      if (res.ok) setState({ status: "ready", page: res.value });
      else if (res.reason === "not_found") setState({ status: "not_found" });
      else if (res.reason === "unauthorized") setState({ status: "unauthorized" });
      else
        setState({
          status: "error",
          message: failureMessage(res, "取得できなかった"),
        });
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  switch (state.status) {
    case "loading":
      return <p className="muted">読み込み中…</p>;
    case "unauthorized":
      return <SignInNotice expired />;
    case "not_found":
      return (
        <section className="notice">
          <h1 className="notice-title">ページが見つかりません</h1>
          <p>
            <Link href={homeHref()}>最近の更新へ戻る</Link>
          </p>
        </section>
      );
    case "error":
      return (
        <p className="message message-error" role="alert">
          {state.message}
        </p>
      );
    case "ready":
      return <PageEditor key={state.page.id} page={state.page} />;
  }
}
