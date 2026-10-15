import { ANONYMOUS_SEARCH_MIN_CHARS, searchQueryLength } from "@personal-wiki/domain/search";
import { foldTitle } from "@personal-wiki/domain/title";
import type { PageCandidate } from "@personal-wiki/editor";
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { highlightMatches } from "./highlight";
import { PlusIcon, SearchIcon } from "./icons";
import { useAfterFrames, useDelayedWhile } from "./Loading";
import {
  ANONYMOUS_TITLE_INDEX_MAX_REQUESTS,
  createTitleIndex,
  TITLE_INDEX_MAX_REQUESTS,
  type TitleIndex,
} from "./link-sources";
import { openNewPage } from "./new-page";
import { rememberTitle } from "./page-titles";
import { listPageTitles } from "./pages-api";
import { homeHref, navigate, pageHref } from "./route";

const RECENT_LABEL = "最近更新したページ";
const ROWS_LABEL = "候補と操作";
const CANDIDATES_FAILED = "候補を取得できません。開き直してください。";

/**
 * 先頭の行が Enter の既定で、選択と Enter の動作を同じ配列から引く。並びは次のとおり。
 * - title が完全に一致するページがあるとき: 候補、「本文から検索」。既定はその完全一致のページ。
 * - 無いとき: 「本文から検索」、候補、「作成」。既定は「本文から検索」。
 * 語を打って Enter しただけで要らないページができないよう、「作成」は既定にせず末尾に置く。
 * 候補の取得に失敗して 1 件も無いときは、title の完全一致を確かめられないので「作成」を出さない。
 * 匿名が本文を検索できる長さに満たない間は、行き止まりの画面へ移さないよう「本文から検索」を出さない。
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
  const index = useMemo(
    () =>
      createTitleIndex(listPageTitles, {
        maxRequests: owner ? TITLE_INDEX_MAX_REQUESTS : ANONYMOUS_TITLE_INDEX_MAX_REQUESTS,
      }),
    [owner],
  );

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
      {open && (
        <SwitcherBody
          index={index}
          owner={owner}
          onClose={() => onOpenChange(false)}
          onCreate={(title) => {
            // modal の間は外の要素に focus できないので、新規作成の画面が title 欄に focus する前に、
            // state の反映を待たず今すぐ閉じる。dialog の onClose が state を合わせる
            dialogRef.current?.close();
            onOpenChange(false);
            openNewPage({ title });
          }}
        />
      )}
    </dialog>
  );
}

/**
 * 候補の取得中の案内。行は場所を取っておき、取得が遅いときだけ文字を見せる。
 * 取得が済む前の「一致なし」や「作成」を見せないので、待っていることはここで伝える。
 */
function PendingCandidates() {
  // 一覧や本文の帯とは別の待ちなので、帯を描いた記録を共有する useSkeletonPainted は使わない。
  // 共有すると、一覧の帯が出ている最中に開いたときに遅れなしで文字が出る
  const painted = useDelayedWhile(true);
  // 開いた描画と同じ更新で中身を入れた status は読まれないので、文字は後の frame で入れる
  const announced = useAfterFrames();
  return (
    <>
      {announced && <span className="visually-hidden">候補を読み込み中…</span>}
      <p
        className={`switcher-heading switcher-pending${painted ? " skeleton-painted" : ""}`}
        aria-hidden="true"
      >
        候補を読み込み中…
      </p>
    </>
  );
}

