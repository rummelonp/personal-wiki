import { useEffect, useState } from "react";
import { listHeading } from "./list-heading";
import { RailLayout } from "./Rail";
import type { Route } from "./route";

/*
 * 読み込み中の見せ方。最終の配置と同じ形の帯（スケルトン）を、取得が遅いときだけ出す。
 * 帯の場所は初めから取っておき、描くのを遅らせる。遅れの間に届けば何も見せず、描いた後に差し替わっても
 * 位置が動かない。支援技術には、帯の描画と関係なく、取得中であることと「読み込み中…」を最初から伝える。
 */

/** 帯を描き始めるまでの遅れ。これより早く届く取得には、何も見せない */
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
 * 描き始めた後なら遅れを数え直さない。数え直すと、描いた帯が消えてまた現れる。
 * 画面が差し替わる間は、古い帯の後片付けと新しい帯の描画が同じ commit に入るので、
 * 帯がひとつも無くなってから次の macrotask までを、待ちが続いている間とみなす。
 */
let mounted = 0;
let painting = false;
let endTimer: ReturnType<typeof setTimeout> | undefined;

/** 帯を描いてよいか。描く側は、帯を包む要素に `skeleton-painted` を付ける（CSS が帯を見せる）。 */
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

/** 支援技術にだけ伝える「読み込み中…」。取得中の領域の中に置く。 */
export function LoadingStatus() {
  return (
    <span className="visually-hidden" role="status">
      読み込み中…
    </span>
  );
}

const paintedClass = (painted: boolean) => (painted ? "skeleton-painted" : undefined);

/** 一覧の行の帯。見出しや配置は持たず、一覧の中に置く。 */
export function SkeletonEntries({ count = 5 }: { count?: number }) {
  const painted = useSkeletonPainted();
  return (
    <ul className={`skeleton-entries ${paintedClass(painted) ?? ""}`} aria-hidden="true">
      <SkeletonEntryRows count={count} />
    </ul>
  );
}

/** 実際の一覧（ul.entries）の末尾に足す行の帯。 */
export function SkeletonEntryRows({ count }: { count: number }) {
  return Array.from({ length: count }, (_, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: 並びの変わらない飾りの行
    <li className="skeleton-entry" key={i}>
      <div className="skeleton-entry-head">
        <span className="skeleton skeleton-text skeleton-entry-title" />
        <span className="skeleton skeleton-text skeleton-entry-time" />
      </div>
      <div className="skeleton-entry-excerpt">
        <span className="skeleton skeleton-text" />
        <span className="skeleton skeleton-text" />
      </div>
    </li>
  ));
}

/** 一覧の画面全体の帯。heading が分かっていれば文字で出す。 */
export function ListSkeleton({ heading }: { heading?: string }) {
  const painted = useSkeletonPainted();
  return (
    <RailLayout rail={null}>
      <div className={`home ${paintedClass(painted) ?? ""}`} aria-busy="true">
        <LoadingStatus />
        {heading === undefined ? (
          <div className="list-title" aria-hidden="true">
            <span className="skeleton skeleton-text skeleton-heading" />
          </div>
        ) : (
          <h1 className="list-title">{heading}</h1>
        )}
        <ul className="skeleton-entries" aria-hidden="true">
          <SkeletonEntryRows count={5} />
        </ul>
      </div>
    </RailLayout>
  );
}

/**
 * ページの画面全体の帯。title が分かっていれば文字で出し、帯は本文の行だけにする
 * （title は読み込み後も同じ位置と書体で出るので、動かない）。
 */
export function PageSkeleton({ title }: { title?: string }) {
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
      <div className={`note ${paintedClass(painted) ?? ""}`} aria-busy="true">
        <LoadingStatus />
        <div className="note-title">
          {title === undefined ? (
            <span className="skeleton skeleton-text skeleton-title" aria-hidden="true" />
          ) : (
            title
          )}
        </div>
        <div className="skeleton-meta" aria-hidden="true">
          <span className="skeleton skeleton-dot" />
          <span className="skeleton skeleton-dot" />
        </div>
        <div className="skeleton-body" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <span className="skeleton skeleton-text" key={i} />
          ))}
        </div>
      </div>
    </RailLayout>
  );
}

/** 起動時と lazy の読み込みの間に、行き先の画面に合わせて出す帯。 */
export function RouteSkeleton({ route }: { route: Route }) {
  switch (route.name) {
    case "home":
      return <ListSkeleton heading={listHeading(route.query, route.tag)} />;
    case "title":
      return <PageSkeleton title={route.title} />;
    case "page":
    case "new":
      return <PageSkeleton />;
    case "unknown":
      return <ListSkeleton />;
  }
}
