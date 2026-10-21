import type { DiffRow } from "./conflict-diff";

const MARKS = { equal: " ", delete: "−", insert: "＋" } as const;

interface DiffRowsProps {
  rows: readonly DiffRow[];
  /** 色と記号を見ない読み手に、delete と insert の行がどちらの内容かを伝える */
  notes: { delete: string; insert: string };
}

/**
 * 差分の記号の凡例。「−」の説明と「＋」の説明を、それぞれ折り返さない塊にする。
 * 文節の判定に任せると、幅によって 1〜2 字だけが次の行に残る。塊のままでは収まらない幅だけ、塊の中で折り返す。
 */
export function DiffLegend({ removed, added }: { removed: string; added: string }) {
  return (
    <p className="muted diff-legend">
      <span className="diff-legend-clause">−&nbsp;は{removed}、</span>
      <span className="diff-legend-clause">＋&nbsp;は{added}</span>
    </p>
  );
}

/** 行の差分。衝突の確認と版の差分で、同じ見た目と読み上げにする */
export function DiffRows({ rows, notes }: DiffRowsProps) {
  return (
    <div className="diff">
      {rows.map((row, index) =>
        row.kind === "skip" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 差分の行に安定した id は無い
          <div key={index} className="diff-skip muted">
            … {row.count}行は同じ …
          </div>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: 同上
          <div key={index} className={`diff-row diff-${row.kind}`}>
            <span className="diff-mark" aria-hidden="true">
              {MARKS[row.kind]}
            </span>
            <span className="diff-text">{row.text === "" ? " " : row.text}</span>
            <span className="visually-hidden">{row.kind === "equal" ? "" : notes[row.kind]}</span>
          </div>
        ),
      )}
    </div>
  );
}
