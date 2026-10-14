// 部品の CSS が、見た目の値を theme.css の token を通さずに直書きしていないか検査する。
//   引数なし:     apps/web/src 以下の *.css（theme.css を除く）
//   ファイル/dir: 指定したものだけ（dir は再帰して *.css を集める。theme.css は常に除く）
// 見つかれば `file:行: 値 (種類)` を出力して終了コード 1 で終わる。
//
// 拾うもの: 色（hex、rgb() など。var() を含まない関数、色名）、長さ（px、rem、em、vh など。0 は除く）、
//   font-family、box-shadow、z-index。% と fr は相対値なので拾わない。
//   @media などの at-rule の条件（media query の幅には var() を使えない）と、セレクタは見ない。
// 宣言の途中か同じ行の末尾に `/* token-ok: 理由 */` があれば、その宣言は許可する。
//   理由が空なら失敗にする。何も許可していない token-ok も失敗にする（直したあとに残るため）。
//
// 拾わないもの（見逃しを承知で外している）: url() と文字列の中身、時間（s、ms）、unitless の数値
//   （line-height、font-weight、opacity）、packages/editor の CSS-in-JS、filter の drop-shadow() の色名、
//   font 一括指定の引用符も generic family も無い書体名。
// token-ok の許可は行単位なので、同じ行に並べた別の宣言にも及ぶ（biome の整形では 1 行に並ばない）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TARGET = join(ROOT, "apps/web/src");
const THEME_FILE = "theme.css";

const LENGTH_UNITS =
  "px|rem|em|ex|ch|cap|ic|lh|rlh|rex|rch|rcap|ric|vh|vw|vi|vb|vmin|vmax|svh|svw|svi|svb|svmin|svmax|lvh|lvw|lvi|lvb|lvmin|lvmax|dvh|dvw|dvi|dvb|dvmin|dvmax|cqw|cqh|cqi|cqb|cqmin|cqmax|cm|mm|q|in|pt|pc";
const LENGTH = new RegExp(
  `(?<![\\w.#-])[+-]?(\\d+\\.?\\d*|\\.\\d+)(${LENGTH_UNITS})(?![\\w%-])`,
  "gi",
);
const HEX = /#[0-9a-fA-F]{3,8}(?![\w-])/g;
const COLOR_FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;
const CSS_WIDE = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);

// transparent と currentcolor は含めない（token で表す値ではない）
const NAMED_COLORS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown " +
    "burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan " +
    "darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid " +
    "darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
    "deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro " +
    "ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow " +
    "lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine " +
    "mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise " +
    "mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab " +
    "orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru " +
    "pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
    "seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan " +
    "teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen"
  ).split(" "),
);

// 色名を値に取りうる property。font-family などの語（Menlo など）を色名と取り違えないために絞る
const COLOR_PROPERTY =
  /^(--.*|.*-?color|background(-.*)?|border(-.*)?|outline(-.*)?|box-shadow|text-shadow|text-decoration(-.*)?|fill|stroke|column-rule(-.*)?)$/;

const GENERIC_FAMILY =
  /(?<![\w-])(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|math|emoji|fangsong)(?![\w-])/;

/**
 * コメントと文字列と url() の中身を同じ長さの空白に置き換える。
 * 以降の検査は、置換後の文字列の位置がそのまま元の行になる。
 * @param {string} css
 * @returns {{ masked: string, comments: { start: number, end: number, body: string }[] }}
 */
