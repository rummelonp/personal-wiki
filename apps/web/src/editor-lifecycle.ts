import { type EditorState, hasPendingTitle, isDirty } from "./editor-session";

export interface LifecycleSession {
  getState(): EditorState;
  leave(): Promise<void>;
  checkFreshness(): Promise<void>;
}

/** document の代わりに渡せる最小の形。テストでは EventTarget に visibilityState を足して使う。 */
export interface VisibilitySource extends EventTarget {
  readonly visibilityState: string;
}

/**
 * タブの表示と離脱のイベントを、セッションの操作に結び付ける。戻り値で購読を解く。
 *
 * hidden で leave() を呼ぶのは、モバイルのブラウザがバックグラウンドのタブを pagehide や
 * beforeunload を発火せずに破棄することがあるため。hidden が離脱前に確実に届く最後の機会になる。
 * leave() は退避してから keepalive で送るので、送信が間に合わなくても内容は残る。
 */
export function bindLifecycle(
  session: LifecycleSession,
  doc: VisibilitySource,
  win: EventTarget,
): () => void {
  const onVisibility = () => {
    if (doc.visibilityState === "hidden") void session.leave();
    else void session.checkFreshness();
  };
  const onFocus = () => void session.checkFreshness();
  const onPageHide = () => void session.leave();
  const onBeforeUnload = (event: Event) => {
    const state = session.getState();
    if (isDirty(state) || hasPendingTitle(state) || state.busy === "saving") {
      event.preventDefault();
    }
  };
  doc.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("focus", onFocus);
  win.addEventListener("pagehide", onPageHide);
  win.addEventListener("beforeunload", onBeforeUnload);
  return () => {
    doc.removeEventListener("visibilitychange", onVisibility);
    win.removeEventListener("focus", onFocus);
    win.removeEventListener("pagehide", onPageHide);
    win.removeEventListener("beforeunload", onBeforeUnload);
  };
}

export interface SavableEditor {
  /** 打っている途中の title を確定してから保存する */
  commitTitle(): Promise<void>;
}

const editors = new Set<SavableEditor>();

/** 開いている編集画面の登録。ログアウトの前に全部の保存を待つために使う。戻り値で外す。 */
export function registerEditor(editor: SavableEditor): () => void {
  editors.add(editor);
  return () => {
    editors.delete(editor);
  };
}

export const SAVE_ALL_TIMEOUT_MS = 5000;

/**
 * ログアウトの前に、開いている編集画面の未保存の内容を送る。
 * 先にログアウトすると保存が 401 になり、入力した内容が手元の退避だけになるため。
 * 打っている途中の title は blur の確定に任せない。ログアウトの押下で blur が先に届く保証は無く、
 * 届かなければ title は保存にも退避にも入らず失われるため、ここで確定してから保存する。
 * まだ作っていないページも、title があればここで作る（作る前の内容を退避だけにしない）。
 *
 * 退避（localStorage）はここでは消さない。保存が失敗した、または間に合わなかった内容の唯一の写しであり、
 * 保存が成功した分はセッションが自分で消す。残った分は、次にそのページを開いたときに復元か破棄を選べる。
 * 待つのは保存の完了まででよく、失敗や遅延でログアウトを止めない（タイムアウトで先へ進む）。
 */
export async function saveAllEditors(timeoutMs = SAVE_ALL_TIMEOUT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([
      Promise.allSettled([...editors].map((editor) => editor.commitTitle())),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
