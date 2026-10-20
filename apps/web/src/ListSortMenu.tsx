import { LIST_SORTS, type ListSort } from "@personal-wiki/domain/list-sort";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ChevronDownIcon } from "./icons";
import { LIST_SORT_LABELS } from "./list-sort";

/**
 * 一覧の見出しの右の、並び順のメニュー。ボタンに今の並びの名前を出し、押すと並びを選ぶメニューを開く。
 * 開閉と焦点の扱いは、公開範囲のメニュー（VisibilityControl）と同じにする。
 */
export function ListSortMenu({
  sort,
  onChange,
}: {
  sort: ListSort;
  onChange: (sort: ListSort) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const refocusTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(refocusTimer.current), []);

  // 開いたら選択中の項目に焦点を移す。外側を押したら閉じ、押した先が焦点を持たない場所ならボタンに戻す
  useEffect(() => {
    const wrapper = root.current;
    if (!open || wrapper === null) return;
    menu.current?.querySelector<HTMLElement>("[aria-checked='true']")?.focus();
    function onPointerDown(event: PointerEvent) {
      if (wrapper?.contains(event.target as Node)) return;
      setOpen(false);
      // マウスでは焦点が pointerdown の後の mousedown の既定の動作で移るので、次のタスクで押した先が
      // 決まった後に見る。body に落ちていたときだけ戻し、入力欄などへ移っていたら奪わない。
      // 開いたままスクロールするとボタンが画面の外にあるので、戻すときに画面を動かさない
      window.clearTimeout(refocusTimer.current);
      refocusTimer.current = window.setTimeout(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) {
          button.current?.focus({ preventScroll: true });
        }
      }, 0);
    }
    // Safari はボタンを押しても焦点を移さず、項目を押す間に行き先の無い focusout が起きる。
    // 行き先の分かる移動（Tab など）だけで閉じ、押したときは外側の pointerdown に任せる
    function onFocusOut(event: FocusEvent) {
      const to = event.relatedTarget;
      if (to instanceof Node && !wrapper?.contains(to)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    wrapper.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      wrapper.removeEventListener("focusout", onFocusOut);
    };
  }, [open]);

  function close() {
    setOpen(false);
    button.current?.focus();
  }

  function choose(next: ListSort) {
    close();
    if (next !== sort) onChange(next);
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      // 項目は既定の動作より先に消えるので、Chromium では Shift+Tab が項目の位置から前の要素を探して
      // ボタンに止まる。ボタンに焦点を置いてから既定の動作に任せ、ボタンから押したのと同じ移動先にする。
      // 移動先を自分で探すと、順次の移動の規則を持つことになる。ボタンへは仮に置くだけなので画面を動かさない
      button.current?.focus({ preventScroll: true });
      setOpen(false);
      return;
    }
    const items = [
      ...(menu.current?.querySelectorAll<HTMLElement>("[role='menuitemradio']") ?? []),
    ];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const moves: Record<string, number> = {
      ArrowDown: (index + 1) % items.length,
      ArrowUp: (index - 1 + items.length) % items.length,
      Home: 0,
      End: items.length - 1,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    items[next]?.focus();
  }

  return (
    <div ref={root} className="list-sort">
      <button
        ref={button}
        type="button"
        className="list-sort-button"
        aria-label={`並び順: ${LIST_SORT_LABELS[sort]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        // Safari はボタンを押しても焦点が移らず、項目が持つ焦点は項目が消えると body に落ちる。
        // 開閉を切り替えるだけにせず、閉じるときは焦点をボタンに戻す
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <ListSortButtonFace sort={sort} />
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          className="list-sort-menu"
          role="menu"
          aria-label="並び順"
          onKeyDown={onMenuKeyDown}
        >
          {LIST_SORTS.map((value) => (
            <button
              key={value}
              type="button"
              className="list-sort-option"
              role="menuitemradio"
              aria-checked={sort === value}
              tabIndex={-1}
              onClick={() => choose(value)}
            >
              <span className="list-sort-option-check" aria-hidden="true">
                {sort === value ? "✓" : ""}
              </span>
              {LIST_SORT_LABELS[value]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** ボタンの中身。読み込み中のスケルトンも同じ中身で幅を空けておく。 */
export function ListSortButtonFace({ sort }: { sort: ListSort }) {
  return (
    <>
      {LIST_SORT_LABELS[sort]}
      <ChevronDownIcon />
    </>
  );
}
