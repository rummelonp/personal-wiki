import { isBackupStorageKey } from "./draft-backup";
import { type EditorState, hasPendingTitle, isDirty } from "./editor-session";

export interface LifecycleSession {
  getState(): EditorState;
  leave(): Promise<void>;
  checkFreshness(): Promise<void>;
  backupsChanged(): void;
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
 * leave() は同期で退避してから keepalive の送信を保存のキューに並べるので、送信が間に合わなくても内容は残る。
 * キューの前で IME の変換が落ち着くのを待つ処理があると、非表示の間は frame が止まって落ち着かないので、
 * 送信は表示に戻るまで待つ（packages/editor の ime.ts の compositionSettledNotifier）。
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
  // 別のタブが localStorage を書き換えたときだけ届く。key が null なのは clear()
  const onStorage = (event: Event) => {
    const { key } = event as StorageEvent;
    if (key === null || isBackupStorageKey(key)) session.backupsChanged();
  };
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
  win.addEventListener("storage", onStorage);
  return () => {
    doc.removeEventListener("visibilitychange", onVisibility);
    win.removeEventListener("focus", onFocus);
    win.removeEventListener("pagehide", onPageHide);
    win.removeEventListener("beforeunload", onBeforeUnload);
    win.removeEventListener("storage", onStorage);
  };
}
