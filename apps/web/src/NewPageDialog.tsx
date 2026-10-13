import { type FormEvent, type RefObject, useState } from "react";
import { createPage, failureMessage, findPageByTitle } from "./pages-api";
import { navigate, pageHref } from "./route";

interface NewPageDialogProps {
  dialogRef: RefObject<HTMLDialogElement | null>;
}

type Problem = { message: string; existingId: string | null };

/** title だけで空のページを作り、作れたらそのページの編集画面へ移る。 */
export function NewPageDialog({ dialogRef }: NewPageDialogProps) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  function close() {
    dialogRef.current?.close();
  }

  function reset() {
    setTitle("");
    setProblem(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    setProblem(null);
    const res = await createPage({ title: trimmed, body: "" });
    if (res.ok) {
      setBusy(false);
      close();
      navigate(pageHref(res.value.id));
      return;
    }
    if (res.reason === "title_conflict") {
      const existing = await findPageByTitle(trimmed);
      setProblem({ message: res.message, existingId: existing.ok ? existing.value.id : null });
    } else if (res.reason === "unauthorized") {
      setProblem({
        message: "ログインの期限が切れました。ログインし直してください",
        existingId: null,
      });
    } else {
      setProblem({
        message: failureMessage(res, "作成できなかった"),
        existingId: null,
      });
    }
    setBusy(false);
  }

  return (
    <dialog ref={dialogRef} className="dialog" aria-labelledby="new-page-title" onClose={reset}>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <h2 id="new-page-title" className="dialog-title">
          新規作成
        </h2>
        <label className="field">
          <span className="field-label">title</span>
          <input
            className="text-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
        </label>
        {problem !== null && (
          <p className="message message-error" role="alert">
            {problem.message}
            {problem.existingId !== null && (
              <>
                {" "}
                <a
                  href={pageHref(problem.existingId)}
                  onClick={(event) => {
                    event.preventDefault();
                    close();
                    navigate(pageHref(problem.existingId as string));
                  }}
                >
                  そのページを開く
                </a>
              </>
            )}
          </p>
        )}
        <div className="actions">
          <button
            type="submit"
            className="button button-primary"
            disabled={busy || title.trim() === ""}
          >
            作成
          </button>
          <button type="button" className="button" onClick={close}>
            キャンセル
          </button>
        </div>
      </form>
    </dialog>
  );
}
