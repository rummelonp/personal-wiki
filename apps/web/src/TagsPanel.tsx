import { foldKeepingUnderscore } from "@personal-wiki/domain";
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
 * visibility を変えて取り直す間は、前の結果と settled を保つ。settled を戻すと、それを待つ
 * スクロールの復元が取り直しのたびに再び動く。
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
  // 一覧は大文字小文字と全角半角を畳んだ値でタグを照合し、API は畳んだ値ごとに代表の表記を 1 つ返す。
  // URL のタグと表記が違うだけのチップが選択中になるよう、比較も畳んだ値で行う。
  // 畳んだ値で一致するタグが結果に無いときは、チップごと消えると絞り込みを外す入口も消えるので補う。
  // API はページに直接書かれたタグしか返さず、子のタグ `a/b` だけが書かれた親 `a` は返さないが、
  // 一覧は親で子のページも拾う。結果に子のタグがあるなら親の件数は 0 でなく、子の件数から重複を除いた
  // 値は出せないので、件数を付けずに補う。子も無ければ範囲の中に 0 件で、一覧の見出しや空の案内が
  // 0 件であることを既に伝えているので、件数 0 で補う
  const activeKey = foldKeepingUnderscore(active);
  const childPrefix = `${activeKey}/`;
  const shown: { tag: string; count: number | null }[] =
    active === "" || tags.some(({ tag }) => foldKeepingUnderscore(tag) === activeKey)
      ? tags
      : [
          ...tags,
          {
            tag: active,
            count: tags.some(({ tag }) => foldKeepingUnderscore(tag).startsWith(childPrefix))
              ? null
              : 0,
          },
        ];
  return (
    <RailSection title="タグ">
      {shown.length === 0 ? (
        <p className="muted">
          {visibility === ""
            ? "タグはまだありません。"
            : `${VISIBILITY_FILTER_NOUNS[visibility]}にタグはありません。`}
        </p>
      ) : (
        <ul className="chips">
          {shown.map(({ tag, count }) => {
            const selected = active !== "" && foldKeepingUnderscore(tag) === activeKey;
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
                  <span className="chip-label">{tag}</span>
                  {count !== null && <span className="chip-count">{count}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </RailSection>
  );
}