function SwitcherBody({
  index,
  owner,
  onClose,
  onCreate,
}: {
  index: TitleIndex;
  owner: boolean;
  onClose: () => void;
  /** 「作成」の行を選んだとき。dialog を閉じて、その title で新規作成の画面を開く */
  onCreate: (title: string) => void;
}) {
  const [query, setQuery] = useState("");
  // null は「先頭の行」
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // 一覧を取り直し終えたら、同じ index から候補を引き直させる
  const [, setLoaded] = useState(0);
  // マウスが載った行はすでに見えているので、それによる選択の変更ではスクロールしない
  const hoveredRef = useRef(false);
  const listboxId = useId();

  // 取り直しが始まったことを、最初の描画の前に反映する。前の失敗が残った索引で開き直すと、
  // 取り直しの間も失敗の案内が一瞬出てしまう
  useLayoutEffect(() => {
    let cancelled = false;
    const refreshing = index.refresh();
    setLoaded((n) => n + 1);
    void refreshing.then(() => {
      if (!cancelled) setLoaded((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [index]);

  // 1 回目の取得が済むまでの「候補なし」は、無いのではなく取れていないだけ
  const settled = index.settled();
  // 取れていない候補は「一致なし」でも「作成」でもない。完全一致を確かめられないので、その 2 つの代わりに失敗の案内を出す
  const failed = index.failed();
  // 失敗の後に開き直して取り直している間は、失敗でなく取得中として見せる
  const retrying = failed && index.loading();
  const showFailed = failed && !retrying;
  const trimmed = query.trim();
  // 候補には文字が飛び飛びに当たるものもある。強調するのは、空白で区切った語がそのまま含まれる箇所だけ
  const terms = trimmed.split(/\s+/);
  const candidates = index.search(trimmed);
  // 部分一致の候補があるだけで「作成」を隠すと、「メモ」を作れなくなる。完全一致が無いときに出す。
  // 完全一致は score が最上位なので、上限で切った候補の先頭に必ず入っている
  const hasExactTitle =
    candidates[0] !== undefined && foldTitle(candidates[0].title) === foldTitle(trimmed);
  const contentSearchTooShort =
    trimmed !== "" && !owner && searchQueryLength(trimmed) < ANONYMOUS_SEARCH_MIN_CHARS;
  const noMatch = trimmed !== "" && !owner && settled && !failed && candidates.length === 0;
  const pageRows = candidates.map((candidate): Row => ({ kind: "page", candidate }));
  const contentSearchRows: Row[] =
    trimmed !== "" && !contentSearchTooShort ? [{ kind: "content-search" }] : [];
  const createRows: Row[] =
    trimmed !== "" && owner && !hasExactTitle && settled && !failed ? [{ kind: "create" }] : [];
  const rows: Row[] = hasExactTitle
    ? [...pageRows, ...contentSearchRows]
    : [...contentSearchRows, ...pageRows, ...createRows];

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

  function selectRow(row: Row) {
    if (row.kind === "page") {
      rememberTitle(row.candidate.id, row.candidate.title);
      onClose();
      navigate(pageHref(row.candidate.id));
    } else if (row.kind === "content-search") {
      onClose();
      navigate(homeHref(trimmed));
    } else {
      onCreate(trimmed);
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
        }}
        onKeyDown={handleKeyDown}
      />
      {trimmed === "" && candidates.length > 0 && (
        <p className="switcher-heading" aria-hidden="true">
          {RECENT_LABEL}
        </p>
      )}
      {/* listbox の子は option だけにするので、候補が無いことと本文から検索できないことの案内は
          外に置く。owner には「作成」と「本文から検索」の行が同じことを伝える */}
      {/* 案内の status は 1 つにまとめる。取得中と匿名の案内が同時に出ると、status が 2 つ並ぶため。
          中身を持ったまま挿入した status は多くの読み上げで読まれないので、常に置いて中身だけを入れる */}
      <div role="status" className="switcher-status">
        {(!settled || retrying) && <PendingCandidates />}
        {(showFailed || noMatch || contentSearchTooShort) && (
          <p className={showFailed ? "switcher-heading switcher-alert" : "switcher-heading"}>
            {showFailed && CANDIDATES_FAILED}
            {noMatch && "タイトルが一致するページはありません。"}
            {contentSearchTooShort &&
              `本文から検索するには ${ANONYMOUS_SEARCH_MIN_CHARS} 文字以上で入力してください。`}
          </p>
        )}
      </div>
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
                {highlightMatches(row.candidate.title, terms, { underscoreAsSpace: true })}
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
      {/* 物理キーボードの案内なので、タッチ操作が主の狭い幅では出さない（CSS） */}
      <p className="switcher-hints" aria-hidden="true">
        <span>↑↓ 選ぶ</span>
        <span>Enter 決定</span>
        <span>Esc 閉じる</span>
      </p>
    </div>
  );
}
