import { useEffect, useId } from "react";
import { Backlinks } from "./Backlinks";
import { setDocumentTitle } from "./document-title";
import { EmptyState } from "./EmptyState";
import { Link } from "./Link";
import { openNewPage } from "./new-page";
import { preloadPageViewWhenIdle } from "./page-view-loader";
import { breakAtPhrases } from "./phrase-wrap";
import { RailLayout } from "./Rail";
import { homeHref } from "./route";

/**
 * ページの URL の形でないパスと、id の URL で見つからないページの表示。title の URL は MissingPage が受け持つ。
 */
export function NotFound() {
  useEffect(() => {
    setDocumentTitle(null);
    preloadPageViewWhenIdle();
  }, []);
  return (
    <RailLayout rail={null}>
      <EmptyState
        level={1}
        title="ページが見つかりません"
        text="URL を確かめるか、一覧から探してください。"
        actions={
          <Link className="button" href={homeHref()}>
            一覧へ戻る
          </Link>
        }
      />
    </RailLayout>
  );
}

interface MissingPageProps {
  title: string;
  /** owner なら作成の導線を出す */
  owner: boolean;
  /** 被リンクの最初の取得が済み、画面の高さが決まったときに呼ぶ */
  onSettled: () => void;
}

/**
 * title の URL で開いたページが無いときの、空のページ。title と、その title へリンクしているページを
 * 通常のページと同じ位置に出し、リンク元から辿れるようにする。
 * 匿名には draft の title も同じ画面と文で出す。「ありません」と「見えません」を文で分けると、
 * draft の存在を推測できる。被リンクも API がどちらでも同じ public のリンク元を返す。
 * owner は draft も含めて全ページを読めるので、「まだありません」と作成の導線を出す。
 */
export function MissingPage({ title, owner, onSettled }: MissingPageProps) {
  const titleId = useId();
  return (
    // owner には、リンク元が 0 件であることが「どこからも張られていない title」という情報になる。
    // 匿名には public のリンク元しか返らず、0 件は何も伝えないので、通常のページと同じく節ごと隠す
    <RailLayout rail={<Backlinks target={{ title }} hideEmpty={!owner} onSettled={onSettled} />}>
      <article className="note" aria-labelledby={titleId}>
        <h1 id={titleId} className="note-title">
          {breakAtPhrases(title)}
        </h1>
        {owner ? (
          <>
            <p className="empty-text">まだありません。作成すると下書きのページができます。</p>
            <div className="actions">
              <button
                type="button"
                className="button button-primary"
                // 履歴に title の URL を残すと、作った後に戻ったとき作ったページが開き直され、戻るが空振りする
                onClick={() => openNewPage({ title, replace: true })}
              >
                このタイトルで作成
              </button>
            </div>
          </>
        ) : (
          <p className="empty-text">まだ作られていないか、公開されていないページです。</p>
        )}
      </article>
    </RailLayout>
  );
}
