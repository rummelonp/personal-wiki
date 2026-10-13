import { diffLines, type LineDiff } from "@personal-wiki/markdown";

export type DiffRow = LineDiff | { kind: "skip"; count: number };

/**
 * 変更行の前後 `context` 行だけを残し、離れた一致行は件数に畳む。
 * 長いページの衝突でも、変わった箇所だけを並べて確認できるようにする。
 */
export function collapseDiff(lines: readonly LineDiff[], context = 2): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === "equal") return;
    const from = Math.max(0, index - context);
    const to = Math.min(lines.length - 1, index + context);
    for (let i = from; i <= to; i++) keep[i] = true;
  });
  const rows: DiffRow[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped > 0) rows.push({ kind: "skip", count: skipped });
      skipped = 0;
      rows.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) rows.push({ kind: "skip", count: skipped });
  return rows;
}

/** サーバーの本文から手元の本文への差分。delete はサーバーだけにある行、insert は手元だけにある行。 */
export function conflictRows(serverBody: string, localBody: string): DiffRow[] {
  return collapseDiff(diffLines(serverBody, localBody));
}
