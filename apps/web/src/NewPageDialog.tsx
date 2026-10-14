import { type FormEvent, type RefObject, useState } from "react";
import { type CreateProblem, CreateProblemMessage, createPageAndOpen } from "./create-page";

interface NewPageDialogProps {
  dialogRef: RefObject<HTMLDialogElement | null>;
}

/** title だけで空のページを作り、作れたらそのページの編集画面へ移る。 */
export function NewPageDialog({ dialogRef }: NewPageDialogProps) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<CreateProblem | null>(null);

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
    const failed = await createPageAndOpen(trimmed);
    setBusy(false);
    if (failed === null) close();
    else setProblem(failed);
  }

  return (
    <dialog ref={dialogRef} className="dialog" aria-labelledby="new-page-title" onClose={reset}>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <h2 id="new-page-title" className="dialog-title">
          新規作成
        </h2>
        <label className="field">
          <span className="field-label">タイトル</span>
          <input
            className="text-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
        </label>
        {problem !== null && <CreateProblemMessage problem={problem} onOpenExisting={close} />}
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
