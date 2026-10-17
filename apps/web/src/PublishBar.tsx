import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Link } from "./Link";
import { useDelayedWhile } from "./Loading";
import type { LinkedDraft } from "./linked-drafts";
import { rememberTitle } from "./page-titles";
import type { ApiResult } from "./pages-api";
import { pageHref } from "./route";

type Visibility = "draft" | "public";

const OPTIONS: ReadonlyArray<{ value: Visibility; label: string }> = [
  { value: "draft", label: "下書き" },
  { value: "public", label: "公開" },
];

/*
 * 結果の知らせは、操作の右の狭い余白（375px で 90px 前後）に折り返して入る。<wbr> は、文節の切れ目に置く
 * 折り返し位置。WebKit は文節を判定しないので、これが無いと語の途中で切れる。
 */
const PENDING_NOTES: Record<Visibility, ReactNode> = {
  public: (
    <>
      公開に
      <wbr />
      変更中…
    </>
  ),
  draft: (
    <>
      下書きに
      <wbr />
      変更中…
    </>
  ),
};

const PUBLISHED_NOTE = (
  <>
    公開
    <wbr />
    しました。
  </>
);

const DRAFTED_NOTE = (
  <>
    下書きに
    <wbr />
    戻しました。
  </>
);

const COPIED_NOTE = (
  <>
    URL をコピー
    <wbr />
    しました。
  </>
);

/**
 * 手でコピーしてもらう URL。title の percent-encoding を日本語に戻して読めるようにする。
 * 空白は戻さない。貼り付け先で URL が空白の手前で切れる。
 * title の空白は普通 `_` で書かれる。`%20` が残るのは、`_` にすると別のページを引く title
 * （titlePath の urlTitle）だけなので、`_` に読み替えない。
 * `%25` も戻さない。decodeURI は `%2F` などは残すが `%25` は `%` に戻すので、`a%2Fb` の title が
 * `a/b` のページを指す URL に変わる。
 */
export function readableUrl(url: string): string {
  try {
    return decodeURI(url.replace(/%25/gi, "%2525")).replace(/\s/g, encodeURIComponent);
  } catch {
    return url;
  }
}

/**
 * 全体を選び、先頭が見える位置に戻す。選ぶと欄が末尾へスクロールし、長い URL の先頭が
 * 欄の外へ流れて見えなくなる。
 */
function selectAll(input: HTMLInputElement) {
  input.setSelectionRange(0, input.value.length, "backward");
  input.scrollLeft = 0;
}

/** 結果の知らせを出しておく時間。残しすぎると、前の操作の結果が今の状態のように読める */
const NOTE_MS = 6_000;

/** 確認に出すリンク先の draft。失敗の理由は出し分けないので持たない */
type LinkedDraftsState = { ok: true; value: readonly LinkedDraft[] } | { ok: false };
const FIND_FAILED: LinkedDraftsState = { ok: false };

