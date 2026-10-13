import { type RefObject, useCallback, useEffect } from "react";
import type { BodyEditorHandle } from "./BodyEditor";
import { parseFragment } from "./page-fragment";
import { navigate, useHash } from "./route";

/**
 * URL の hash が指す見出しか block へ、本文の編集部品を移す。ページを表示したとき（mount）と、hash が
 * 変わったとき（リンクのクリック、戻る・進む）に移る。hash が見出しや block を指さない、
 * または本文に無いときは何もしない（先頭のまま）。
 *
 * 返す `goTo` は、同じページの link（`[[#見出し]]` と自分への `[[題#見出し]]`）を押したときに呼ぶ。
 * hash が今と違えば履歴に積み、位置は hash の変化で追う。同じ hash の link を押したときは
 * hash が変わらないので、ここで直接移る（スクロールで離れた後に同じ link を押し直せる）。
 */
export function useFragmentJump(editor: RefObject<BodyEditorHandle | null>): {
  goTo: (hash: string) => void;
} {
  const hash = useHash();

  useEffect(() => {
    const fragment = parseFragment(hash);
    if (fragment !== null) editor.current?.jumpToFragment(fragment);
  }, [hash, editor]);

  const goTo = useCallback(
    (target: string) => {
      if (target !== window.location.hash) {
        navigate(`${window.location.pathname}${window.location.search}${target}`);
        return;
      }
      const fragment = parseFragment(target);
      if (fragment !== null) editor.current?.jumpToFragment(fragment);
    },
    [editor],
  );

  return { goTo };
}
