/**
 * `<img>` の src の代入を記録する（テスト用）。代入は実際の読み込みにせず、開発サーバーへ
 * 要求を出さない。どの URL を画像として読もうとしたかを見るために使う。
 */
export function recordImageSrcs(): { srcs: string[]; restore: () => void } {
  const srcs: string[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  if (descriptor === undefined) throw new Error("src の descriptor が無い");
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    configurable: true,
    get(this: HTMLImageElement) {
      return descriptor.get?.call(this);
    },
    set(value: string) {
      srcs.push(value);
    },
  });
  return {
    srcs,
    restore: () => Object.defineProperty(HTMLImageElement.prototype, "src", descriptor),
  };
}
