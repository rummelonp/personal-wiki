import { conflictRows } from "./conflict-diff";
import type { Draft } from "./editor-session";
import { formatTime } from "./format";
import { Notice } from "./Notice";
import type { Page } from "./pages-api";

const MARKS = { equal: " ", delete: "−", insert: "＋" } as const;

interface ConflictPanelProps {
  server: Page;
  local: Draft;
  busy: boolean;
  onOverwrite: () => void;
  onTakeServer: () => void;
}

/** 保存しようとした版が古かったとき、サーバーの最新と手元の差分を見せて選ばせる。 */
export function ConflictPanel({
  server,
  local,
  busy,
  onOverwrite,
  onTakeServer,
}: ConflictPanelProps) {
  const rows = conflictRows(server.body, local.body);
  const titleChanged = server.title !== local.title;
  // どちらの選択も、選ばなかった側の内容を残さない。取り込みはサーバーの最新を守る側なので主操作にし、
  // 手元の内容でサーバーの最新を置き換える上書きだけ、押す前に確かめる
  function confirmOverwrite() {
    if (window.confirm("手元の内容で、サーバーの最新の内容を置き換えます。よろしいですか？")) {
      onOverwrite();
    }
  }
  return (
    <Notice
      tone="warn"
      title="サーバーの内容と食い違っています"
      actions={
        <>
          <button
            type="button"
            className="button button-main"
            onClick={onTakeServer}
            disabled={busy}
          >
            サーバーの版を取り込む
          </button>
          <button type="button" className="button" onClick={confirmOverwrite} disabled={busy}>
            手元で上書き
          </button>
        </>
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
        サーバーの版を取り込むと手元の変更は消え、手元で上書きするとサーバーの最新が置き換わります。
      </p>
    </Notice>
  );
}
