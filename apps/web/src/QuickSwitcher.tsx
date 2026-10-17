import { parsePagePath } from "@personal-wiki/domain/page-path";
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
import { CloseIcon, PlusIcon, SearchIcon } from "./icons";
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
import { homeHref, navigate, pageHref, parseRoute } from "./route";

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
 * 検索結果の画面で開いて語を消したときは、先頭に「検索を解除」の行を置き、Enter で最近の更新へ戻す。
 * 結果の画面に語を直す欄が無いので、語を空にして確定する手段をここに持つ。
 */
type Row =
  | { kind: "page"; candidate: PageCandidate }
  | { kind: "create" }
  | { kind: "content-search" }
  | { kind: "clear-search" };

// 選択は位置でなく行の識別子で持つ。候補が後から変わっても、選んでいる行に追従させる
function rowKey(row: Row): string {
  return row.kind === "page" ? `page-${row.candidate.id}` : row.kind;
}

interface QuickSwitcherProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** owner だけが「作成」の行を使える。匿名には出さない。 */
  owner: boolean;
  /** 開いたときに入力欄へ入れて全選択する語。検索結果の画面で、いま検索している語を渡す。 */
  initialQuery?: string;
  /**
   * いま画面に出しているページの id。ページの画面でないとき、まだ取得中のときは null。
   * URL の title は title を変えた保存の直後などに実際のページとずれるので、分かっていれば id で比べる。
   */
  openPageId?: string | null;
}

/**
 * title の候補を打ちながら出す、ページ移動の窓。ヘッダーの検索、⌘K / Ctrl+K から開く。
 * 候補は `/api/pages/titles` の一覧で、匿名の閲覧者には公開ページだけが返る。
 * 一覧はログイン状態ごとに違うので、呼び出し側は owner かどうかを key にして作り直す。
 */
