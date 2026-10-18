const formatter = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** API の時刻はエポックからのミリ秒。 */
export const formatTime = (ms: number): string => formatter.format(new Date(ms));

const MINUTES_IN_DAY = 1440;
const MINUTES_IN_MONTH = 43200;
const MINUTES_IN_YEAR = 525600;

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/**
 * 1 年以上の経過の表記。端数が年の四分の一未満なら「約n年」、四分の三未満なら「n年以上」、
 * それ以上なら「n年近く」（n + 1 年に近い）。間に入るうるう日の分は経過から引く。
 */
function formatYears(minutes: number, from: Date, to: Date): string {
  const fromYear = from.getFullYear() + (from.getMonth() >= 2 ? 1 : 0);
  const toYear = to.getFullYear() - (to.getMonth() < 2 ? 1 : 0);
  let leapDays = 0;
  for (let year = fromYear; year <= toYear; year++) if (isLeapYear(year)) leapDays++;
  const offset = minutes - leapDays * MINUTES_IN_DAY;
  const remainder = offset % MINUTES_IN_YEAR;
  // うるう日を引くと 1 年に満たないことがあり、そのときは years が 0 で「1年近く」になる
  const years = Math.floor(offset / MINUTES_IN_YEAR);
  if (remainder < MINUTES_IN_YEAR / 4) return `約${years}年前`;
  if (remainder < (MINUTES_IN_YEAR * 3) / 4) return `${years}年以上前`;
  return `${years + 1}年近く前`;
}

/**
 * 一覧の行の更新日。区切りは Rails の distance_of_time_in_words（秒の表記なし）に合わせる。
 * 端末の時計がサーバーより進んでいると更新が未来になるので、経過 0 として扱い「1分未満」にする。
 * 「1分未満」は「前」を付けると読みづらいので付けない。
 */
export function formatRelativeTime(ms: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 1) return "1分未満";
  if (minutes < 45) return `${minutes}分前`;
  if (minutes < 90) return "約1時間前";
  if (minutes < MINUTES_IN_DAY) return `約${Math.round(minutes / 60)}時間前`;
  if (minutes < 2520) return "1日前";
  if (minutes < MINUTES_IN_MONTH) return `${Math.round(minutes / MINUTES_IN_DAY)}日前`;
  if (minutes < MINUTES_IN_MONTH * 2) return `約${Math.round(minutes / MINUTES_IN_MONTH)}か月前`;
  if (minutes < MINUTES_IN_YEAR) return `${Math.round(minutes / MINUTES_IN_MONTH)}か月前`;
  return formatYears(minutes, new Date(ms), new Date(now));
}
