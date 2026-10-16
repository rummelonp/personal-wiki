import type { ReactNode } from "react";

interface EmptyStateProps {
  /** 見出し 1 行。何が無いか、何が起きたかを言い切る。 */
  title: string;
  /** 補足 1 行。理由か、次に何ができるか。見出しだけで足りるなら省く。 */
  text?: ReactNode;
  /** 次の動作（ボタンやリンク）。 */
  actions?: ReactNode;
  /** 画面の主見出しなら 1、一覧の見出しの下に出すなら 2。 */
  level?: 1 | 2;
  role?: "status";
}

/**
 * 画面に出すものが無いときの表示（404、検索 0 件、ログインの案内など）。見出し、補足、次の動作の
 * 3 つを同じ形で出し、素の 1 行で行き止まりにしない。
 */
export function EmptyState({ title, text, actions, level = 2, role }: EmptyStateProps) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <section className="empty" role={role}>
      <Heading className="empty-title">{title}</Heading>
      {text !== undefined && <p className="empty-text">{text}</p>}
      {actions !== undefined && <div className="actions">{actions}</div>}
    </section>
  );
}
