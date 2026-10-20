import { type MouseEvent, type RefObject, useEffect, useLayoutEffect, useRef } from "react";

/**
 * 焦点がどこにも無いか。WebKit は押したボタンでなく dialog 自身に焦点を移し、閉じるときに戻し先の印が
 * 無効だと、次の描画まで閉じた dialog を activeElement に残す。body に落ちたかだけを見ると、焦点を戻す
 * 時刻が描画の前か後かで結果が変わる
 */
export function focusIsAdrift(active: Element | null): boolean {
  return (
    active === null || active === document.body || active.closest("dialog:not([open])") !== null
  );
}

interface ModalDialogOptions {
  open: boolean;
  /** 閉じる要求（Escape、戻る操作、枠の外の押下、閉じた後の close）。状態を閉じに合わせる */
  onClose: () => void;
  /** showModal の直後。開いた直後の焦点や選択を決める */
  onOpened?: (dialog: HTMLDialogElement) => void;
  /**
   * 閉じた後に焦点を戻す先。close は閉じた後の別のタスクで届き、その間に利用者が別の場所へ焦点を
   * 移していることがあるので、焦点がどこにも無いときだけ戻す
   */
  returnFocusTo?: () => HTMLElement | null | undefined;
}

interface ModalDialog {
  ref: RefObject<HTMLDialogElement | null>;
  /** `<dialog>` へそのまま渡す */
  props: {
    onCancel: () => void;
    onClose: () => void;
    onMouseDown: (event: MouseEvent<HTMLDialogElement>) => void;
  };
}

/**
 * `open` と dialog の開閉を合わせ、閉じる経路ごとの競合を捌く modal dialog の共通の仕組み。
 * ダイアログの中身は呼び出し側が `open` のときだけ描く。
 */
export function useModalDialog({
  open,
  onClose,
  onOpened,
  returnFocusTo,
}: ModalDialogOptions): ModalDialog {
  const ref = useRef<HTMLDialogElement>(null);
  // 開閉の effect は open だけを依存にするので、onOpened などは最新のものを ref 越しに呼ぶ
  const latest = useRef({ onClose, onOpened, returnFocusTo });
  useLayoutEffect(() => {
    latest.current = { onClose, onOpened, returnFocusTo };
  });

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      dialog.showModal();
      latest.current.onOpened?.(dialog);
    } else if (!open && dialog.open) dialog.close();
  }, [open]);

  return {
    ref,
    props: {
      // Escape や戻る操作（cancel）はブラウザが dialog を閉じる。close を待たずに状態を合わせないと、
      // close が届くまでの開き直しは状態が変わらず、開かない。
      // preventDefault で閉じるのを止めないのは、利用者の操作を挟まずに繰り返すと Chromium が従わなくなるため
      onCancel: () => latest.current.onClose(),
      onClose: () => {
        // close は閉じた後の別のタスクで届く。素早く開き直した後に届いた前の開きの close は、
        // 開き直した dialog を閉じてしまうので捨てる
        if (ref.current?.open) return;
        latest.current.onClose();
        if (focusIsAdrift(document.activeElement)) latest.current.returnFocusTo?.()?.focus();
      },
      onMouseDown: (event) => {
        // 枠の外（backdrop）を押したときだけ閉じる。dialog 自体は余白を持たない
        if (event.target === event.currentTarget) latest.current.onClose();
      },
    },
  };
}
