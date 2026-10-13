const formatter = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** API の時刻はエポックからのミリ秒。 */
export const formatTime = (ms: number): string => formatter.format(new Date(ms));

const clock = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" });
/** 一覧の行の更新日。今日なら時刻、今年なら月日、それより前は年も付ける。 */
export function formatRowTime(ms: number, now: number): string {
  const at = new Date(ms);
  const today = new Date(now);
  if (at.getFullYear() !== today.getFullYear())
    return `${at.getFullYear()}/${at.getMonth() + 1}/${at.getDate()}`;
  if (at.getMonth() !== today.getMonth() || at.getDate() !== today.getDate()) {
    return `${at.getMonth() + 1}/${at.getDate()}`;
  }
  return clock.format(at);
}
