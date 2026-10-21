/**
 * 失敗の通知の再送のボタンが消えて作り直される間の、focus の移し先の判断。PageEditor が描画のたびに
 * DOM と ref を一度に読んで渡し、返った値を ref に書いてから focus を移す。
 */
export interface RetryFocusInput {
  /** 再送を待つ間の focus の置き場が描画されている */
  anchorPresent: boolean;
  /** focus が置き場にある */
  onAnchor: boolean;
  /** focus が body に落ちているか、どこにも無い */
  lost: boolean;
  /** 前の描画までに置き場へ focus を預けた */
  parked: boolean;
  /** 消えた再送のボタンへ focus を戻す予定がある */
  restore: boolean;
  /** useFailureProgress の afterFailure */
  afterFailure: boolean;
  button: "absent" | "disabled" | "enabled";
  busy: boolean;
  /** 通知に出ている失敗が title の重複 */
  titleTaken: boolean;
}

/** retry は再送のボタン、anchor は置き場、title と body はその欄（タッチ端末はページの枠）へ移す */
export type RetryFocusAction = "retry" | "anchor" | "title" | "body" | null;

export interface RetryFocusDecision {
  restore: boolean;
  parked: boolean;
  action: RetryFocusAction;
}

/**
 * 預けた先が、再送のボタンに戻らずに消えたとき（成功、衝突など）は、focus を body に落とさない。
 * title の重複で終わったときは、次に直すのが title なので、title の欄へ移す。
 */
function leaveAnchor(input: RetryFocusInput, restore: boolean): RetryFocusDecision {
  const { anchorPresent, parked, lost, titleTaken } = input;
  const left = parked && !anchorPresent && lost && !restore;
  return {
    restore,
    parked: anchorPresent && parked,
    action: left ? (titleTaken ? "title" : "body") : null,
  };
}

export function retryButtonState(button: HTMLButtonElement | null): RetryFocusInput["button"] {
  if (button === null) return "absent";
  return button.disabled ? "disabled" : "enabled";
}

export function decideRetryFocus(input: RetryFocusInput): RetryFocusDecision {
  const { anchorPresent, onAnchor, lost, parked, restore, afterFailure, button, busy } = input;
  if (!restore) return leaveAnchor(input, false);
  // 失敗の通知が戻らずに操作が終わったとき（成功、衝突、再試行できない失敗など）に、
  // 次の失敗の通知へ持ち越さない。操作の途中は通知にボタンが無いので、busy の間は待つ
  if (!afterFailure || !(lost || onAnchor) || (button === "absent" && !busy))
    return leaveAnchor(input, false);
  if (button === "enabled")
    return { restore: false, parked: anchorPresent && parked, action: "retry" };
  if (anchorPresent && lost) return { restore: true, parked: true, action: "anchor" };
  return leaveAnchor(input, true);
}
