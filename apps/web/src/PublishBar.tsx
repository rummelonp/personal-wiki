import { useEffect, useId, useRef, useState } from "react";
import { useDelayedWhile } from "./Loading";

type Visibility = "draft" | "public";

const OPTIONS: ReadonlyArray<{ value: Visibility; label: string }> = [
  { value: "draft", label: "下書き" },
  { value: "public", label: "公開" },
];

const PENDING_NOTES: Record<Visibility, string> = {
  public: "公開にしています…",
  draft: "下書きに戻しています…",
};

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

interface PublishBarProps {
  visibility: Visibility;
  /** まだ作っていないページ。作る前のページは公開できないので、操作を無効にして理由を添える */
  uncreated: boolean;
  /** 保存中や失敗の直後など、今は切り替えられない */
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
  /** 切り替えを依頼して応答を待っている先。待っている間は、この選択を選択中として見せ、押し直しを受けない */
  pending: Visibility | null;
  /** 切り替えを依頼し、済むまで待つ。失敗は呼び出し側の通知が伝え、状態は元のまま */
  onChange: (to: Visibility) => Promise<void>;
}

/**
 * title のすぐ下の、公開の状態と操作の行。
 *
 * draft から public への変化だけ、確定の前に確認を挟む。public にすると匿名の一覧、検索、タグに載り、
 * 取り消してもすでに見た人の手元には残るため。public から draft へは、見えなくなる側なので確認しない。
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
}: PublishBarProps) {
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const publicOption = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const confirmTextId = useId();
  const previousVisibility = useRef(visibility);
  const refocusPublic = useRef(false);
  // 選択は押した直後に動かす。文字は応答がすぐ届くときにちらつかないよう、遅らせて出す
  const pendingShown = useDelayedWhile(pending !== null);
  const shownVisibility = pending ?? visibility;
  const shareUrl = `${window.location.origin}${sharePath}`;
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
    setNote(visibility === "public" ? "公開しました。" : "下書きに戻しました。");
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
      setNote("URL をコピーしました。");
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
      {uncreated && <span className="publish-hint">ページを作ると、公開を選べます。</span>}
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
              aria-describedby={confirmTextId}
              disabled={disabled}
              onClick={() => void apply("public")}
            >
              公開する
            </button>
            <button
              ref={cancel}
              type="button"
              className="button"
              aria-describedby={confirmTextId}
              onClick={() => {
                setConfirming(false);
                publicOption.current?.focus();
              }}
            >
              やめる
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