interface PublishBarProps {
  visibility: Visibility;
  /**
   * まだ作っていないページ。作る前のページは公開できないので、操作を無効にする。
   * 作る前であることは編集画面の上端が伝えるので、理由の文は添えない
   */
  uncreated: boolean;
  /** 失敗の直後や衝突の間など、今は切り替えられない */
  disabled: boolean;
  /**
   * 自分の保存以外で base が進んだ回数。確認を開いている間に取り込みや衝突の解決で内容が変わったら、
   * 読んでいない内容を公開させないよう確認を閉じる（自分の保存では version が進んでも閉じない）
   */
  externalBases: number;
  /** title が未保存。sharePath は保存済みの title から作るので、コピーしても古い URL になる */
  titlePending: boolean;
  /** 匿名が開ける URL のパス。public のときの正の URL（title の URL、予約語の title は id の URL） */
  sharePath: string;
  /** 切り替えを依頼してレスポンスを待っている先。待っている間は、この選択を選択中として見せ、押し直しを受けない */
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
 * title のすぐ下の、公開の状態と操作の行。
 *
 * draft から public への変化だけ、確定の前に確認を挟む。public にすると匿名の一覧、検索、タグに載り、
 * 取り消してもすでに見た人の手元には残るため。public から draft へは、見えなくなる側なので確認しない。
 *
 * 公開の確認には、本文からリンクしている draft を並べる。公開すると、それらへの link は匿名には
 * リンクにならない文字列に見えるので、先に公開するかを決めてもらう。一覧は確認の操作の後ろに置き、
 * 届いたときに押そうとしている操作の位置を動かさない。
 * 確認より下の本文は、一覧（と調べられなかった旨）が届いたときに押し下がる。読み込みでレイアウトを
 * 動かさない規範（docs/design.md）の例外にする。件数は調べ終わるまで分からず、高さを先に取ると、多くを
 * 占める 0 件のときに空白が残る。調べ終わるまで確認を開かないと、「公開」を押した応答が通信を待つ。
 * 押し下がるのは、開いたばかりの確認の中で 1 回だけになる。
 *
 * 共有の URL をコピーする操作は public のときだけ出す。draft の URL（`/p/<id>`）も知っていれば
 * 匿名に本文が読めるので、draft のまま共有する導線は作らない。共有したいときは先に公開させる。
 */
export function PublishBar({
  visibility,
  uncreated,
  disabled,
  externalBases,
  titlePending,
  sharePath,
  pending,
  onChange,
  findLinkedDrafts,
}: PublishBarProps) {
  const [confirming, setConfirming] = useState(false);
  // null は調べている間と、調べなかったとき
  const [linkedDrafts, setLinkedDrafts] = useState<LinkedDraftsState | null>(null);
  const [note, setNote] = useState<ReactNode>(null);
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const publicOption = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const confirmTextId = useId();
  const draftsTextId = useId();
  const latestFind = useRef(findLinkedDrafts);
  latestFind.current = findLinkedDrafts;
  const previousVisibility = useRef(visibility);
  const refocusPublic = useRef(false);
  // 選択は押した直後に動かす。文字はレスポンスがすぐ届くときにちらつかないよう、遅らせて出す
  const pendingShown = useDelayedWhile(pending !== null);
  const shownVisibility = pending ?? visibility;
  const shareUrl = `${window.location.origin}${sharePath}`;
  const draftsShown = linkedDrafts !== null && (!linkedDrafts.ok || linkedDrafts.value.length > 0);
  const describedBy = draftsShown ? `${confirmTextId} ${draftsTextId}` : confirmTextId;
  const manualShown =
    manualUrl !== null && manualUrl === shareUrl && visibility === "public" && !uncreated;

  useEffect(() => {
    if (uncreated || visibility === "public") setConfirming(false);
  }, [uncreated, visibility]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 回数が変わったことだけが合図
  useEffect(() => {
    setConfirming(false);
  }, [externalBases]);

  // 再試行や他からの取り込みで変わったときも、同じ知らせを出す。確定の操作の後は、確認の閉じで
  // 失った焦点を「公開」に戻す
  useEffect(() => {
    if (previousVisibility.current === visibility) return;
    previousVisibility.current = visibility;
    if (uncreated) return;
    setNote(visibility === "public" ? PUBLISHED_NOTE : DRAFTED_NOTE);
  }, [visibility, uncreated]);

  // 待っている間は選択が disabled で focus できない。待ちが終わってから戻す
  useEffect(() => {
    if (!refocusPublic.current || pending !== null) return;
    if (visibility === "public") publicOption.current?.focus();
    refocusPublic.current = false;
  }, [visibility, pending]);

  useEffect(() => {
    if (confirming) cancel.current?.focus();
  }, [confirming]);

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

  useEffect(() => {
    if (note === null) return;
    const timer = window.setTimeout(() => setNote(null), NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [note]);

  // 書けなかった環境では URL を選んだ状態で見せる。選び直さなくても、そのままコピーできる
  useEffect(() => {
    const input = urlInput.current;
    if (manualUrl === null || input === null) return;
    input.focus();
    selectAll(input);
  }, [manualUrl]);

  async function apply(to: Visibility) {
    setConfirming(false);
    setManualUrl(null);
    setNote(null);
    // 公開の変化は画面に反映された後（上の visibility の effect）で受ける
    refocusPublic.current = to === "public";
    await onChange(to);
  }

  function choose(to: Visibility) {
    if (to === visibility) {
      // 確認の最中に「下書き」を押したら、やめるのと同じ
      if (to === "draft") setConfirming(false);
      return;
    }
    if (to === "public") setConfirming(true);
    else void apply(to);
  }

  async function copy() {
    setNote(null);
    try {
      await navigator.clipboard.writeText(shareUrl);
      setManualUrl(null);
      setNote(COPIED_NOTE);
    } catch {
      // 権限が無い、secure context でない、フォーカスが外れているなど。書き込めない理由は区別しない
      setManualUrl(shareUrl);
    }
  }

  return (
    <div className="publish-bar">
      <fieldset
        className="segmented"
        aria-label="公開範囲"
        aria-busy={pending !== null}
        data-pending={pending ?? undefined}
      >
        {OPTIONS.map(({ value, label }) => (
          <button
            key={value}
            ref={value === "public" ? publicOption : undefined}
            type="button"
            className="segmented-option"
            data-value={value}
            aria-pressed={shownVisibility === value}
            disabled={uncreated || disabled || pending !== null}
            onClick={() => choose(value)}
          >
            {label}
          </button>
        ))}
      </fieldset>
      {visibility === "public" && !uncreated && (
        <button
          type="button"
          className="button"
          disabled={titlePending}
          title={titlePending ? "タイトルを保存してからコピーできます" : undefined}
          onClick={() => void copy()}
        >
          URL をコピー
        </button>
      )}
      <p
        className={manualShown ? "publish-note publish-note-wrap" : "publish-note"}
        role="status"
        aria-live="polite"
      >
        {pendingShown
          ? PENDING_NOTES[pending as Visibility]
          : manualShown
            ? "コピーできませんでした。下の URL は選択済みなので、そのままコピーしてください。"
            : note}
      </p>
      {manualShown && (
        <input
          ref={urlInput}
          className="publish-url"
          type="text"
          readOnly
          value={readableUrl(shareUrl)}
          aria-label="共有する URL"
          onFocus={(event) => selectAll(event.currentTarget)}
        />
      )}
      {confirming && (
        <section
          className="publish-confirm"
          aria-label="公開の確認"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setConfirming(false);
            publicOption.current?.focus();
          }}
        >
          {/* 焦点は「やめる」に置くので、どちらの操作にも何が起きるかを結び付けて読ませる */}
          <p id={confirmTextId}>
            誰でもこのページを読めるようになり、最近の更新、検索、タグの一覧にも載ります。下書きに戻しても、すでに読まれた内容は取り消せません。
          </p>
          <div className="actions">
            <button
              type="button"
              className="button button-accent"
              aria-describedby={describedBy}
              disabled={disabled}
              onClick={() => void apply("public")}
            >
              公開する
            </button>
            <button
              ref={cancel}
              type="button"
              className="button"
              aria-describedby={describedBy}
              onClick={() => {
                setConfirming(false);
                publicOption.current?.focus();
              }}
            >
              やめる
            </button>
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
                  本文から {linkedDrafts.value.length}{" "}
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
        </section>
      )}
    </div>
  );
}
