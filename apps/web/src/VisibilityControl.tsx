import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Link } from "./Link";
import { useDelayedWhile } from "./Loading";
import type { LinkedDraft } from "./linked-drafts";
import { rememberTitle } from "./page-titles";
import type { ApiResult } from "./pages-api";
import { breakAtPhrases } from "./phrase-wrap";
import { pageHref } from "./route";
import { focusIsAdrift, useModalDialog } from "./use-modal-dialog";
import { VisibilityPillFace } from "./VisibilityPillFace";

type Visibility = "draft" | "public";

const OPTIONS: ReadonlyArray<{ value: Visibility; label: string }> = [
  { value: "draft", label: "下書き" },
  { value: "public", label: "公開" },
];

const LABELS: Record<Visibility, string> = { draft: "下書き", public: "公開" };

const PENDING_NOTES: Record<Visibility, string> = {
  public: "公開に変更中…",
  draft: "下書きに変更中…",
};

const DONE_NOTES: Record<Visibility, string> = {
  public: "公開しました。",
  draft: "下書きに戻しました。",
};

/** 結果の読み上げを残しておく時間。残しすぎると、前の操作の結果が今の状態のように読める */
const NOTE_MS = 6_000;

/** 確認に出すリンク先の draft。失敗の理由は出し分けないので持たない */
type LinkedDraftsState = { ok: true; value: readonly LinkedDraft[] } | { ok: false };
const FIND_FAILED: LinkedDraftsState = { ok: false };

interface VisibilityControlProps {
  visibility: Visibility;
  /** 失敗の直後や衝突の間など、今は切り替えられない */
  disabled: boolean;
  /**
   * 自分の保存以外で base が進んだ回数。確認を開いている間に取り込みや衝突の解決で内容が変わったら、
   * 読んでいない内容を公開させないよう確認を閉じる（自分の保存では version が進んでも閉じない）
   */
  externalBases: number;
  /** 切り替えを依頼してレスポンスを待っている先。待っている間は、この値を印に出し、押し直しを受けない */
  pending: Visibility | null;
  /** 切り替えを依頼し、済むまで待つ。失敗は呼び出し側の通知が伝え、状態は元のまま */
  onChange: (to: Visibility) => Promise<void>;
  /**
   * 本文からリンクしている draft。公開の確認を開くたびに呼び、確認に一覧で出す。一覧は開いた時点の本文で
   * 決まり、開いている間の編集は反映しない（開き直すと調べ直す）。失敗と reject は、確認に調べられなかった
   * ことを 1 行出す（公開は止めない）
   */
  findLinkedDrafts?: (signal: AbortSignal) => Promise<ApiResult<readonly LinkedDraft[]>>;
}

/**
 * title の右の、公開範囲の印。押すと「下書き」「公開」を選ぶメニューを開く。
 *
 * draft から public への変化だけ、確定の前に画面の中央のダイアログで確認する。public にすると匿名の一覧、
 * 検索、タグに載り、取り消してもすでに見た人の手元には残るため。public から draft へは、見えなくなる側なので
 * 確認しない。
 *
 * 公開の確認には、本文からリンクしている draft を並べる。公開すると、それらへの link は匿名には
 * リンクにならない文字列に見えるので、先に公開するかを決めてもらう。一覧は確認の操作の後ろに置き、
 * 届いたときに押そうとしている操作の位置を動かさない。
 *
 * 共有の URL は、公開した後のアドレスバーから取ってもらう（表示中のページの URL は正の URL に置き換わる）。
 * draft の URL（`/p/<id>`）も知っていれば匿名に本文が読めるので、draft のまま共有する導線は作らない。
 */
