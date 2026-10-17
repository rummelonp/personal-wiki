import { useEffect, useState } from "react";
import { Link } from "./Link";
import { VISIBILITY_FILTER_NOUNS } from "./list-heading";
import { listTags, type TagCount } from "./pages-api";
import { RailSection } from "./Rail";
import { listHref, type VisibilityFilter } from "./route";

/**
 * タグの一覧。tags が null は「出さない」を表す（読み込み中、または API がまだタグを返せない）。
 * 取得に失敗しても一覧の邪魔にならないよう、エラーは表に出さない。
 * settled は取得の成否が決まったことを表す（失敗でも true）。画面の高さが決まるのを待つ側が使う。
 * visibility を変えて取り直す間は、前の結果と settled を保つ。settled を戻すと、それを待って出す
 * 公開範囲の欄が押した直後に消え、focus と配置が飛ぶ。
 */
export function useTags(visibility: VisibilityFilter = ""): {
  tags: TagCount[] | null;
  settled: boolean;
} {
  const [result, setResult] = useState<{ tags: TagCount[] | null; settled: boolean }>({
    tags: null,
    settled: false,
  });
  useEffect(() => {
    let cancelled = false;
    void listTags({ visibility }).then((res) => {
      if (!cancelled) setResult({ tags: res.ok ? res.value : null, settled: true });
    });
    return () => {
      cancelled = true;
    };
  }, [visibility]);
  return result;
}

export function TagsPanel({
  tags,
  active,
  visibility = "",
}: {
  tags: TagCount[];
  active: string;
  /** 一覧の公開範囲の絞り込み。タグを選んでも外しても保つ。tags もこの範囲で数えたものを渡す。 */
  visibility?: VisibilityFilter;
}) {
  return (
    <RailSection title="タグ">
      {tags.length === 0 ? (
        <p className="muted">
          {visibility === ""
            ? "タグはまだありません。"
            : `${VISIBILITY_FILTER_NOUNS[visibility]}にタグはありません。`}
        </p>
      ) : (
        <ul className="chips">
          {tags.map(({ tag, count }) => {
            const selected = tag === active;
            return (
              <li key={tag}>
                {/*
                  選択中のタグは、押すとタグの絞り込みだけを外すリンクにする（公開範囲の絞り込みは残す）。
                  名前は変えず（タグ名と件数のまま）、外れることは title の説明で伝える。
                */}
                <Link
                  className="chip chip-link"
                  href={listHref({ tag: selected ? "" : tag, visibility })}
                  aria-current={selected ? "page" : undefined}
                  title={selected ? "タグの絞り込みを外す" : undefined}
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
