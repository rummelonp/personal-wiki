import { useEffect } from "react";
import { setDocumentTitle } from "./document-title";
import { EmptyState } from "./EmptyState";
import { Link } from "./Link";
import { openNewPage } from "./new-page";
import { RailLayout } from "./Rail";
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
    <RailLayout rail={null}>
      <EmptyState
        level={1}
        title="ページが見つかりません"
        text="URL を確かめるか、一覧から探してください。"
        actions={
          <Link className="button" href={homeHref()}>
            最近の更新へ戻る
          </Link>
        }
      />
    </RailLayout>
  );
}

function Creatable({ title }: { title: string }) {
  return (
    <RailLayout rail={null}>
      <EmptyState
        level={1}
        title={`「${title}」はまだありません`}
        text="このタイトルで作成すると、下書きのページができます。"
        actions={
          <>
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
          </>
        }
      />
    </RailLayout>
  );
}
