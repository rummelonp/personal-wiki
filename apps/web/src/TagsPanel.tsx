import { useEffect, useState } from "react";
import { Link } from "./Link";
import { listTags, type TagCount } from "./pages-api";
import { RailSection } from "./Rail";
import { tagHref } from "./route";

/**
 * タグの一覧。tags が null は「出さない」を表す（読み込み中、または API がまだタグを返せない）。
 * 取得に失敗しても一覧の邪魔にならないよう、エラーは表に出さない。
 * settled は取得の成否が決まったことを表す（失敗でも true）。画面の高さが決まるのを待つ側が使う。
 */
export function useTags(): { tags: TagCount[] | null; settled: boolean } {
  const [result, setResult] = useState<{ tags: TagCount[] | null; settled: boolean }>({
    tags: null,
    settled: false,
  });
  useEffect(() => {
    let cancelled = false;
    void listTags().then((res) => {
      if (!cancelled) setResult({ tags: res.ok ? res.value : null, settled: true });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return result;
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
