import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { conflictRows } from "./conflict-diff";
import type { Draft } from "./editor-session";
import { formatTime } from "./format";
import { Notice } from "./Notice";
import type { Page } from "./pages-api";

const MARKS = { equal: " ", delete: "−", insert: "＋" } as const;

type Choice = "take" | "overwrite";

/** 選んだ内容を実行する前に、失われるものを言い切って確かめる。 */
const CONFIRMS: Record<Choice, { question: string; run: string }> = {
  take: { question: "手元の変更を破棄して、サーバーの版を取り込みますか？", run: "取り込む" },
  overwrite: { question: "手元の内容で、サーバーの版を置き換えますか？", run: "上書きする" },
};

interface ConflictPanelProps {
  server: Page;
  local: Draft;
  busy: boolean;
  onOverwrite: () => void;
  onTakeServer: () => void;
}

/** 保存しようとした版が古かったとき、サーバーの版と手元の差分を見せて選ばせる。 */
export function ConflictPanel({
  server,
  local,
  busy,
  onOverwrite,
  onTakeServer,
}: ConflictPanelProps) {
  const rows = conflictRows(server.body, local.body);
  const titleChanged = server.title !== local.title;
  // どちらの選択も、選ばなかった側の内容が唯一の写しごと消える。どちらを主操作にもせず、
  // 押す前に両方とも確かめる。確認は window.confirm ではなく通知の中で行う。ブラウザが
  // ダイアログを抑止していると confirm は何も出さずに false を返し、操作が理由なく止まるため
  const [choice, setChoice] = useState<Choice | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const take = useRef<HTMLButtonElement>(null);
  const overwrite = useRef<HTMLButtonElement>(null);
  const questionId = useId();
  // 確認をやめたとき、focus を戻す先。確認の操作は消えるので、戻すのは選び直しの操作が描かれた後にする
  const returnTo = useRef<{ button: Choice; heading: HTMLElement | null } | null>(null);
  useEffect(() => {
    if (choice !== null) cancel.current?.focus();
  }, [choice]);
  useLayoutEffect(() => {
    const back = returnTo.current;
    if (choice !== null || back === null) return;
    returnTo.current = null;
    const button = (back.button === "take" ? take : overwrite).current;
    // 取り込み中などで押せないボタンには focus が入らず、body に落ちる。そのときは通知の見出しに戻す
    if (button !== null && !button.disabled) button.focus();
    else back.heading?.focus();
  }, [choice]);
  function leave(): void {
    if (choice === null) return;
    returnTo.current = {
      button: choice,
      heading:
        cancel.current?.closest(".notice")?.querySelector<HTMLElement>(".notice-title") ?? null,
    };
    setChoice(null);
  }
  function run(): void {
    const selected = choice;
    setChoice(null);
    if (selected === "take") onTakeServer();
    else if (selected === "overwrite") onOverwrite();
  }
  const confirm = choice === null ? null : CONFIRMS[choice];
  return (
    <Notice
      tone="warn"
      title="サーバーの内容と食い違っています"
      claimFocus
      actions={
        confirm === null ? (
          <>
            <button
              ref={take}
              type="button"
              className="button"
              onClick={() => setChoice("take")}
              disabled={busy}
            >
              サーバーの版を取り込む
            </button>
            <button
              ref={overwrite}
              type="button"
              className="button"
              onClick={() => setChoice("overwrite")}
              disabled={busy}
            >
              手元で上書き
            </button>
          </>
        ) : (
          <>
            <p id={questionId} className="notice-question">
              {confirm.question}
            </p>
            <button
              type="button"
              className="button"
              aria-describedby={questionId}
              onClick={run}
              disabled={busy}
            >
              {confirm.run}
            </button>
            <button
              ref={cancel}
              type="button"
              className="button"
              aria-describedby={questionId}
              onClick={leave}
            >
              やめる
            </button>
          </>
        )
      }
      details={
        <div className="notice-details">
          {titleChanged && (
            <dl className="conflict-titles">
              <dt>サーバーの title</dt>
              <dd>{server.title}</dd>
              <dt>手元の title</dt>
              <dd>{local.title}</dd>
            </dl>
          )}
          {rows.every((row) => row.kind === "skip") ? (
            <p className="notice-text muted">本文に差分はありません。</p>
          ) : (
            <div className="diff">
              {rows.map((row, index) =>
                row.kind === "skip" ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 差分の行に安定した id は無い
                  <div key={index} className="diff-skip muted">
                    … {row.count} 行は同じ …
                  </div>
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 同上
                  <div key={index} className={`diff-row diff-${row.kind}`}>
                    <span className="diff-mark" aria-hidden="true">
                      {MARKS[row.kind]}
                    </span>
                    <span className="diff-text">{row.text === "" ? " " : row.text}</span>
                    <span className="visually-hidden">
                      {row.kind === "delete"
                        ? "（サーバーだけにある行）"
                        : row.kind === "insert"
                          ? "（手元だけにある行）"
                          : ""}
                    </span>
                  </div>
                ),
              )}
            </div>
          )}
          <p className="muted diff-legend">− はサーバーだけにある行、＋ は手元だけにある行</p>
        </div>
      }
    >
      <p>
        このページは別の場所で更新されました（{formatTime(server.updatedAt)}
        ）。どちらを残すか選んでください。
      </p>
      <p>
        サーバーの版を取り込むと手元の変更は消え、手元で上書きするとサーバーの版が置き換わります。
      </p>
    </Notice>
  );
}
