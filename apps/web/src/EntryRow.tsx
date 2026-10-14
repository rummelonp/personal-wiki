import { formatRowTime } from "./format";
import { highlightMatches } from "./highlight";
import { Link } from "./Link";
import { rememberTitle } from "./page-titles";
import type { ListedPage } from "./pages-api";
import { pageHrefFor, tagHref } from "./route";

/**
 * 一覧の 1 行（タイトル、抜粋、更新日、タグ）。配置は持たず、並べ方は呼び出し側が決める。
 * highlight は検索語で、title と抜粋のうち、検索 API が一致とみなす箇所（語全体の部分一致）を強調する。
 * showVisibility は公開の印を出すか。新しいページは draft から始まるので、draft に印を付けると
 * ほぼ全行に付いて区別にならない。公開の行にだけ印を付け、draft は印なしで読ませる。
 * 匿名の一覧は全行が公開なので出さない。
 */
export function EntryRow({
  entry,
  now,
  highlight = "",
  showVisibility = false,
}: {
  entry: ListedPage;
  now: number;
  highlight?: string;
  showVisibility?: boolean;
}) {
  // API は語の空白を畳まずに探すが、返す抜粋は空白の並びを 1 つの空白にしてあるので、抜粋の側だけ語も畳む
  const excerptNeedles = [highlight.replace(/\s+/g, " ")];
  const titleNeedles = [highlight];
  return (
    <li className="entry">
      <div className="entry-head">
        <Link
          className="entry-title"
          href={pageHrefFor(entry)}
          onClick={() => rememberTitle(entry.id, entry.title)}
        >
          {highlightMatches(entry.title, titleNeedles)}
        </Link>
        {showVisibility && entry.visibility === "public" && (
          <span className="chip chip-public">公開</span>
        )}
        <time className="entry-time" dateTime={new Date(entry.updatedAt).toISOString()}>
          {formatRowTime(entry.updatedAt, now)}
        </time>
      </div>
      {entry.excerpt !== undefined && entry.excerpt !== "" && (
        <p className="entry-excerpt">{highlightMatches(entry.excerpt, excerptNeedles)}</p>
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
  showVisibility = false,
}: {
  entries: ListedPage[];
  now: number;
  highlight?: string;
  showVisibility?: boolean;
}) {
  return (
    <ul className="entries">
      {entries.map((entry) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          now={now}
          highlight={highlight}
          showVisibility={showVisibility}
        />
      ))}
    </ul>
  );
}
