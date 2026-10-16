import { useEffect, useState } from "react";
import { Link } from "./Link";
import { listTags, type TagCount } from "./pages-api";
import { RailSection } from "./Rail";
import { homeHref, tagHref } from "./route";

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
          {tags.map(({ tag, count }) => {
            const selected = tag === active;
            return (
              <li key={tag}>
                {/*
                  選択中のタグは、押すと絞り込みを外してトップへ戻るリンクにする。
                  名前は変えず（タグ名と件数のまま）、外れることは title の説明で伝える。
                */}
                <Link
                  className="chip chip-link"
                  href={selected ? homeHref() : tagHref(tag)}
                  aria-current={selected ? "page" : undefined}
                  title={selected ? "絞り込みを外す" : undefined}
                >
                  {tag}
                  <span className="chip-count">{count}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </RailSection>
  );
}
