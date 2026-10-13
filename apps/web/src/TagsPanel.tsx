import { useEffect, useState } from "react";
import { Link } from "./Link";
import { listTags, type TagCount } from "./pages-api";
import { RailSection } from "./Rail";
import { tagHref } from "./route";

/**
 * タグの一覧。null は「出さない」を表す（読み込み中、または API がまだタグを返せない）。
 * 取得に失敗しても一覧の邪魔にならないよう、エラーは表に出さない。
 */
export function useTags(): TagCount[] | null {
  const [tags, setTags] = useState<TagCount[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void listTags().then((res) => {
      if (!cancelled) setTags(res.ok ? res.value : null);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return tags;
}

export function TagsPanel({ tags, active }: { tags: TagCount[]; active: string }) {
  return (
    <RailSection title="タグ">
      {tags.length === 0 ? (
        <p className="muted">タグはまだありません。</p>
      ) : (
        <ul className="chips">
          {tags.map(({ tag, count }) => (
            <li key={tag}>
              <Link
                className="chip chip-link"
                href={tagHref(tag)}
                aria-current={tag === active ? "page" : undefined}
              >
                {tag}
                <span className="chip-count">{count}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </RailSection>
  );
}
