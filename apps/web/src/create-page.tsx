import { requestBodyFocus } from "./body-focus";
import { isPlainClick, Link } from "./Link";
import { createPage, failureMessage, findPageByTitle } from "./pages-api";
import { navigate, pageHref } from "./route";

export interface CreateProblem {
  message: string;
  /** title の重複で作れなかったとき、すでにあるページの id。開く導線に使う。 */
  existingId: string | null;
}

/**
 * title だけで空のページを作り、作れたらそのページへ移る。作れなかったときは理由を返す。
 * 新規作成のダイアログ、quick switcher、「まだありません」の画面が同じ手順で作る。
 *
 * 移った先では本文にカーソルを置く。開いているモーダルは focus を奪い返し、その外の要素には
 * focus を移せないので、`onCreated` は呼び出しの中で modal の `dialog.close()` を済ませる。
 * state の更新だけで閉じる実装は、後の effect で閉じるため、続く `requestBodyFocus` の
 * キーボードを保つ input に focus が通らない。閉じた後に印と input を足し、その後で移る。
 */
export async function createPageAndOpen(
  title: string,
  onCreated?: () => void,
): Promise<CreateProblem | null> {
  const res = await createPage({ title, body: "" });
  if (res.ok) {
    onCreated?.();
    requestBodyFocus(res.value.id);
    navigate(pageHref(res.value.id));
    return null;
  }
  if (res.reason === "title_conflict") {
    const existing = await findPageByTitle(title);
    return { message: res.message, existingId: existing.ok ? existing.value.id : null };
  }
  if (res.reason === "unauthorized") {
    return {
      message: "ログインの期限が切れました。ログインし直してください",
      existingId: null,
    };
  }
  return { message: failureMessage(res, "作成できなかった"), existingId: null };
}

export function CreateProblemMessage({
  problem,
  onOpenExisting,
}: {
  problem: CreateProblem;
  /** 既存のページへ移る直前に呼ぶ。ダイアログを閉じるのに使う。新しいタブで開く操作では呼ばない。 */
  onOpenExisting?: () => void;
}) {
  return (
    <p className="message message-error" role="alert">
      {problem.message}
      {problem.existingId !== null && (
        <>
          {" "}
          <Link
            href={pageHref(problem.existingId)}
            onClick={(event) => {
              if (isPlainClick(event)) onOpenExisting?.();
            }}
          >
            そのページを開く
          </Link>
        </>
      )}
    </p>
  );
}
