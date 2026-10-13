import { conflictRows } from "./conflict-diff";
import type { Draft } from "./editor-session";
import { formatTime } from "./format";
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
  return (
    <section className="conflict" role="alert" aria-labelledby="conflict-title">
      <h2 id="conflict-title" className="conflict-title">
        サーバーの内容と食い違っています
      </h2>
      <p>
        このページは別の場所で更新されました（{formatTime(server.updatedAt)}）。
        手元の変更は消えずに残っています。 どちらを残すか選んでください。
      </p>
      {titleChanged && (
        <dl className="conflict-titles">
          <dt>サーバーの title</dt>
          <dd>{server.title}</dd>
          <dt>手元の title</dt>
          <dd>{local.title}</dd>
        </dl>
      )}
      {rows.length === 0 ? (
        <p className="muted">本文に差分はありません。</p>
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
      <div className="actions">
        <button
          type="button"
          className="button button-primary"
          onClick={onOverwrite}
          disabled={busy}
        >
          手元で上書き
        </button>
        <button type="button" className="button" onClick={onTakeServer} disabled={busy}>
          サーバーの版を取り込む（手元の変更は破棄）
        </button>
      </div>
    </section>
  );
}
