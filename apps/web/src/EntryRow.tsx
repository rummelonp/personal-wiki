import { formatRowTime } from "./format";
import { Link } from "./Link";
import type { ListedPage } from "./pages-api";
import { pageHrefFor, tagHref } from "./route";

/** 一覧の 1 行（タイトル、抜粋、更新日、タグ）。配置は持たず、並べ方は呼び出し側が決める。 */
export function EntryRow({ entry, now }: { entry: ListedPage; now: number }) {
  return (
    <li className="entry">
      <div className="entry-head">
        <Link className="entry-title" href={pageHrefFor(entry)}>
          {entry.title}
        </Link>
        {entry.visibility === "draft" && <span className="chip chip-draft">下書き</span>}
        <time className="entry-time" dateTime={new Date(entry.updatedAt).toISOString()}>
          {formatRowTime(entry.updatedAt, now)}
        </time>
      </div>
      {entry.excerpt !== undefined && entry.excerpt !== "" && (
        <p className="entry-excerpt">{entry.excerpt}</p>
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

export function EntryList({ entries, now }: { entries: ListedPage[]; now: number }) {
  return (
    <ul className="entries">
      {entries.map((entry) => (
        <EntryRow key={entry.id} entry={entry} now={now} />
      ))}
    </ul>
  );
}
