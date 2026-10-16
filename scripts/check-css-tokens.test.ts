import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "check-css-tokens.mjs");

let dir: string;

function put(path: string, content: string) {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function run(...args: string[]) {
  const r = spawnSync("node", [script, ...args], { cwd: dir, encoding: "utf8" });
  return { status: r.status, stderr: r.stderr };
}

/** 1 つの規則の中身を検査する */
function check(declarations: string) {
  put("a.css", `.a {\n${declarations}\n}\n`);
  return run("a.css");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "check-css-tokens-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("check-css-tokens", () => {
  describe("直書きを拾う", () => {
    it.each([
      ["hex", "color: #1b1e24;", "#1b1e24"],
      ["短い hex", "color: #fff;", "#fff"],
      ["rgb()", "color: rgb(0 0 0 / 0.4);", "rgb(0 0 0 / 0.4)"],
      ["rgba()", "background: rgba(0, 0, 0, 0.4);", "rgba(0, 0, 0, 0.4)"],
      ["hsl()", "color: hsl(220 10% 10%);", "hsl(220 10% 10%)"],
      ["oklch()", "color: oklch(0.5 0.1 250);", "oklch(0.5 0.1 250)"],
      ["色名", "background: white;", "white"],
      ["border の色名", "border: var(--border-width) solid red;", "red"],
      ["var() の fallback の色", "color: var(--color-fg, #000);", "#000"],
      ["px", "padding: 12px;", "12px"],
      ["rem", "max-width: 24rem;", "24rem"],
      ["em", "text-underline-offset: 0.2em;", "0.2em"],
      ["vh", "min-height: 50vh;", "50vh"],
      ["dvh", "max-height: calc(100dvh - var(--space-4));", "100dvh"],
      ["svmin", "width: 10svmin;", "10svmin"],
      ["lvb", "height: 10lvb;", "10lvb"],
      ["rch", "padding: 2rch;", "2rch"],
      ["!important の付いた直書き", "padding: 12px !important;", "12px"],
      ["小数の先頭の 0 がない長さ", "margin: .5rem;", ".5rem"],
      ["負の長さ", "margin-top: -4px;", "-4px"],
      ["calc() の中の長さ", "width: calc(100% - 2px);", "2px"],
      ["clamp() の中の長さ", "width: clamp(var(--space-4), 5vw, 2rem);", "5vw"],
      ["var() の fallback の長さ", "top: var(--offset, 8px);", "8px"],
      ["カスタムプロパティの定義", "--gap: 12px;", "12px"],
      ["font-family", 'font-family: "Hiragino Sans", sans-serif;', '"Hiragino Sans"'],
      [
        "font-family の一部だけ token",
        "font-family: var(--font-sans), serif;",
        "var(--font-sans), serif",
      ],
      ["font の generic family", "font: inherit serif;", "inherit serif"],
      ["box-shadow", "box-shadow: 0 0 var(--space-1) black;", "black"],
      ["token を含まない box-shadow", "box-shadow: 0 0 0 0 transparent;", "0 0 0 0 transparent"],
      ["text-shadow", "text-shadow: 0 0 0 transparent;", "0 0 0 transparent"],
      ["z-index の数値", "z-index: 10;", "10"],
      ["z-index の 0", "z-index: 0;", "0"],
      ["z-index の負数", "z-index: -1;", "-1"],
    ])("%s", (_name, declarations, shown) => {
      const r = check(declarations);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(shown);
    });

    it("ファイル名と行番号を出す", () => {
      put("a.css", ".a {\n  color: var(--color-fg);\n  padding: 4px;\n}\n");
      const r = run("a.css");
      expect(r.stderr).toContain("a.css:3: 4px");
    });

    it("複数行の値は、直書きのある行を出す", () => {
      put("a.css", ".a {\n  margin:\n    var(--space-1)\n    8px;\n}\n");
      expect(run("a.css").stderr).toContain("a.css:4: 8px");
    });

    it("入れ子の規則の中も見る", () => {
      put("a.css", ".a {\n  color: var(--color-fg);\n  &:hover {\n    color: #fff;\n  }\n}\n");
      expect(run("a.css").stderr).toContain("a.css:4: #fff");
    });

    it("@media の中の規則も見る", () => {
      put("a.css", "@media (max-width: 40rem) {\n  .a {\n    padding: 4px;\n  }\n}\n");
      expect(run("a.css").stderr).toContain("a.css:3: 4px");
    });

    it("1 つの宣言の複数の直書きを別々に出す", () => {
      put("a.css", ".a {\n  padding: 6px 2px;\n}\n");
      const r = run("a.css");
      expect(r.stderr).toContain("6px");
      expect(r.stderr).toContain("2px");
      expect(r.stderr).toContain("2 件");
    });
  });

  describe("直書きとして拾わない", () => {
    it.each([
      ["token だけの値", "color: var(--color-fg);\npadding: var(--space-1) var(--space-3);"],
      ["0", "margin: 0;\npadding: 0 var(--space-3);"],
      ["単位付きの 0", "top: 0px;\nleft: 0rem;"],
      ["var() の fallback の 0", "top: var(--offset, 0px);"],
      ["%", "width: 100%;\nflex-basis: 50%;"],
      ["fr", "grid-template-columns: auto 1fr;\ngrid-template-columns: minmax(0, 1fr);"],
      ["transparent", "border-color: transparent;"],
      ["currentColor", "background: currentColor;"],
      ["CSS 全体のキーワード", "color: inherit;\nbackground: initial;\nfont-family: inherit;"],
      ["font の継承", "font: inherit;"],
      ["calc() の係数", "outline: calc(var(--border-width) * 2) solid var(--color-focus);"],
      ["単位なしの数", "line-height: 1;\nopacity: 0.5;\n-webkit-line-clamp: 2;\nflex: 1 1 auto;"],
      ["時間", "transition-duration: 150ms;"],
      ["角度", "transform: rotate(45deg);"],
      ["var() だけの font-family", "font-family: var(--font-sans);"],
      [
        "var() だけの font-family（複数行）",
        "font-family:\n    var(--font-sans),\n    var(--font-serif);",
      ],
      [
        "token だけの box-shadow",
        "box-shadow: inset calc(var(--border-width) * 2) 0 0 var(--color-accent);",
      ],
      ["box-shadow: none", "box-shadow: none;"],
      ["z-index の token", "z-index: var(--z-header);"],
      ["z-index: auto", "z-index: auto;"],
      [
        "!important の付いた token だけの値",
        "font-family: var(--font-sans) !important;\nz-index: auto !important;\nbox-shadow: none !important;",
      ],
      ["token から作る色関数", "color: rgb(var(--color-rgb) / 50%);"],
      ["相対色", "color: rgb(from var(--color-fg) r g b / 50%);"],
      [
        "font-family の語に当たる色名",
        "font-family: var(--font-sans);\nfont-weight: var(--font-weight-strong);",
      ],
      ["変数名に含まれる色名と単位", "color: var(--color-red);\npadding: var(--space-1px);"],
      ["文字列の中身", 'content: "12px #fff red";\nquotes: "\\"" "\\"";'],
      [
        "url() の中身",
        'background: url("data:image/svg+xml,%3Csvg fill=%23fff%3E") no-repeat;\nbackground: url(a-12px.png);',
      ],
      ["コメントの中身", "color: var(--color-fg); /* 例: 12px, #fff */\n/* margin: 4px; */"],
    ])("%s", (_name, declarations) => {
      const r = check(declarations);
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    });

    it("セレクタの #id と属性値", () => {
      put("a.css", '#abc123 .a-1px[data-x="12px"] {\n  color: var(--color-fg);\n}\n');
      expect(run("a.css").status).toBe(0);
    });

    it("at-rule の条件（media query の幅には var() を使えない）", () => {
      put(
        "a.css",
        "@media (max-width: 40rem) {\n  .a {\n    color: var(--color-fg);\n  }\n}\n@media (min-resolution: 2dppx) and (pointer: coarse) {\n  .b {\n    color: var(--color-fg);\n  }\n}\n@import url(other.css);\n",
      );
      expect(run("a.css").status).toBe(0);
    });

    it("theme.css は検査しない", () => {
      put("theme.css", ":root {\n  --color-fg: #1b1e24;\n  --space-1: 0.25rem;\n}\n");
      expect(run("theme.css").status).toBe(0);
    });
  });

  describe("token-ok", () => {
    it("同じ行の末尾に理由を書けば許可する", () => {
      const r = check("padding: 6px; /* token-ok: 外部の既定値に合わせる */");
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    });

    it("全角の区切りでも理由と認める", () => {
      expect(check("padding: 6px; /* token-ok：外部の既定値に合わせる */").status).toBe(0);
    });

    it("複数行の宣言は、終わりの行のコメントで許可する", () => {
      const r = check("width: calc(\n    100% - 2px\n  ); /* token-ok: 枠線の 2 本分 */");
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    });

    it("1 つの宣言の複数の直書きをまとめて許可する", () => {
      expect(check("padding-inline: 6px 2px; /* token-ok: 既定値に合わせる */").status).toBe(0);
    });

    it("許可は別の宣言に及ばない", () => {
      const r = check("padding: 6px; /* token-ok: 理由 */\nmargin: 4px;");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("a.css:3: 4px");
      expect(r.stderr).not.toContain("a.css:2");
    });

    it("理由が無ければ失敗にする", () => {
      const r = check("padding: 6px; /* token-ok */");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("a.css:2: token-ok に理由がない");
    });

    it("区切りだけで理由が空でも失敗にする", () => {
      const r = check("padding: 6px; /* token-ok:   */");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("token-ok に理由がない");
    });

    it("理由が無いときは直書きの許可にならない", () => {
      const r = check("padding: 6px; /* token-ok */");
      expect(r.stderr).toContain("理由がない");
    });

    it("何も許可していない token-ok は失敗にする", () => {
      const r = check("padding: var(--space-1); /* token-ok: 直したあとに残った */");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("a.css:2: token-ok が何も許可していない");
    });

    it("token-ok で始まらないコメントは許可にしない", () => {
      expect(check("padding: 6px; /* token-ok-ish: 理由 */").status).toBe(1);
      expect(check("padding: 6px; /* 例: token-ok: 理由 */").status).toBe(1);
    });
  });

  describe("対象の集め方", () => {
    it("ディレクトリは再帰して *.css だけを見る", () => {
      put("src/sub/deep.css", ".a {\n  padding: 4px;\n}\n");
      put("src/sub/note.txt", "padding: 4px;\n");
      put("src/theme.css", ":root {\n  --space-1: 4px;\n}\n");
      const r = run("src");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`${join("src", "sub", "deep.css")}:2: 4px`);
      expect(r.stderr).toContain("1 件");
    });

    it("複数のファイルの違反を合算する", () => {
      put("a.css", ".a {\n  padding: 4px;\n}\n");
      put("b.css", ".b {\n  color: #fff;\n}\n");
      const r = run("a.css", "b.css");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("2 件");
    });

    it("引数なしでは repo の apps/web/src と apps/worker/src を検査し、今のコードは通る", () => {
      const r = spawnSync("node", [script], { cwd: dir, encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    });
  });
});