function mask(css) {
  const out = css.split("");
  /** @type {{ start: number, end: number, body: string }[]} */
  const comments = [];
  const blank = (/** @type {number} */ from, /** @type {number} */ to) => {
    for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") {
      const close = css.indexOf("*/", i + 2);
      const end = close === -1 ? css.length : close + 2;
      comments.push({ start: i, end, body: css.slice(i + 2, close === -1 ? end : close) });
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c && css[j] !== "\n") j += css[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else if (css.startsWith("url(", i) && /^url\(\s*[^'"\s]/.test(css.slice(i, i + 20))) {
      const close = css.indexOf(")", i);
      const end = close === -1 ? css.length : close;
      blank(i + 4, end);
      i = end + 1;
    } else {
      i++;
    }
  }
  return { masked: out.join(""), comments };
}

/**
 * `{`、`;`、`}` で文に分ける。`{` で終わる文は規則の前置（セレクタや at-rule）で、検査しない。
 * @param {string} masked
 * @returns {{ start: number, end: number }[]}
 */
function declarations(masked) {
  /** @type {{ start: number, end: number }[]} */
  const result = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === "{" || c === ";" || c === "}")) {
      if (c !== "{") result.push({ start: from, end: i });
      from = i + 1;
    }
  }
  return result;
}

/**
 * 開き括弧の位置から対応する閉じ括弧の直後までを返す。
 * @param {string} text
 * @param {number} open
 */
function balancedEnd(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i + 1;
  }
  return text.length;
}

/**
 * 括弧の呼び出し（var(...) など）を、同じ長さの空白に置き換える。
 * @param {string} text
 * @param {string} name
 */
function blankCalls(text, name) {
  let out = text;
  const re = new RegExp(`(?<![\\w-])${name}\\(`, "gi");
  for (let m = re.exec(out); m; m = re.exec(out)) {
    const end = balancedEnd(out, m.index + m[0].length - 1);
    out = out.slice(0, m.index) + " ".repeat(end - m.index) + out.slice(end);
    re.lastIndex = end;
  }
  return out;
}

/**
 * 1 つの宣言の値から、直書きを探す。
 * @param {string} property
 * @param {string} value 文字列と url() の中身は空白にしてある
 * @returns {{ offset: number, length: number, kind: string }[]}
 */