export function QuickSwitcher({
  open,
  onOpenChange,
  owner,
  initialQuery = "",
  openPageId = null,
}: QuickSwitcherProps) {
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
    if (open && !dialog.open) {
      dialog.showModal();
      // showModal が入力欄へ focus を移した後でないと、選択が残らない処理系がある
      dialog.querySelector<HTMLInputElement>(".switcher-input")?.select();
    } else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="dialog-frame switcher"
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
          initialQuery={initialQuery}
          openPageId={openPageId}
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
  // 一覧や本文のスケルトンとは別の待ちなので、スケルトンを描いた記録を共有する useSkeletonPainted は使わない。
  // 共有すると、一覧のスケルトンが出ている最中に開いたときに遅れなしで文字が出る
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

/**
 * 候補のページが、いま開いているページか。候補は公開範囲を持たず、正の URL（`/<title>`）を作れない。
 * `/p/<id>` へ移ると、移った先の画面が正の URL へ置き換えるまでに履歴が 2 つ積まれる。
 * 開いているページの id が分かっていれば id で比べる。取得中などで分からないときだけ URL を見る。
 * title の URL は title の畳み込み（foldTitle）で比べる。サーバーが同じ畳み込みで引くため。
 */
function isOpenPage(candidate: PageCandidate, openPageId: string | null): boolean {
  if (openPageId !== null) return openPageId === candidate.id;
  const path = parsePagePath(window.location.pathname);
  if (path === null) return false;
  return path.kind === "id"
    ? path.id === candidate.id
    : foldTitle(path.title) === foldTitle(candidate.title);
}

function SwitcherBody({
  index,
  owner,
  initialQuery,
  openPageId,
  onClose,
  onCreate,
}: {
  index: TitleIndex;
  owner: boolean;
  initialQuery: string;
  openPageId: string | null;
  onClose: () => void;
  /** 「作成」の行を選んだとき。dialog を閉じて、その title で新規作成の画面を開く */
  onCreate: (title: string) => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  // null は「先頭の行」
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // 一覧を取り直し終えたら、同じ index から候補を引き直させる
  const [, setLoaded] = useState(0);
  // マウスが載った行はすでに見えているので、それによる選択の変更ではスクロールしない
  const hoveredRef = useRef(false);
  const listboxId = useId();
  const framesPassed = useAfterFrames();
  // status が案内なしで描画された後か。その後に出た案内は、空で置いた status への変化として伝わる
  const [statusEmptied, setStatusEmptied] = useState(false);

  // 取り直しが始まったことを、最初の描画の前に反映する。前の失敗が残ったインデックスで開き直すと、
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
  const pageRows = candidates.map((candidate): Row => ({ kind: "page", candidate }));
  const contentSearchRows: Row[] =
    trimmed !== "" && !contentSearchTooShort ? [{ kind: "content-search" }] : [];
  const createRows: Row[] =
    trimmed !== "" && owner && !hasExactTitle && settled && !failed ? [{ kind: "create" }] : [];
  const clearRows: Row[] =
    trimmed === "" && initialQuery.trim() !== "" ? [{ kind: "clear-search" }] : [];
  const rows: Row[] = hasExactTitle
    ? [...pageRows, ...contentSearchRows]
    : [...clearRows, ...contentSearchRows, ...pageRows, ...createRows];
  // 行が 1 つでもあれば、一致が無いことは並びから分かる。行が無いのは、匿名が本文を検索できない短い語で
  // 候補も無いときだけ
  const noMatch = trimmed !== "" && settled && !failed && rows.length === 0;

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
      if (!isOpenPage(row.candidate, openPageId)) navigate(pageHref(row.candidate.id));
    } else if (row.kind === "content-search") {
      onClose();
      // 今の検索結果と同じ語なら移らない。検索は tag で絞らないので、移っても一覧の結果は変わらず、URL の tag を外して履歴を 1 つ積むだけになる
      const current = parseRoute(window.location.pathname, window.location.search);
      if (current.name !== "home" || current.query.trim() !== trimmed) navigate(homeHref(trimmed));
    } else if (row.kind === "clear-search") {
      onClose();
      navigate(homeHref());
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

  const note =
    showFailed || noMatch || contentSearchTooShort ? (
      <p className={showFailed ? "switcher-heading switcher-alert" : "switcher-heading"}>
        {showFailed && CANDIDATES_FAILED}
        {noMatch && "一致するタイトルはありません。"}
        {contentSearchTooShort &&
          `${ANONYMOUS_SEARCH_MIN_CHARS}\u00a0文字以上で、本文からも検索できます。`}
      </p>
    ) : null;
  const hasNote = note !== null;
  useEffect(() => {
    if (!hasNote) setStatusEmptied(true);
  }, [hasNote]);
  // 待つのは、開いた描画から出ている案内だけ。語を打ったら待たない
  const noteReady = framesPassed || statusEmptied || query !== initialQuery;

  return (
    <div className="switcher-body">
      <input
        className="switcher-input"
        type="text"
        role="combobox"
        // dialog の名前（ページを検索）と分け、欄に入れるものを名前にする
        aria-label="検索語"
        aria-expanded={rows.length > 0}
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder="タイトルで検索"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelectedKey(null);
        }}
        onKeyDown={handleKeyDown}
      />
      {/* 見出しがあると、検索を解除する行まで最近のページの 1 つに見えるので出さない */}
      {trimmed === "" && candidates.length > 0 && clearRows.length === 0 && (
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
        {noteReady && note}
      </div>
      {/* 開いた描画で案内がすでにあると、status へ中身ごと挿入することになり読まれない。見た目は先に出し、
          支援技術には後の frame で status へ移して伝える */}
      {!noteReady && hasNote && <div aria-hidden="true">{note}</div>}
      <div
        id={listboxId}
        role="listbox"
        aria-label={trimmed === "" && clearRows.length === 0 ? RECENT_LABEL : ROWS_LABEL}
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
            {row.kind === "clear-search" && (
              <>
                <CloseIcon />
                <span className="switcher-option-label">検索を解除して最近の更新へ戻る</span>
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
