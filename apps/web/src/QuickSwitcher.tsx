import { foldTitle } from "@personal-wiki/domain/title";
import type { PageCandidate } from "@personal-wiki/editor";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { type CreateProblem, CreateProblemMessage, createPageAndOpen } from "./create-page";
import { PlusIcon, SearchIcon } from "./icons";
import { createTitleIndex, type TitleIndex } from "./link-sources";
import { listPageTitles } from "./pages-api";
import { homeHref, navigate, pageHref } from "./route";

const RECENT_LABEL = "最近更新したページ";
const ROWS_LABEL = "候補と操作";

/**
 * 並びは、title の候補、title が完全に一致するページが無いときの「作成」、語があるときの
 * 「本文から検索」の順。選択と Enter の動作を同じ配列から引く。
 */
type Row =
  | { kind: "page"; candidate: PageCandidate }
  | { kind: "create" }
  | { kind: "content-search" };

// 選択は位置でなく行の識別子で持つ。候補が後から変わっても、選んでいる行に追従させる
function rowKey(row: Row): string {
  return row.kind === "page" ? `page-${row.candidate.id}` : row.kind;
}

interface QuickSwitcherProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** owner だけが「作成」の行を使える。匿名には出さない。 */
  owner: boolean;
}

/**
 * title の候補を打ちながら出す、ページ移動の窓。ヘッダーの検索、⌘K / Ctrl+K から開く。
 * 候補は `/api/pages/titles` の一覧で、匿名の閲覧者には公開ページだけが返る。
 * 一覧はログイン状態ごとに違うので、呼び出し側は owner かどうかを key にして作り直す。
 */
