/**
 * test 用のホスト。packages/editor は色を CSS 変数だけを通して受け取るので、
 * test でもホストと同じ役割 token と明暗の切り替えを置かないと、view の色が解決されない。
 *
 * ホストの token を import できないため値は複製になる。ここに置くのは既定テーマの式だけで
 * （エディタ面の色相だけは `setEditorHue` で他のテーマのものに替えられる）、
 * この値を使うテストが確かめるのは「Editor が役割 token と切り替えを正しく使っているか」であり、
 * token そのものの正しさ（役割 token が 4.5:1 を満たすか）ではない。apps/web が token を持つときは、
 * その値でコントラストを確かめるテストを apps/web の側に置く。
 *
 * vitest の `setupFiles` から読むので、すべての editor の test で既定（ライト）が効く。
 */
const TOKENS_CSS = `
:root {
  color-scheme: light;
  /* 16px 以外にしておく。本文・title の大きさが固定 px でなくホストの root に
     つられて継承されているだけの回帰を、既定の 16px と偶然一致させず検出する
     （typography.test.ts）。 */
  font-size: 20px;
  --ui-light: initial;
  --ui-dark: ;

  /* テーマがエディタ面へ渡すのは色相だけ（--ui-editor-hue）。262 は既定テーマの色相 */
  --ui-editor-hue: 262;
  --ui-color-background: var(--ui-light, #ffffff) var(--ui-dark, hsl(var(--ui-editor-hue) 12% 12%));
  --ui-color-text: var(--ui-light, hsl(var(--ui-editor-hue) 18% 13%))
    var(--ui-dark, hsl(var(--ui-editor-hue) 12% 87%));
  --ui-color-muted: var(--ui-light, hsl(var(--ui-editor-hue) 8% 42%))
    var(--ui-dark, hsl(var(--ui-editor-hue) 8% 63%));
  --ui-color-accent: var(--ui-light, #5b30c8) var(--ui-dark, #b39dff);
  --ui-color-on-accent: var(--ui-light, #ffffff) var(--ui-dark, var(--ui-color-background));
  --ui-color-surface: color-mix(in srgb, var(--ui-color-text) 4%, var(--ui-color-background));
  --ui-color-border: color-mix(in srgb, var(--ui-color-text) 16%, var(--ui-color-background));
  --ui-color-accent-soft: color-mix(in srgb, var(--ui-color-accent) 12%, var(--ui-color-background));
  --ui-color-danger: var(--ui-light, #b3261e) var(--ui-dark, #ff8f87);

  --ui-radius-sm: 0.25rem;

  /* 実際の書体名はホストの token が持つ。ここでは Editor が --ui-font-body/-heading と
     --ui-font-mono のどちらを当てているかを test で見分けられれば足りるので、区別できる名前だけを置く。 */
  --ui-font-body: "editor-test-body", sans-serif;
  --ui-font-heading: var(--ui-font-body);
  --ui-font-mono: "editor-test-mono", monospace;
}

:root[data-ui-scheme="dark"] {
  color-scheme: dark;
  --ui-light: ;
  --ui-dark: initial;
}

/* 本文の色と地はホストが body に置く */
body {
  margin: 0;
  color: var(--ui-color-text);
  background: var(--ui-color-background);
}
`;

const STYLE_ID = "editor-test-tokens";

function install(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = TOKENS_CSS;
  document.head.append(style);
}

install();

/** 個人の明暗。ホストは `<html>` に置くので、test も同じ場所で切り替える */
export function setScheme(scheme: "light" | "dark"): void {
  document.documentElement.setAttribute("data-ui-scheme", scheme);
}

export function resetScheme(): void {
  document.documentElement.removeAttribute("data-ui-scheme");
}

/**
 * エディタ面の色相。テーマはエディタ面へ色相だけを渡すので、色相を変えればテーマを変えたのと同じ色になる。
 * 役割 token は `:root` で宣言して `:root` で解決されるので、`<html>` に置く。
 */
export function setEditorHue(hue: number): void {
  document.documentElement.style.setProperty("--ui-editor-hue", String(hue));
}

export function resetEditorHue(): void {
  document.documentElement.style.removeProperty("--ui-editor-hue");
}