function findHardcoded(property, value) {
  /** @type {{ offset: number, length: number, kind: string }[]} */
  const found = [];
  // 変数名（--color-red など）は検査の対象でない。fallback の値は残して検査する
  // !important は値の一部ではないので外す（var() だけの値を直書きと見なさないため）
  const plain = value
    .replace(/--[\w-]+/g, (m) => " ".repeat(m.length))
    .replace(/!\s*important\s*$/i, (m) => " ".repeat(m.length));

  for (const m of plain.matchAll(HEX))
    found.push({ offset: m.index, length: m[0].length, kind: "色" });

  for (const m of plain.matchAll(COLOR_FUNCTION)) {
    const open = m.index + m[0].length - 1;
    const call = plain.slice(m.index, balancedEnd(plain, open));
    // rgb(var(--x) / 50%) や相対色（from var(--x)）は token から作る値なので許す
    if (!/(?<![\w-])var\(/i.test(value.slice(m.index, m.index + call.length))) {
      found.push({ offset: m.index, length: call.length, kind: "色" });
    }
  }

  if (COLOR_PROPERTY.test(property)) {
    for (const m of plain.matchAll(/(?<![\w-])[a-z]+(?![\w(-])/gi)) {
      if (NAMED_COLORS.has(m[0].toLowerCase())) {
        found.push({ offset: m.index, length: m[0].length, kind: "色名" });
      }
    }
  }

  for (const m of plain.matchAll(LENGTH)) {
    if (Number.parseFloat(m[1] ?? "0") === 0) continue;
    found.push({ offset: m.index, length: m[0].length, kind: "長さ" });
  }

  const lead = value.length - value.trimStart().length;
  const whole = plain.trim().toLowerCase();
  const words = (/** @type {string} */ text) => text.replace(/[\s,]+/g, " ").trim();
  if (property === "font-family") {
    const rest = words(blankCalls(plain, "var"));
    if (rest !== "" && !CSS_WIDE.has(rest.toLowerCase())) {
      found.push({ offset: lead, length: value.trim().length, kind: "font-family" });
    }
  } else if (property === "font") {
    if (/["']/.test(value) || GENERIC_FAMILY.test(plain)) {
      found.push({ offset: lead, length: value.trim().length, kind: "font-family" });
    }
  } else if (property === "box-shadow" || property === "text-shadow") {
    if (whole !== "none" && !CSS_WIDE.has(whole) && !/(?<![\w-])var\(/i.test(value)) {
      found.push({ offset: lead, length: value.trim().length, kind: property });
    }
  } else if (property === "z-index") {
    if (whole !== "auto" && !CSS_WIDE.has(whole) && !/(?<![\w-])var\(/i.test(value)) {
      found.push({ offset: lead, length: value.trim().length, kind: "z-index" });
    }
  }
  return found;
}

/**
 * @param {string} css
 * @returns {{ line: number, message: string }[]}
 */
function checkCss(css) {
  const { masked, comments } = mask(css);
  const lineStarts = [0];
  for (let i = 0; i < css.length; i++) if (css[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (/** @type {number} */ pos) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  /** @type {{ line: number, message: string }[]} */
  const problems = [];
  /** @type {{ from: number, to: number, used: boolean }[]} */
  const allowances = [];
  for (const c of comments) {
    const m = /^\s*token-ok\b\s*(?:[:：]\s*([\s\S]*?))?\s*$/.exec(c.body);
    if (!m) continue;
    const from = lineOf(c.start);
    const to = lineOf(c.end - 1);
    if (!m[1]?.trim()) {
      problems.push({ line: from, message: "token-ok に理由がない (/* token-ok: 理由 */ と書く)" });
      continue;
    }
    allowances.push({ from, to, used: false });
  }

  for (const d of declarations(masked)) {
    const raw = masked.slice(d.start, d.end);
    const colon = raw.indexOf(":");
    if (colon === -1 || raw.trimStart().startsWith("@")) continue;
    const property = raw.slice(0, colon).trim().toLowerCase();
    const valueStart = d.start + colon + 1;
    const value = raw.slice(colon + 1);
    const hits = findHardcoded(property, value);
    if (hits.length === 0) continue;

    const first = lineOf(d.start + raw.length - raw.trimStart().length);
    // d.end は終端（; か }）の位置。同じ行の末尾に付けたコメントも、この宣言のものとして扱う
    const last = lineOf(d.end);
    const allowed = allowances.filter((a) => a.from <= last && a.to >= first);
    if (allowed.length > 0) {
      for (const a of allowed) a.used = true;
      continue;
    }
    for (const h of hits) {
      const at = valueStart + h.offset;
      const text = css.slice(at, at + h.length).replace(/\s+/g, " ");
      problems.push({ line: lineOf(at), message: `${text} (${h.kind})` });
    }
  }

  for (const a of allowances) {
    if (!a.used)
      problems.push({ line: a.from, message: "token-ok が何も許可していない (不要なら消す)" });
  }
  return problems.sort((x, y) => x.line - y.line);
}

/** @param {string} path */
function collect(path) {
  if (!statSync(path).isDirectory()) return basename(path) === THEME_FILE ? [] : [path];
  return readdirSync(path, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".css") && basename(f) !== THEME_FILE)
    .map((f) => join(path, f))
    .sort();
}

const args = process.argv.slice(2);
const files = (args.length === 0 ? [DEFAULT_TARGET] : args.map((a) => resolve(a))).flatMap(collect);

let total = 0;
for (const file of files) {
  for (const p of checkCss(readFileSync(file, "utf8"))) {
    if (total === 0) console.error("theme.css の token を通さずに直書きした値があります");
    console.error(`  ${relative(process.cwd(), file)}:${p.line}: ${p.message}`);
    total++;
  }
}
if (total > 0) {
  console.error(`${total} 件。token に置き換えるか、理由を書いて /* token-ok: 理由 */ で許可する`);
  process.exit(1);
}
