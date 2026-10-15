import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { conflictRows } from "./conflict-diff";
import type { Draft } from "./editor-session";
import { formatTime } from "./format";
import { focusAfterInput } from "./input-modality";
import { Notice } from "./Notice";
import type { Page } from "./pages-api";

const MARKS = { equal: " ", delete: "−", insert: "＋" } as const;

type Choice = "take" | "overwrite";

/** 選んだ内容を実行する前に、失われるものを言い切って確かめる。 */
const CONFIRMS: Record<Choice, { question: string; run: string }> = {
  take: { question: "手元の変更を破棄して、サーバーの版を取り込みますか？", run: "取り込む" },
  overwrite: {
    question: "サーバーの版を破棄して、手元の内容で上書きしますか？",
    run: "上書きする",
  },
};

interface ConflictPanelProps {
  server: Page;
  local: Draft;
  busy: boolean;
  onOverwrite: () => void;
  onTakeServer: () => void;
}

/**
 * 差分の欄の最初の変更が見えるようにスクロールする。見えていれば動かさない。
 * 見せる単位は最初の変更の組（− の行と、すぐ後ろの ＋ の行）で、欄に収まらなければ − の行だけにする。
 * 動かすときは、直前の共通の行から始めて文脈を見せる。ただし直前の行から組までが欄に収まらないときは、
 * 組が半端に切れるより文脈を捨てて、最初の変更の行を上端に置く。
 * 欄が隠れている間（キーボードが出ている間など）は測れないので false を返し、呼び出し側が見えてから呼び直す。
 */
function revealFirstChange(scroller: HTMLElement): boolean {
  const first = scroller.querySelector<HTMLElement>(".diff-insert, .diff-delete");
  if (first === null) return true;
  const room = scroller.clientHeight;
  if (room === 0) return false;
  const spanOf = (from: HTMLElement, to: HTMLElement) =>
    to.offsetTop + to.offsetHeight - from.offsetTop;
  const next = first.nextElementSibling;
  const pairEnd =
    first.classList.contains("diff-delete") &&
    next instanceof HTMLElement &&
    next.classList.contains("diff-insert")
      ? next
      : first;
  const group = spanOf(first, pairEnd) <= room ? pairEnd : first;
  const visibleTop = first.offsetTop - scroller.scrollTop;
  if (visibleTop >= 0 && visibleTop + spanOf(first, group) <= room) return true;
  const before = first.previousElementSibling;
  const start = before instanceof HTMLElement && spanOf(before, group) <= room ? before : first;
  // offsetTop の基準は position: relative の .notice-details。scrollIntoView は台そのものをスクロールしうる
  scroller.scrollTop = start.offsetTop;
  return true;
}

/** 保存しようとした版が古かったとき、サーバーの版と手元の差分を見せて選ばせる。 */
export function ConflictPanel({
  server,
  local,
  busy,
  onOverwrite,
  onTakeServer,
}: ConflictPanelProps) {
  const rows = useMemo(() => conflictRows(server.body, local.body), [server.body, local.body]);
  const hasDiff = rows.some((row) => row.kind !== "skip");
  const titleChanged = server.title !== local.title;
  // 最初の変更の位置と中身（組なら − と ＋ の両方）。欄を送り直す条件で、後ろの行を打っても変わらない
  const firstChange = useMemo(() => {
    const at = rows.findIndex((row) => row.kind === "insert" || row.kind === "delete");
    if (at < 0) return "";
    const pair = rows[at]?.kind === "delete" && rows[at + 1]?.kind === "insert" ? 2 : 1;
    return JSON.stringify([at, rows.slice(at, at + pair), titleChanged]);
  }, [rows, titleChanged]);
  // どちらの選択も、選ばなかった側の内容が唯一の写しごと消える。どちらを主操作にもせず、
  // 押す前に両方とも確かめる。確認は window.confirm ではなく通知の中で行う。ブラウザが
  // ダイアログを抑止していると confirm は何も出さずに false を返し、操作が理由なく止まるため
  const [choice, setChoice] = useState<Choice | null>(null);
  // 通知は台の用意ができてから描かれるので、要素が現れたときに送れるよう state で持つ
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
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
    else if (back.heading !== null) focusAfterInput(back.heading);
  }, [choice]);
  // 差分の最初の変更の前に共通の行が続くと、最初の表示に − と ＋ が見えない。最初の変更の位置か中身が
  // 変わったときだけ送り、確認の操作や本文の打鍵で描き直しても動かさない。欄が隠れる（キーボードや畳み）
  // 間は測れないので、隠れて戻ったときも 1 度だけ送り直す。それ以外の大きさの変化では動かさない
  // biome-ignore lint/correctness/useExhaustiveDependencies: 送り直す条件は firstChange だけで決める
  useLayoutEffect(() => {
    if (scroller === null) return;
    let pending = !revealFirstChange(scroller);
    const observer = new ResizeObserver(() => {
      if (scroller.clientHeight === 0) pending = true;
      else if (pending) pending = !revealFirstChange(scroller);
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [firstChange, scroller]);
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
        <>
          {/* 凡例と title は差分の欄の外に置き、差分をスクロールしても見え続けるようにする */}
          <div className="conflict-summary">
            {titleChanged && (
              <dl className="conflict-titles">
                <dt>サーバーの title</dt>
                <dd>{server.title}</dd>
                <dt>手元の title</dt>
                <dd>{local.title}</dd>
              </dl>
            )}
            {hasDiff ? (
              <p className="muted diff-legend">− はサーバーだけにある行、＋ は手元だけにある行</p>
            ) : (
              <p className="notice-text muted">本文に差分はありません。</p>
            )}
          </div>
          {hasDiff && (
            <div className="notice-details" ref={setScroller}>
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
            </div>
          )}
        </>
      }
    >
      <p>
        このページは別の場所で更新されました（{formatTime(server.updatedAt)}
        ）。どちらを残すか選んでください。
      </p>
    </Notice>
  );
}
