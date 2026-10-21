import { useEffect, useState, useSyncExternalStore } from "react";
import { loginHref } from "./api";
import { Link } from "./Link";
import { useAfterFrames } from "./Loading";
import {
  type FailedPage,
  type LinkRewriteRunner,
  type LinkRewriteState,
  linkRewrites,
} from "./link-rewrites";
import { Notice, type NoticeInteraction } from "./Notice";
import { pageHref, pageHrefFor } from "./route";

/** 成功だけで終わった報告を、閉じられなくても下げるまでの時間 */
export const DONE_VISIBLE_MS = 10_000;

const RUNNING_ANNOUNCEMENT = "他のページのリンクを書き換えています";

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

const isDocumentHidden = () => document.visibilityState === "hidden";

function failedPageLabel({ title }: FailedPage): string {
  return title ?? "タイトルを取得できなかったページ";
}

/** 終わりか停止の見出し。画面の通知と、完了の読み上げで同じ文を使う。 */
function resultTitle({ failed, stopReason }: LinkRewriteState): string {
  if (stopReason === "auth" || stopReason === "error") {
    return "他のページのリンクの書き換えが止まりました";
  }
  return failed.length > 0
    ? "書き換えられなかったリンクがあります"
    : "他のページのリンクを書き換えました";
}

/**
 * status で読み上げる文。進捗と完了だけで、止まって操作が要る停止は含めない（通知が role=alert で読み上げる）。
 */
function announcementOf(state: LinkRewriteState): string {
  if (state.status === "running") return state.total > 0 ? RUNNING_ANNOUNCEMENT : "";
  return state.status === "done" ? resultTitle(state) : "";
}

/** title の変更で他のページのリンクを書き換えている間の進み具合と、終わったあとの結果。 */
export function LinkRewriteStatus({ runner = linkRewrites }: { runner?: LinkRewriteRunner }) {
  const state = useSyncExternalStore(runner.subscribe, runner.getState);
  const { status, failed, stopReason } = state;
  const [listOpen, setListOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hovering, setHovering] = useState(false);
  const hidden = useSyncExternalStore(subscribeVisibility, isDocumentHidden);
  const ready = useAfterFrames();
  const stoppedForError = stopReason === "error";
  const succeeded = status === "done" && failed.length === 0;
  // 読んでいる間、操作している間、見ていない間は下げない。戻ってきたら数え直す
  const held = focused || hovering || hidden;

  // 通信が戻ったら、手で再試行を押さなくても続きから進める。通信の失敗で止まったときだけで、
  // サーバーの失敗が続いているときは online が来ないので、呼び直しが繰り返されない
  useEffect(() => {
    if (!stoppedForError) return;
    const resume = () => runner.retry();
    window.addEventListener("online", resume);
    return () => window.removeEventListener("online", resume);
  }, [stoppedForError, runner]);

  // 開いた一覧は、その報告を閉じたあとの次の報告に持ち越さない。通知が消えると pointerleave や blur は
  // 届かないので、触れている印もここで戻す
  useEffect(() => {
    if (status !== "done") setListOpen(false);
    if (status === "idle") {
      setFocused(false);
      setHovering(false);
    }
  }, [status]);

  // 失敗も停止も無い完了の報告は、操作を求めないので閉じなくても下げる。一覧を開いている間は残す
  useEffect(() => {
    if (!succeeded || listOpen || held) return;
    const timer = setTimeout(() => runner.dismiss(), DONE_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [succeeded, listOpen, held, runner]);

  return (
    <>
      {/* 進み具合は 1 ページごとに変わるので、進捗と完了の通知自体は読み上げず、始まりと終わりの文だけをここで
          status として知らせる。空で置いてから後の frame で文を入れ、変化として伝える。
          止まって再試行やログインし直しが要るときは、通知自体を alert にする */}
      <span className="visually-hidden" role="status">
        {ready ? announcementOf(state) : ""}
      </span>
      <LinkRewriteNotice
        runner={runner}
        state={state}
        onListToggle={setListOpen}
        interaction={{
          onFocus: () => setFocused(true),
          onBlur: (event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
          },
          onPointerEnter: () => setHovering(true),
          onPointerLeave: () => setHovering(false),
        }}
      />
    </>
  );
}

function LinkRewriteNotice({
  runner,
  state,
  onListToggle,
  interaction,
}: {
  runner: LinkRewriteRunner;
  state: LinkRewriteState;
  onListToggle: (open: boolean) => void;
  interaction: NoticeInteraction;
}) {
  const { status, done, total, rewritten, failed, stopReason } = state;

  if (status === "idle") return null;
  if (status === "running") {
    if (total === 0) return null;
    return (
      <Notice
        key="report"
        tone="info"
        silent
        interaction={interaction}
        title={RUNNING_ANNOUNCEMENT}
      >
        <p>
          {done}/{total}
          ページを書き換えました。この画面を閉じても、残りは次に開いたときに続きから進みます。
        </p>
      </Notice>
    );
  }

  const publicCount = rewritten.filter((page) => page.visibility === "public").length;
  const stoppedForAuth = stopReason === "auth";
  const stoppedForError = stopReason === "error";
  return (
    // 停止の通知は、進捗や完了の通知から role を切り替えず、別の要素として挿入して alert に読み上げさせる
    // （既存の要素の role が変わっても、支援技術は読み上げない）
    <Notice
      key={status === "stopped" ? "stopped" : "report"}
      tone={status === "stopped" || failed.length > 0 ? "warn" : "info"}
      role="alert"
      silent={status !== "stopped"}
      interaction={interaction}
      title={resultTitle(state)}
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
        <p>書き込みが拒否されました。ログインし直すと、残りを続きから書き換えます。</p>
      )}
      {stoppedForError && <p>時間をおいて、再試行してください。</p>}
      {rewritten.length > 0 && (
        <details onToggle={(event) => onListToggle(event.currentTarget.open)}>
          <summary>
            {publicCount > 0
              ? `書き換えたページ（${rewritten.length}件、うち公開${publicCount}件）`
              : `書き換えたページ（${rewritten.length}件）`}
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
          <p>次のページには、前のタイトルへのリンクが残っています。開いて直してください。</p>
          <ul className="link-rewrites-pages">
            {failed.map((page) => (
              <li key={page.id}>
                <Link href={pageHref(page.id)}>{failedPageLabel(page)}</Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </Notice>
  );
}
