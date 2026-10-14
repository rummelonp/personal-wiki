import { useSyncExternalStore } from "react";
import { loginHref } from "./api";
import { Link } from "./Link";
import { type LinkRewriteRunner, linkRewrites } from "./link-rewrites";
import { Notice } from "./Notice";
import { pageHref, pageHrefFor } from "./route";

/** title の変更で他のページのリンクを書き換えている間の進み具合と、終わったあとの結果。 */
export function LinkRewriteStatus({ runner = linkRewrites }: { runner?: LinkRewriteRunner }) {
  const state = useSyncExternalStore(runner.subscribe, runner.getState);
  const { status, done, total, rewritten, failed, stopReason } = state;

  if (status === "idle") return null;
  if (status === "running") {
    if (total === 0) return null;
    return (
      <Notice tone="info" role="status" title="他のページのリンクを書き換えています">
        <p>
          {done}/{total}{" "}
          ページを書き換えました。この画面を閉じても、残りは次に開いたときに続きから進みます。
        </p>
      </Notice>
    );
  }

  const publicCount = rewritten.filter((page) => page.visibility === "public").length;
  const stoppedForAuth = stopReason === "auth";
  const stoppedForError = stopReason === "error";
  return (
    <Notice
      tone={status === "stopped" || failed.length > 0 ? "warn" : "info"}
      role={status === "stopped" ? "alert" : "status"}
      title={
        stoppedForAuth || stoppedForError
          ? "他のページのリンクの書き換えを止めました"
          : failed.length > 0
            ? "書き換えられなかったリンクがあります"
            : "他のページのリンクを書き換えました"
      }
      actions={
        <>
          {stoppedForAuth && (
            <a className="button button-main" href={loginHref(window.location)}>
              ログインし直す
            </a>
          )}
          {stoppedForError && (
            <button type="button" className="button button-main" onClick={() => runner.retry()}>
              再試行
            </button>
          )}
          <button type="button" className="button" onClick={() => runner.dismiss()}>
            閉じる
          </button>
        </>
      }
    >
      {stoppedForAuth && (
        <p>
          書き込みを認められませんでした。ログインが切れていれば、ログインし直してから続けてください。
        </p>
      )}
      {stoppedForError && <p>通信を確かめて、再試行してください。</p>}
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
    </Notice>
  );
}
