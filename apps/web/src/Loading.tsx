import { useEffect, useState } from "react";
import { expectTaggedRows } from "./entry-shape";
import { listHeading, listTitleClass } from "./list-heading";
import { loadingTitleFor, recallTitle } from "./page-titles";
import { RailLayout } from "./Rail";
import type { Route } from "./route";
import { useHoldScrollRestore } from "./scroll-restore";

/*
 * 読み込み中の見せ方。最終の配置と同じ形のスケルトンを、取得が遅いときだけ出す。
 * スケルトンの場所は初めから取っておき、描くのを遅らせる。遅れの間に届けば何も見せず、描いた後に差し替わっても
 * 位置が動かない。支援技術には、スケルトンの描画と関係なく、取得中であることと「読み込み中…」を最初から伝える。
 */

/** スケルトンを描き始めるまでの遅れ。これより早く届く取得には、何も見せない */
export const LOADING_DELAY_MS = 250;

let delayMs = LOADING_DELAY_MS;

/** テスト用。遅れを差し替え、元に戻す関数を返す。 */
export function setLoadingDelay(ms: number): () => void {
  const previous = delayMs;
  delayMs = ms;
  painting = false;
  return () => {
    delayMs = previous;
    painting = false;
  };
}

/*
 * 待ちの途中で画面が差し替わるとき（起動時の骨組みから一覧の骨組み、ページの取得への切り替え）、
 * 描き始めた後なら遅れを数え直さない。数え直すと、描いたスケルトンが消えてまた現れる。
 * 画面が差し替わる間は、古いスケルトンの後片付けと新しいスケルトンの描画が同じ commit に入るので、
 * スケルトンがひとつも無くなってから次の macrotask までを、待ちが続いている間とみなす。
 */
let mounted = 0;
let painting = false;
let endTimer: ReturnType<typeof setTimeout> | undefined;

/** スケルトンを描いてよいか。描く側は、スケルトンを包む要素に `skeleton-painted` を付ける（CSS がスケルトンを見せる）。 */
export function useSkeletonPainted(): boolean {
  const [painted, setPainted] = useState(() => delayMs <= 0 || painting);

  useEffect(() => {
    clearTimeout(endTimer);
    mounted++;
    return () => {
      mounted--;
      if (mounted === 0) {
        endTimer = setTimeout(() => {
          painting = false;
        }, 0);
      }
    };
  }, []);

  useEffect(() => {
    if (painted) {
      painting = true;
      return;
    }
    const timer = setTimeout(() => {
      painting = true;
      setPainted(true);
    }, delayMs);
    return () => clearTimeout(timer);
  }, [painted]);

  return painted;
}

/**
 * 操作のレスポンスや候補の取得を待つ間の状態の文字を、待ちが遅れの長さを超えたときだけ出すための印。
 * すぐ届くレスポンスで文字がちらつかないよう、スケルトンと同じ遅れ（`LOADING_DELAY_MS`）を使う。
 * スケルトンとは別の待ちなので、スケルトンを描いた記録（`painting`）は読み書きしない。
 */
export function useDelayedWhile(active: boolean): boolean {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    if (delayMs <= 0) {
      setShown(true);
      return;
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [active]);

  return active && shown;
}

/**
 * 取り付けてから 2 frame 後に true になる。live region の中身を、取り付けとは別の frame で入れるための印。
 * 経路の遷移や離散イベントによる描画は commit の終わりで effect まで同期に流れるので、effect で
 * 文字を入れても、支援技術からは中身を持ったまま挿入したのと同じになる。frame を 1 つ空けただけでは、
 * 取り付けと同じ描画の更新に入ることがあるので 2 つ待つ。
 */
export function useAfterFrames(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setReady(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);

  return ready;
}

/**
 * 支援技術にだけ伝える「〜を読み込み中…」。取得中の領域の外に置く（`aria-busy` の中の status は、
 * 多くの読み上げが変化を伝えない）。中身を持ったまま挿入した status も読まれないので、
 * 空で置いてから、後の frame で文字を入れる（`useAfterFrames`）。
 * 文は前後の文脈なしに読まれるので、何を読み込んでいるかを含める。
 */
export function LoadingStatus({ text }: { text: string }) {
  const ready = useAfterFrames();
  return (
    <span className="visually-hidden" role="status">
      {ready ? text : ""}
    </span>
  );
}

const paintedClass = (painted: boolean) => (painted ? "skeleton-painted" : undefined);

/** 一覧の行のスケルトン。見出しや配置は持たず、一覧の中に置く。 */
export function SkeletonEntries({ count = 5 }: { count?: number }) {
  const painted = useSkeletonPainted();
  return (
    <ul className={`skeleton-entries ${paintedClass(painted) ?? ""}`} aria-hidden="true">
      <SkeletonEntryRows count={count} />
    </ul>
  );
}

