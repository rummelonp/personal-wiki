import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { navigate } from "./route";

/** 左ボタンの素のクリックか。修飾キー付きは、ブラウザが別タブなどで開く操作。 */
export function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** 同じオリジンの SPA 内の遷移。修飾キー付きのクリックなどはブラウザの既定（別タブ）に任せる。 */
export function Link({
  href,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented || !isPlainClick(event) || rest.target === "_blank") return;
    event.preventDefault();
    navigate(href);
  }
  return <a {...rest} href={href} onClick={handleClick} />;
}
