import { formatRowTime } from "./format";
import { highlightMatches } from "./highlight";
import { Link } from "./Link";
import type { ListedPage } from "./pages-api";
import { pageHrefFor, tagHref } from "./route";

/**
 * 一覧の 1 行（タイトル、抜粋、更新日、タグ）。配置は持たず、並べ方は呼び出し側が決める。
 * highlight は検索語で、title と抜粋のうち、検索 API が一致とみなす箇所（語全体の部分一致）を強調する。
 */
export function EntryRow({
  entry,
  now,
  highlight = "",
}: {
  entry: ListedPage;
  now: number;
  highlight?: string;
}) {
  const needles = [highlight];
  return (
    <li className="entry">
      <div className="entry-head">
        <Link className="entry-title" href={pageHrefFor(entry)}>
          {highlightMatches(entry.title, needles)}
        </Link>
        {entry.visibility === "draft" && <span className="chip chip-draft">下書き</span>}
        <time className="entry-time" dateTime={new Date(entry.updatedAt).toISOString()}>
          {formatRowTime(entry.updatedAt, now)}
        </time>
      </div>
      {entry.excerpt !== undefined && entry.excerpt !== "" && (
        <p className="entry-excerpt">{highlightMatches(entry.excerpt, needles)}</p>
      )}
      {entry.tags.length > 0 && (
        <ul className="chips">
          {entry.tags.map((tag) => (
            <li key={tag}>
              <Link className="chip chip-link" href={tagHref(tag)}>
                {tag}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function EntryList({
  entries,
  now,
  highlight = "",
}: {
  entries: ListedPage[];
  now: number;
  highlight?: string;
}) {
  return (
    <ul className="entries">
      {entries.map((entry) => (
        <EntryRow key={entry.id} entry={entry} now={now} highlight={highlight} />
      ))}
    </ul>
  );
}