/** 実際の一覧（ul.entries）の末尾に足す行のスケルトン。 */
export function SkeletonEntryRows({
  count,
  painted = false,
}: {
  count: number;
  painted?: boolean;
}) {
  const tagged = expectTaggedRows();
  return Array.from({ length: count }, (_, i) => (
    <li
      className={painted ? "skeleton-entry skeleton-painted" : "skeleton-entry"}
      aria-hidden={painted || undefined}
      // biome-ignore lint/suspicious/noArrayIndexKey: 並びの変わらない飾りの行
      key={i}
    >
      <div className="skeleton-entry-head">
        <span className="skeleton skeleton-text skeleton-entry-title" />
        <span className="skeleton skeleton-text skeleton-entry-time" />
      </div>
      <div className="skeleton-entry-excerpt">
        <span className="skeleton skeleton-text" />
        <span className="skeleton skeleton-text" />
      </div>
      {tagged && (
        <div className="skeleton-entry-chips">
          <span className="skeleton skeleton-chip" />
          <span className="skeleton skeleton-chip" />
        </div>
      )}
    </li>
  ));
}

/** 「さらに表示」の読み込み中に、実際の一覧の末尾へ足すスケルトンの行。遅れの間は何も足さない（ボタンを動かさない）。 */
export function LoadingMoreRows({ count = 3 }: { count?: number }) {
  const painted = useSkeletonPainted();
  if (!painted) return null;
  return <SkeletonEntryRows count={count} painted />;
}

/**
 * 一覧の画面全体のスケルトン。heading が分かっていれば文字で出す。
 * 行き先が一覧と決まっていない（知らない URL）ときは、status の文を status で差し替える。
 */
export function ListSkeleton({
  heading,
  status = "一覧を読み込み中…",
}: {
  heading?: string | undefined;
  status?: string;
}) {
  const painted = useSkeletonPainted();
  return (
    <RailLayout rail={null}>
      <LoadingStatus text={status} />
      <div className={`home ${paintedClass(painted) ?? ""}`} aria-busy="true">
        {heading === undefined ? (
          <div className="list-title" aria-hidden="true">
            <span className="skeleton skeleton-text skeleton-heading" />
          </div>
        ) : (
          <h1 className={listTitleClass(heading)}>{heading}</h1>
        )}
        <ul className="skeleton-entries" aria-hidden="true">
          <SkeletonEntryRows count={5} />
        </ul>
      </div>
    </RailLayout>
  );
}

/**
 * ページの画面全体のスケルトン。title が分かっていれば文字で出し、スケルトンは本文の行だけにする
 * （title は読み込み後も同じ位置と書体で出るので、動かない）。
 * `owner` が false なら公開の行を出さない（匿名の画面には無く、届くと本文が上へ詰まるため）。
 * 起動時はまだ分からないので、使う人の多い owner の形を既定にする。
 */
export function PageSkeleton({
  title,
  owner = true,
}: {
  title?: string | undefined;
  owner?: boolean | undefined;
}) {
  const painted = useSkeletonPainted();
  const rail = (
    <div className={`skeleton-rail ${paintedClass(painted) ?? ""}`} aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div className="skeleton-rail-section" key={i}>
          <span className="skeleton skeleton-text skeleton-rail-label" />
          <span className="skeleton skeleton-text" />
          <span className="skeleton skeleton-text skeleton-rail-short" />
        </div>
      ))}
    </div>
  );
  return (
    <RailLayout rail={rail}>
      <LoadingStatus text="ページを読み込み中…" />
      <div className={`note ${paintedClass(painted) ?? ""}`} aria-busy="true">
        <div className="note-title">
          {title === undefined ? (
            <span className="skeleton skeleton-text skeleton-title" aria-hidden="true" />
          ) : (
            title
          )}
        </div>
        {owner && (
          <div className="skeleton-meta" aria-hidden="true">
            {/* 本物の segmented と同じ文字を透明で置き、幅と高さを合わせる */}
            <span className="skeleton skeleton-segmented">
              <span>下書き</span>
              <span>公開</span>
            </span>
          </div>
        )}
        <div className="skeleton-body" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <span className="skeleton skeleton-text" key={i} />
          ))}
        </div>
      </div>
    </RailLayout>
  );
}

/** 起動時と lazy の読み込みの間に、行き先の画面に合わせて出すスケルトン。 */
export function RouteSkeleton({ route, owner }: { route: Route; owner?: boolean | undefined }) {
  useHoldScrollRestore();
  switch (route.name) {
    case "home": {
      // 見出しは URL だけから作り、データは出さない。公開範囲で絞る見出しは owner だけのものなので、
      // owner か分からない起動時（undefined）に owner と匿名で見出しが分かれるなら、文字にせずスケルトンにする。
      // owner の見出しで出すと匿名に一瞬「下書き」と見せ、匿名の見出しで出すと owner で見出しが変わる
      const ownerHeading = listHeading(route.query, route.tag, route.visibility);
      const anonymousHeading = listHeading(route.query, route.tag);
      const heading =
        owner === true
          ? ownerHeading
          : owner === false || ownerHeading === anonymousHeading
            ? anonymousHeading
            : undefined;
      return <ListSkeleton heading={heading} />;
    }
    case "title":
      return <PageSkeleton title={loadingTitleFor(route.title)} owner={owner} />;
    case "page":
      return <PageSkeleton title={recallTitle(route.id)} owner={owner} />;
    case "new":
      return <PageSkeleton owner={owner} />;
    case "unknown":
      return <ListSkeleton status="読み込み中…" />;
  }
}
