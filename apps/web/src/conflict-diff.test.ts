import { describe, expect, it } from "vitest";
import { conflictRows } from "./conflict-diff";

const lines = (count: number) => Array.from({ length: count }, (_, i) => `行${i}`);

describe("conflictRows", () => {
  it("同じ本文なら差分は空（件数に畳むだけ）", () => {
    expect(conflictRows("a\nb", "a\nb")).toEqual([{ kind: "skip", count: 2 }]);
  });

  it("変更行の前後 2 行を残し、離れた一致行は件数に畳む", () => {
    const server = lines(20);
    const local = [...server];
    local[10] = "変更";
    const rows = conflictRows(server.join("\n"), local.join("\n"));
    expect(rows.map((row) => (row.kind === "skip" ? `skip:${row.count}` : row.kind))).toEqual([
      "skip:8",
      "equal",
      "equal",
      "delete",
      "insert",
      "equal",
      "equal",
      "skip:7",
    ]);
  });

  it("delete はサーバーだけの行、insert は手元だけの行", () => {
    const rows = conflictRows("サーバー", "手元");
    expect(rows).toMatchObject([
      { kind: "delete", text: "サーバー" },
      { kind: "insert", text: "手元" },
    ]);
  });
});
