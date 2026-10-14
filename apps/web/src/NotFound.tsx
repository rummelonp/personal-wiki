import { useEffect } from "react";
import { setDocumentTitle } from "./document-title";
import { Link } from "./Link";
import { openNewPage } from "./new-page";
import { homeHref } from "./route";

interface NotFoundProps {
  /**
   * owner が URL の title を開いたときの、その title。渡すと作成の導線を出す。
   * 匿名には渡さない。「ありません」と「見えません」を文で分けると、draft の存在を推測できる。
   */
  creatableTitle?: string;
}

/**
 * ページが無いときの表示。ページの URL の形でないパス、存在しないページ、匿名から見た draft の
 * title を同じ文で出す。匿名に draft の存在を推測させないよう、理由で文を分けない。
 * owner は draft も含めて全ページを読めるので、title の URL に限って「まだありません」と作成の導線を出す。
 */
export function NotFound({ creatableTitle }: NotFoundProps) {
  useEffect(() => {
    setDocumentTitle(null);
  }, []);
  if (creatableTitle !== undefined) return <Creatable title={creatableTitle} />;
  return (
    <section className="notice">
      <h1 className="notice-title">ページが見つかりません</h1>
      <p>
        <Link href={homeHref()}>最近の更新へ戻る</Link>
      </p>
    </section>
  );
}

function Creatable({ title }: { title: string }) {
  return (
    <section className="notice">
      <h1 className="notice-title">「{title}」はまだありません</h1>
      <div className="actions">
        <button
          type="button"
          className="button button-primary"
          onClick={() => openNewPage({ title })}
        >
          このタイトルで作成
        </button>
        <Link className="button" href={homeHref()}>
          最近の更新へ戻る
        </Link>
      </div>
    </section>
  );
}