export function QuickSwitcher({ open, onOpenChange, owner }: QuickSwitcherProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // 前に開いたときの候補を残して開いた直後から出し、開くたびに取り直した一覧へ差し替える
  const index = useMemo(() => createTitleIndex(listPageTitles), []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="switcher"
      aria-label="ページを検索"
      onClose={() => onOpenChange(false)}
      onMouseDown={(event) => {
        // 枠の外（backdrop）を押したときだけ閉じる。dialog 自体は余白を持たない
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      {open && <SwitcherBody index={index} owner={owner} onClose={() => onOpenChange(false)} />}
    </dialog>
  );
}

function SwitcherBody({
  index,
  owner,
  onClose,
}: {
  index: TitleIndex;
  owner: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  // null は「先頭の行」
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<CreateProblem | null>(null);
  // 一覧を取り直し終えたら、同じ index から候補を引き直させる
  const [, setLoaded] = useState(0);
  // マウスが載った行はすでに見えているので、それによる選択の変更ではスクロールしない
  const hoveredRef = useRef(false);
  const listboxId = useId();

  useEffect(() => {
    let cancelled = false;
    void index.refresh().then(() => {
      if (!cancelled) setLoaded((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [index]);

  const trimmed = query.trim();
  const candidates = index.search(trimmed);
  // 部分一致の候補があるだけで「作成」を隠すと、「メモ」を作れなくなる。完全一致が無いときに出す。
  // 完全一致は score が最上位なので、上限で切った候補の先頭に必ず入っている
  const hasExactTitle =
    candidates[0] !== undefined && foldTitle(candidates[0].title) === foldTitle(trimmed);
  const rows: Row[] = [
    ...candidates.map((candidate): Row => ({ kind: "page", candidate })),
    ...(trimmed !== "" && owner && !hasExactTitle ? [{ kind: "create" } as const] : []),
    ...(trimmed !== "" ? [{ kind: "content-search" } as const] : []),
  ];

  // 選んでいた行が並びから消えたら先頭に戻す
  const keyedIndex = rows.findIndex((row) => rowKey(row) === selectedKey);
  if (selectedKey !== null && keyedIndex === -1) setSelectedKey(null);
  const selectedIndex = Math.max(keyedIndex, 0);

  function optionId(row: Row): string {
    return `${listboxId}-${rowKey(row)}`;
  }
  const activeRow = rows[selectedIndex];
  const activeOptionId = activeRow === undefined ? undefined : optionId(activeRow);

  // 矢印キーで選んだ行が listbox の外に出たら、見える位置まで寄せる
  useEffect(() => {
    if (hoveredRef.current) {
      hoveredRef.current = false;
      return;
    }
    if (activeOptionId !== undefined) {
      document.getElementById(activeOptionId)?.scrollIntoView({ block: "nearest" });
    }
  }, [activeOptionId]);

  async function create() {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const failed = await createPageAndOpen(trimmed);
    setBusy(false);
    if (failed === null) onClose();
    else setProblem(failed);
  }

  function selectRow(row: Row) {
    if (row.kind === "page") {
      onClose();
      navigate(pageHref(row.candidate.id));
    } else if (row.kind === "content-search") {
      onClose();
      navigate(homeHref(trimmed));
    } else {
      void create();
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // 変換中のキーは変換の操作なので、候補の操作に使わない。Safari は変換を確定する Enter の keydown を
    // compositionend の後に isComposing: false で送るので、keyCode 229（IME の処理中）でも見分ける
    const { isComposing, keyCode } = event.nativeEvent;
    if (isComposing || keyCode === 229) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = rows[Math.min(selectedIndex + 1, rows.length - 1)];
      if (next !== undefined) setSelectedKey(rowKey(next));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const prev = rows[Math.max(selectedIndex - 1, 0)];
      if (prev !== undefined) setSelectedKey(rowKey(prev));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeRow !== undefined) selectRow(activeRow);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div className="switcher-body">
      <input
        className="switcher-input"
        type="text"
        role="combobox"
        aria-label="ページを検索"
        aria-expanded={rows.length > 0}
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder="ページのタイトルで検索"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelectedKey(null);
          setProblem(null);
        }}
        onKeyDown={handleKeyDown}
      />
      {trimmed === "" && candidates.length > 0 && (
        <p className="switcher-heading" aria-hidden="true">
          {RECENT_LABEL}
        </p>
      )}
      {/* listbox の子は option だけにするので、候補が無いことの案内は外に置く。
          owner には「作成」の行が同じことを伝える */}
      {trimmed !== "" && candidates.length === 0 && !owner && (
        <p className="switcher-heading" role="status">
          タイトルが一致するページはありません。
        </p>
      )}
      <div
        id={listboxId}
        role="listbox"
        aria-label={trimmed === "" ? RECENT_LABEL : ROWS_LABEL}
        className="switcher-list"
      >
        {rows.map((row, i) => (
          // マウスは mouseenter でなく mousemove で拾う。キーで選んだ行へのスクロールで、動かしていない
          // マウスの下に別の行が来ても、キーの選択を奪わせないため
          <button
            key={rowKey(row)}
            type="button"
            id={optionId(row)}
            role="option"
            tabIndex={-1}
            className="switcher-option"
            aria-selected={i === selectedIndex}
            data-row-kind={row.kind}
            disabled={row.kind === "create" && busy}
            onMouseMove={() => {
              if (i !== selectedIndex) hoveredRef.current = true;
              setSelectedKey(rowKey(row));
            }}
            // 入力欄からフォーカスを奪わない
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => selectRow(row)}
          >
            {row.kind === "page" && (
              <span className="switcher-option-label">
                {highlightTerms(row.candidate.title, trimmed)}
              </span>
            )}
            {row.kind === "create" && (
              <>
                <PlusIcon />
                <span className="switcher-option-label">{`「${trimmed}」を作成`}</span>
              </>
            )}
            {row.kind === "content-search" && (
              <>
                <SearchIcon />
                <span className="switcher-option-label">{`「${trimmed}」を本文から検索`}</span>
              </>
            )}
          </button>
        ))}
      </div>
      {problem !== null && <CreateProblemMessage problem={problem} onOpenExisting={onClose} />}
      {/* 物理キーボードの案内なので、タッチ操作が主の狭い幅では出さない（CSS） */}
      <p className="switcher-hints" aria-hidden="true">
        <span>↑↓ 選ぶ</span>
        <span>Enter 決定</span>
        <span>Esc 閉じる</span>
      </p>
    </div>
  );
}

/** 打った語に当たる部分を `<mark>` で囲む。要素で組むので、title が HTML として解釈されることはない。 */
function highlightTerms(text: string, query: string): ReactNode {
  const terms = [...new Set(query.split(/\s+/).filter((term) => term !== ""))];
  if (terms.length === 0) return text;
  const pattern = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  // 括弧が 1 つだけの split は、奇数番目が一致した部分になる
  return text.split(new RegExp(`(${pattern})`, "gi")).map((part, i) => {
    const key = `${i}-${part}`;
    return i % 2 === 1 ? <mark key={key}>{part}</mark> : <Fragment key={key}>{part}</Fragment>;
  });
}
