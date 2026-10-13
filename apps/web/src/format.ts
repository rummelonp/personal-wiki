const formatter = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** API の時刻はエポックからのミリ秒。 */
export const formatTime = (ms: number): string => formatter.format(new Date(ms));
