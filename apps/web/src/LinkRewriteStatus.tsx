import { useSyncExternalStore } from "react";
import { loginHref } from "./api";
import { Link } from "./Link";
import { type LinkRewriteRunner, linkRewrites } from "./link-rewrites";
import { pageHref, pageHrefFor } from "./route";

/** title の変更で他のページのリンクを書き換えている間の進み具合と、終わったあとの結果。 */
export function LinkRewriteStatus({ runner = linkRewrites }: { runner?: LinkRewriteRunner }) {
  const state = useSyncExternalStore(runner.subscribe, runner.getState);
  const { status, done, total, rewritten, failed, stopReason } = state;

  if (status === "idle") return null;
  if (status === "running") {
    if (total === 0) return null;
    return (
      <p className="narrow muted link-rewrites-progress" role="status">
        他のページのリンクを書き換えています（{done}/{total}）
      </p>
    );
  }

  const close = (
    <button type="button" className="button" onClick={() => runner.dismiss()}>
      閉じる
    </button>
  );
  const publicCount = rewritten.filter((page) => page.visibility === "public").length;
  return (
    <section
      className={`narrow message ${status === "stopped" || failed.length > 0 ? "message-warn" : ""}`}
      role={status === "stopped" ? "alert" : "status"}
    >
      {stopReason === "auth" && (
        <p>ログインが切れたので、他のページのリンクの書き換えを止めました。</p>
      )}
      {stopReason === "error" && <p>他のページのリンクの書き換えを続けられませんでした。</p>}
      {rewritten.length > 0 && (
        <details>
          <summary>
            {rewritten.length} ページのリンクを新しい title に書き換えました
            {publicCount > 0 && `（うち公開 ${publicCount} ページ）`}
          </summary>
          <ul className="link-rewrites-pages">
            {rewritten.map((page) => (
              <li key={page.id}>
                <Link href={pageHrefFor(page)}>{page.title}</Link>
                {page.visibility === "public" && <span className="chip">公開</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {failed.length > 0 && (
        <>
          <p>
            次のページはリンクを書き換えられませんでした。旧 title のリンクを手で直してください。
          </p>
          <ul className="link-rewrites-pages">
            {failed.map((id) => (
              <li key={id}>
                <Link href={pageHref(id)}>{id}</Link>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="actions">
        {stopReason === "auth" && (
          <a className="button button-primary" href={loginHref(window.location)}>
            ログインし直す
          </a>
        )}
        {stopReason === "error" && (
          <button type="button" className="button button-primary" onClick={() => runner.start()}>
            再試行
          </button>
        )}
        {close}
      </div>
    </section>
  );
}
