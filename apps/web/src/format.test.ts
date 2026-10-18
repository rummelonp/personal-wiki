import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./format";

// ローカルのタイムゾーンで組み立てるので、実行環境の TZ に依らない
const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

describe("formatRelativeTime", () => {
  const now = at(2026, 10, 17, 12);
  const ago = (ms: number) => formatRelativeTime(now - ms, now);

  it("30 秒未満は「1分未満」、30 秒からは分にする", () => {
    expect(ago(0)).toBe("1分未満");
    expect(ago(29 * SECOND)).toBe("1分未満");
    expect(ago(29.5 * SECOND - 1)).toBe("1分未満");
    expect(ago(30 * SECOND)).toBe("1分前");
    expect(ago(3 * MINUTE)).toBe("3分前");
  });

  it("未来の時刻（時計のずれ）は「1分未満」にする", () => {
    expect(formatRelativeTime(now + 5 * MINUTE, now)).toBe("1分未満");
  });

  it("44 分 30 秒未満は分、そこから 89 分 30 秒未満は「約1時間」", () => {
    expect(ago(44 * MINUTE + 29 * SECOND)).toBe("44分前");
    expect(ago(44 * MINUTE + 30 * SECOND)).toBe("約1時間前");
    expect(ago(89 * MINUTE + 29 * SECOND)).toBe("約1時間前");
  });

  it("89 分 30 秒からは時間にする", () => {
    expect(ago(89 * MINUTE + 30 * SECOND)).toBe("約2時間前");
    expect(ago(5 * 60 * MINUTE)).toBe("約5時間前");
    expect(ago(23 * 60 * MINUTE)).toBe("約23時間前");
  });

  it("24 時間から 42 時間未満は「1日」、42 時間からは日にする", () => {
    expect(ago(DAY)).toBe("1日前");
    expect(ago(41 * 60 * MINUTE + 59 * MINUTE)).toBe("1日前");
    expect(ago(42 * 60 * MINUTE)).toBe("2日前");
    expect(ago(5 * DAY)).toBe("5日前");
    expect(ago(29 * DAY)).toBe("29日前");
  });

  it("30 日からは月にする。2 か月未満は「約」を付ける", () => {
    expect(ago(30 * DAY - MINUTE)).toBe("30日前");
    expect(ago(30 * DAY)).toBe("約1か月前");
    expect(ago(60 * DAY - MINUTE)).toBe("約2か月前");
    expect(ago(60 * DAY)).toBe("2か月前");
    expect(ago(364 * DAY)).toBe("12か月前");
  });

  it("45 日（1.5 か月）で「約1か月」から「約2か月」に変わる", () => {
    expect(ago(45 * DAY - MINUTE)).toBe("約1か月前");
    expect(ago(45 * DAY)).toBe("約2か月前");
    expect(ago(59 * DAY)).toBe("約2か月前");
  });

  it("1 年からは端数で「約n年」「n年以上」「n年近く」に分ける", () => {
    expect(formatRelativeTime(at(2025, 10, 17, 12), now)).toBe("約1年前");
    expect(formatRelativeTime(at(2025, 6, 17, 12), now)).toBe("1年以上前");
    expect(formatRelativeTime(at(2025, 1, 17, 12), now)).toBe("1年以上前");
    expect(formatRelativeTime(at(2024, 12, 1, 12), now)).toBe("2年近く前");
    expect(formatRelativeTime(at(2023, 10, 17, 12), now)).toBe("約3年前");
  });

  it("うるう日を含む 1 年も「約1年」にする", () => {
    // 2024-03-01 から 2025-03-01 の間は 2025 年にうるう日が無く、2023-03-01 からは 2024-02-29 を含む
    const base = at(2025, 3, 1, 12);
    expect(formatRelativeTime(at(2024, 3, 1, 12), base)).toBe("約1年前");
    expect(formatRelativeTime(at(2023, 3, 1, 12), base)).toBe("約2年前");
  });

  it("うるう日をまたいで 1 年に 1 日足りないときは「1年近く」にする", () => {
    expect(formatRelativeTime(at(2024, 2, 15, 12), at(2025, 2, 14, 12))).toBe("1年近く前");
    expect(formatRelativeTime(at(2023, 6, 1, 12), at(2024, 5, 31, 12))).toBe("1年近く前");
    expect(formatRelativeTime(at(2025, 3, 1, 12), at(2026, 3, 1, 12))).toBe("約1年前");
  });
});
