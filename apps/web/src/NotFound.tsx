import { useEffect } from "react";
import { setDocumentTitle } from "./document-title";
import { Link } from "./Link";
import { homeHref } from "./route";

/**
 * ページが無いときの表示。ページの URL の形でないパス、存在しないページ、匿名から見た draft の
 * title を同じ文で出す。匿名に draft の存在を推測させないよう、理由で文を分けない。
 */
export function NotFound() {
  useEffect(() => {
    setDocumentTitle(null);
  }, []);
  return (
    <section className="notice">
      <h1 className="notice-title">ページが見つかりません</h1>
      <p>
        <Link href={homeHref()}>最近の更新へ戻る</Link>
      </p>
    </section>
  );
}
