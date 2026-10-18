import { diffLines, type LineDiff } from "@personal-wiki/markdown";
import { useEffect, useMemo, useRef, useState } from "react";
import { collapseDiff, type DiffRow } from "./conflict-diff";
import { DiffRows } from "./DiffRows";
import { PendingBody } from "./Loading";
import {
  type ApiFailure,
  failureMessage,
  getRevision,
  LOAD_FAILED,
  listRevisions,
  type Revision,
  type RevisionNotFound,
} from "./pages-api";

/**
 * 1 つ古い版の探し方。版の番号は連続せず（保存のまとめで先頭の版だけ番号が進む）、番号から 1 を引けない。
 * 履歴の一覧で次の行が分かっていればその版、一覧の末尾なら続きの先頭（cursor で取る）、続きも無ければ最初の版。
 */
export type PreviousRef =
  | { kind: "none" }
  | { kind: "known"; version: number }
  | { kind: "after"; cursor: string };

/** 一覧の index の行の 1 つ古い版 */
export function previousOf(
  revisions: readonly { version: number }[],
  index: number,
  next: string | null,
): PreviousRef {
  const older = revisions[index + 1];
  if (older !== undefined) return { kind: "known", version: older.version };
  return next === null ? { kind: "none" } : { kind: "after", cursor: next };
}

type PreviousState =
  | { status: "loading" }
  /** previous が null なら最初の版 */
  | { status: "ready"; previous: Revision | null }
  /** 1 つ古い版が後の保存にまとめられて無くなった */
  | { status: "missing" }
  | { status: "gone" }
  | { status: "error"; message: string };

async function loadPrevious(pageId: string, ref: PreviousRef): Promise<PreviousState> {
  if (ref.kind === "none") return { status: "ready", previous: null };
  let version: number;
  if (ref.kind === "known") {
    version = ref.version;
  } else {
    const list = await listRevisions(pageId, ref.cursor);
    if (!list.ok) return failed(list);
    const first = list.value.revisions[0];
    if (first === undefined) return { status: "ready", previous: null };
    version = first.version;
  }
  const res = await getRevision(pageId, version);
  if (res.ok) return { status: "ready", previous: res.value };
  return failed(res);
}

function failed(res: ApiFailure | RevisionNotFound): PreviousState {
  if (res.reason === "revision_not_found") return { status: "missing" };
  if (res.reason === "not_found") return { status: "gone" };
  return { status: "error", message: failureMessage(res, LOAD_FAILED) };
}

/** previous が null（最初の版）のときは、本文のすべてを足した行として並べる */
export function revisionRows(previousBody: string | null, body: string): DiffRow[] {
  if (previousBody === null) {
    return body.split("\n").map(
      (text, index): LineDiff => ({
        kind: "insert",
        text,
        oldLine: null,
        newLine: index + 1,
      }),
    );
  }
  return collapseDiff(diffLines(previousBody, body));
}

interface RevisionDiffProps {
  pageId: string;
  revision: Revision;
  previous: PreviousRef;
  /** 全文を見ている間は隠す。隠しても取った結果は残り、切り替えで取り直さない */
  hidden: boolean;
  /** 1 つ古い版が無くなっていたとき。一覧が古いので取り直す */
  onPreviousMissing: () => void;
}

/**
 * 版のダイアログの差分。1 つ古い版の本文から、この版の本文への変化を出す。
 * 古い版の取得は、差分を出すこの部品が現れたときだけ行い、ダイアログを閉じると結果を捨てる。
 */
export function RevisionDiff({
  pageId,
  revision,
  previous,
  hidden,
  onPreviousMissing,
}: RevisionDiffProps) {
  const [state, setState] = useState<PreviousState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const onMissingRef = useRef(onPreviousMissing);
  onMissingRef.current = onPreviousMissing;

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt は再試行で取り直すための印
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void loadPrevious(pageId, previous).then((next) => {
      if (cancelled) return;
      setState(next);
      if (next.status === "missing") onMissingRef.current();
    });
    return () => {
      cancelled = true;
    };
  }, [pageId, previous, attempt]);

  const rows = useMemo(
    () =>
      state.status === "ready" ? revisionRows(state.previous?.body ?? null, revision.body) : [],
    [state, revision.body],
  );

  return (
    <div className="revision-diff" hidden={hidden}>
      {state.status === "loading" && <PendingBody />}
      {state.status === "missing" && (
        <p className="muted" role="status">
          前の版が後の保存にまとめられたため、差分を表示できません。履歴を読み込み直しました。
        </p>
      )}
      {state.status === "gone" && (
        <p className="muted" role="status">
          このページは削除されたため、前の版を表示できません。
        </p>
      )}
      {state.status === "error" && (
        <div className="revision-diff-error" role="status">
          <p className="muted">前の版を取得できませんでした。{state.message}</p>
          <button
            type="button"
            className="button button-compact"
            onClick={() => setAttempt((n) => n + 1)}
          >
            再試行
          </button>
        </div>
      )}
      {state.status === "ready" && (
        <DiffContent previous={state.previous} revision={revision} rows={rows} />
      )}
    </div>
  );
}

function DiffContent({
  previous,
  revision,
  rows,
}: {
  previous: Revision | null;
  revision: Revision;
  rows: readonly DiffRow[];
}) {
  const titleChanged = previous !== null && previous.title !== revision.title;
  const hasDiff = rows.some((row) => row.kind === "insert" || row.kind === "delete");
  return (
    <>
      {titleChanged && (
        <dl className="conflict-titles revision-diff-titles">
          <dt>前の版のタイトル</dt>
          <dd>{previous.title}</dd>
          <dt>この版のタイトル</dt>
          <dd>{revision.title}</dd>
        </dl>
      )}
      {previous === null && (
        <p className="muted diff-legend">
          最初の版です。本文のすべてを、加わった行として出しています。
        </p>
      )}
      {previous !== null && hasDiff && (
        <p className="muted diff-legend">
          −&nbsp;は前の版だけにある行、＋&nbsp;はこの版で加わった行
        </p>
      )}
      {previous !== null && !hasDiff && (
        <p className="muted">
          {titleChanged ? "本文は前の版と同じです。" : "前の版との差分はありません。"}
        </p>
      )}
      {(previous === null || hasDiff) && (
        <DiffRows
          rows={rows}
          notes={{ delete: "（前の版だけにある行）", insert: "（この版で加わった行）" }}
        />
      )}
    </>
  );
}
