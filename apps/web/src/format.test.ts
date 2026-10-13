import { describe, expect, it } from "vitest";
import { formatRowTime } from "./format";

// ローカルのタイムゾーンで組み立てるので、実行環境の TZ に依らない
const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

describe("formatRowTime", () => {
  const now = at(2026, 10, 14, 12);

  it("今日は時刻だけを出す", () => {
    expect(formatRowTime(at(2026, 10, 14, 9, 5), now)).toBe("09:05");
  });

  it("今年の別の日は月日、前の年は年も出す", () => {
    expect(formatRowTime(at(2026, 10, 13, 23, 59), now)).toBe("10/13");
    expect(formatRowTime(at(2025, 12, 31), now)).toBe("2025/12/31");
  });
});
