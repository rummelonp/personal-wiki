import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ChevronDownIcon } from "./icons";
import { LIST_SORT_LABELS, LIST_SORTS, type ListSort } from "./list-sort";

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

  // 外側を押して閉じるときは、焦点をボタンに戻さず押した先に任せる
  useEffect(() => {
    const wrapper = root.current;
    if (!open || wrapper === null) return;
    menu.current?.querySelector<HTMLElement>("[aria-checked='true']")?.focus();
    function onPointerDown(event: PointerEvent) {
      if (!wrapper?.contains(event.target as Node)) setOpen(false);
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
        aria-label={`並び順：${LIST_SORT_LABELS[sort]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
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
