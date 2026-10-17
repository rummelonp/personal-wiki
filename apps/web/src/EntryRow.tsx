import type { ReactNode } from "react";
import { formatRelativeTime, formatTime } from "./format";
import { highlightMatches } from "./highlight";
import { Link } from "./Link";
import { rememberTitle } from "./page-titles";
import type { ListedPage } from "./pages-api";
import { listHref, pageHrefFor, type VisibilityFilter } from "./route";

/**
 * 一覧の 1 行（タイトル、抜粋、更新日、タグ）。配置は持たず、並べ方は呼び出し側が決める。
 * highlight は検索語で、title と抜粋のうち、検索 API が一致とみなす箇所（語全体の部分一致）を強調する。
 * showVisibility は公開範囲の印（公開、下書き）を出すか。匿名の一覧は全行が公開なので出さない。
 * visibility は一覧の公開範囲の絞り込みで、行のタグを押しても外さずに保つ。
 */
export function EntryRow({
  entry,
  now,
  highlight = "",
  showVisibility = false,
  visibility = "",
}: {
  entry: ListedPage;
  now: number;
  highlight?: string;
  showVisibility?: boolean;
  visibility?: VisibilityFilter;
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
        {showVisibility && <VisibilityMark visibility={entry.visibility} />}
        <time
          className="entry-time"
          dateTime={new Date(entry.updatedAt).toISOString()}
          title={formatTime(entry.updatedAt)}
        >
          {formatRelativeTime(entry.updatedAt, now)}
          {/* タッチ端末と読み上げには hover の title が届かないので、絶対の日時を読み上げにだけ足す */}
          <span className="visually-hidden">{`（${formatTime(entry.updatedAt)}）`}</span>
        </time>
      </div>
      {entry.excerpt !== undefined && entry.excerpt !== "" && (
        <p className="entry-excerpt">{highlightMatches(entry.excerpt, excerptNeedles)}</p>
      )}
      {entry.tags.length > 0 && (
        <ul className="chips">
          {entry.tags.map((tag) => (
            <li key={tag}>
              <Link className="chip chip-link" href={listHref({ tag, visibility })}>
                {tag}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** 点は飾りなので読み上げから外し、語だけを読ませる。 */
function VisibilityMark({ visibility }: { visibility: ListedPage["visibility"] }) {
  const isPublic = visibility === "public";
  return (
    <span className={`entry-visibility entry-visibility-${visibility}`}>
      <span aria-hidden="true">{isPublic ? "●" : "○"}</span>
      {isPublic ? "公開" : "下書き"}
    </span>
  );
}

export function EntryList({
  entries,
  now,
  highlight = "",
  showVisibility = false,
  visibility = "",
  className,
  children,
}: {
  entries: ListedPage[];
  now: number;
  highlight?: string;
  showVisibility?: boolean;
  visibility?: VisibilityFilter;
  className?: string | undefined;
  /** 行の後ろに足す要素（読み込み中の帯の行など） */
  children?: ReactNode;
}) {
  return (
    <ul className={className === undefined ? "entries" : `entries ${className}`}>
      {entries.map((entry) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          now={now}
          highlight={highlight}
          showVisibility={showVisibility}
          visibility={visibility}
        />
      ))}
      {children}
    </ul>
  );
}