export function VisibilityControl({
  visibility,
  disabled,
  externalBases,
  pending,
  onChange,
  findLinkedDrafts,
}: VisibilityControlProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // null は調べている間と、調べなかったとき
  const [linkedDrafts, setLinkedDrafts] = useState<LinkedDraftsState | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const latestFind = useRef(findLinkedDrafts);
  latestFind.current = findLinkedDrafts;
  const previousVisibility = useRef(visibility);
  const refocusPill = useRef(false);
  // メニューを閉じた後も動くので、メニューの effect の掃除では止めない
  const refocusTimer = useRef<number | undefined>(undefined);
  // 確認を開くごとに 1 回だけ公開を依頼する。閉じる描画の前に届く 2 回目の押下を捨てる
  const publishRequested = useRef(false);
  const menuId = useId();
  // 印は押した直後に新しい値へ変える。回る印は、レスポンスがすぐ届くときにちらつかないよう遅らせて出す
  const pendingShown = useDelayedWhile(pending !== null);
  const shownVisibility = pending ?? visibility;
  const locked = disabled || pending !== null;

  useEffect(() => {
    if (visibility === "public") setConfirming(false);
  }, [visibility]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 回数が変わったことだけが合図
  useEffect(() => {
    setConfirming(false);
  }, [externalBases]);

  useEffect(() => {
    if (locked) setMenuOpen(false);
  }, [locked]);

  // 再試行や他からの取り込みで変わったときも、同じ結果を読み上げる
  useEffect(() => {
    if (previousVisibility.current === visibility) return;
    previousVisibility.current = visibility;
    setNote(DONE_NOTES[visibility]);
  }, [visibility]);

  // 待っている間は印が disabled で focus できず、焦点が body に落ちる。待ちが終わってから戻す。
  // 待つ間に本文や title へ移っていたら奪わない（返事の瞬間に入力欄から焦点を外すと、IME の変換が切れる）
  useEffect(() => {
    if (!refocusPill.current || pending !== null) return;
    refocusPill.current = false;
    if (focusIsAdrift(document.activeElement)) pill.current?.focus();
  }, [pending]);

  useEffect(() => () => window.clearTimeout(refocusTimer.current), []);

  useEffect(() => {
    if (note === null) return;
    const timer = window.setTimeout(() => setNote(null), NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [note]);

  useEffect(() => {
    const find = latestFind.current;
    if (!confirming || find === undefined) return;
    const controller = new AbortController();
    find(controller.signal).then(
      (found) => {
        if (!controller.signal.aborted) setLinkedDrafts(found);
      },
      () => {
        if (!controller.signal.aborted) setLinkedDrafts(FIND_FAILED);
      },
    );
    return () => {
      controller.abort();
      setLinkedDrafts(null);
    };
  }, [confirming]);

  // 開いたら選択中の項目に焦点を移す。外側を押したら閉じ、押した先が焦点を持たない場所なら印に戻す
  useEffect(() => {
    const wrapper = root.current;
    if (!menuOpen || wrapper === null) return;
    menu.current?.querySelector<HTMLElement>("[aria-checked='true']")?.focus();
    function onPointerDown(event: PointerEvent) {
      if (wrapper?.contains(event.target as Node)) return;
      setMenuOpen(false);
      // マウスでは焦点が pointerdown の後の mousedown の既定の動作で移るので、次のタスクで押した先が
      // 決まった後に見る。body に落ちていたときだけ戻し、入力欄などへ移っていたら奪わない。
      // タッチでは mousedown が指を離した後まで遅れるので先に印へ戻り、入力欄ならその後で焦点が移る。
      // 開いたままスクロールすると印が画面の外にあるので、戻すときに画面を動かさない
      window.clearTimeout(refocusTimer.current);
      refocusTimer.current = window.setTimeout(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) {
          pill.current?.focus({ preventScroll: true });
        }
      }, 0);
    }
    // Safari はボタンを押しても焦点を移さず、項目を押す間に行き先の無い focusout が起きる。
    // 行き先の分かる移動（Tab など）だけで閉じ、押したときは外側の pointerdown に任せる
    function onFocusOut(event: FocusEvent) {
      const to = event.relatedTarget;
      if (to instanceof Node && !wrapper?.contains(to)) setMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    wrapper.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      wrapper.removeEventListener("focusout", onFocusOut);
    };
  }, [menuOpen]);

  function closeMenu() {
    setMenuOpen(false);
    pill.current?.focus();
  }

  async function apply(to: Visibility) {
    setConfirming(false);
    setNote(null);
    refocusPill.current = true;
    await onChange(to);
  }

  function choose(to: Visibility) {
    // 確認のダイアログが閉じたときに戻す焦点を、開く前に印へ移しておく
    closeMenu();
    if (to === visibility) return;
    if (to === "public") {
      publishRequested.current = false;
      setConfirming(true);
    } else void apply(to);
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      return;
    }
    if (event.key === "Tab") {
      // 項目は既定の動作より先に消えるので、Chromium では Shift+Tab が項目の位置から前の要素を探して印に
      // 止まる。印に焦点を置いてから既定の動作に任せ、印から押したのと同じ移動先にする。
      // 移動先を自分で探すと、順次の移動の規則を持つことになる。印へは仮に置くだけなので画面を動かさない
      pill.current?.focus({ preventScroll: true });
      setMenuOpen(false);
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
    <div ref={root} className="visibility">
      <button
        ref={pill}
        type="button"
        className="visibility-pill"
        data-visibility={shownVisibility}
        aria-label={`公開範囲: ${LABELS[shownVisibility]}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        aria-busy={pending !== null}
        disabled={locked}
        // Safari は押しても印に焦点を移さないので、開いたメニューを印で閉じると、焦点を持っていた項目が消えて
        // body に落ちる。外側の押下は印の押下を内側として扱うので、ここで印へ戻す
        onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setMenuOpen(true);
        }}
      >
        <VisibilityPillFace shown={shownVisibility} spinning={pendingShown} />
      </button>
      {menuOpen && (
        <div
          ref={menu}
          id={menuId}
          className="visibility-menu"
          role="menu"
          aria-label="公開範囲"
          onKeyDown={onMenuKeyDown}
        >
          {OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className="visibility-option"
              role="menuitemradio"
              aria-checked={shownVisibility === value}
              tabIndex={-1}
              onClick={() => choose(value)}
            >
              <span className="visibility-option-check" aria-hidden="true">
                {shownVisibility === value ? "✓" : ""}
              </span>
              <span className="visibility-option-label">{label}</span>
            </button>
          ))}
        </div>
      )}
      <span className="visually-hidden" role="status">
        {pendingShown ? PENDING_NOTES[pending as Visibility] : (note ?? "")}
      </span>
      <PublishDialog
        open={confirming}
        disabled={disabled}
        linkedDrafts={linkedDrafts}
        onConfirm={() => {
          if (publishRequested.current) return;
          publishRequested.current = true;
          void apply("public");
        }}
        onClose={() => setConfirming(false)}
        returnFocusTo={() => pill.current}
      />
    </div>
  );
}

/** 公開の確認。取り消せない操作なので、画面全体を止めるモーダルにする */
function PublishDialog({
  open,
  disabled,
  linkedDrafts,
  onConfirm,
  onClose,
  returnFocusTo,
}: {
  open: boolean;
  disabled: boolean;
  linkedDrafts: LinkedDraftsState | null;
  onConfirm: () => void;
  onClose: () => void;
  /** ダイアログが閉じた後に焦点を戻す先 */
  returnFocusTo: () => HTMLElement | null;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const confirmTextId = useId();
  const draftsTextId = useId();
  const draftsShown = linkedDrafts !== null && (!linkedDrafts.ok || linkedDrafts.value.length > 0);
  const describedBy = draftsShown ? `${confirmTextId} ${draftsTextId}` : confirmTextId;

  // 開いた直後の焦点は、確定でなく「やめる」に置く（showModal は先頭の「公開する」に置く）
  const dialog = useModalDialog({
    open,
    onClose,
    onOpened: () => cancel.current?.focus(),
    returnFocusTo,
  });

  return (
    <dialog
      ref={dialog.ref}
      className="dialog-frame publish-dialog"
      aria-label="公開の確認"
      {...dialog.props}
    >
      {open && (
        <>
          <div className="publish-dialog-head">
            {/* 焦点は「やめる」に置くので、どちらの操作にも何が起きるかを結び付けて読ませる */}
            <p id={confirmTextId}>
              {breakAtPhrases(
                "誰でもこのページを読めるようになり、一覧、検索、タグにも載ります。下書きに戻しても、すでに読まれた内容は取り消せません。",
              )}
            </p>
            <div className="actions">
              <button
                type="button"
                className="button button-accent"
                aria-describedby={describedBy}
                disabled={disabled}
                onClick={onConfirm}
              >
                公開する
              </button>
              <button
                ref={cancel}
                type="button"
                className="button"
                aria-describedby={describedBy}
                onClick={onClose}
              >
                やめる
              </button>
            </div>
          </div>
          {/* 焦点が「やめる」にある間に届くので、届いたことを読み上げる */}
          <div className="publish-drafts" role="status">
            {linkedDrafts?.ok === false && (
              <p id={draftsTextId}>
                リンク先の下書きを調べられませんでした。やめて開き直すと、もう一度調べます。
              </p>
            )}
            {linkedDrafts?.ok === true && linkedDrafts.value.length > 0 && (
              <>
                <p id={draftsTextId}>
                  本文から{linkedDrafts.value.length}
                  件の下書きにリンクしています。公開しても、読む人にはリンクではなく文字に見えます。
                </p>
                <ul>
                  {linkedDrafts.value.map((draft) => (
                    <li key={draft.id}>
                      <Link
                        href={pageHref(draft.id)}
                        onClick={() => rememberTitle(draft.id, draft.title)}
                      >
                        {draft.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
