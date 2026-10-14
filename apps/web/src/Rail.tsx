import type { ReactNode } from "react";

interface RailLayoutProps {
  /** 右の列の中身。null なら列を出さず、本文だけを中央に置く。 */
  rail: ReactNode | null;
  children: ReactNode;
}

/**
 * 「中央が本文や一覧、右が補助情報」の配置。トップとノートで共通に使う。
 * 狭い画面では右の列を本文の下に回す（CSS 側）。
 */
export function RailLayout({ rail, children }: RailLayoutProps) {
  return (
    <div className={rail === null ? "rail-layout rail-layout-single" : "rail-layout"}>
      <div className="rail-main">{children}</div>
      {rail !== null && (
        <aside className="rail" aria-label="補助情報">
          {rail}
        </aside>
      )}
    </div>
  );
}

/** 右の列の 1 区画。見出しの書き方をここにそろえる。 */
export function RailSection({
  title,
  className,
  children,
}: {
  title: string;
  /** 区画を指す印。狭い画面での並べ替えなど、CSS から区画を選ぶのに使う。 */
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={className === undefined ? "rail-section" : `rail-section ${className}`}>
      <h2 className="rail-label">{title}</h2>
      {children}
    </section>
  );
}
