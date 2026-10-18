import type { Locator } from "@playwright/test";

/**
 * 折り返してよい位置の直前に来る句読点と全角の空白（U+3000）。改行しない空白（U+00A0）は含めない。
 * 全角の空白は、行末でも幅を返すので、幅 0 の空白を拾う skippedSpace では見つからない。
 */
const PUNCTUATION_END = `、。，．…${String.fromCodePoint(0x3000)}`;

/** 開き括弧。行末に残して中身と離すので、直後では折り返さない。 */
const OPENING_BRACKETS = "「『（【";

/** 閉じ括弧。引用した名前（「title」）のまとまりの後ろで切れるが、助詞が続くときは文節の途中なので切れない。 */
const CLOSING_BRACKETS = "」』）】";

/**
 * <wbr> の直前の文節が閉じる形。文節は助詞の 1 語か、重なった助詞で閉じる。
 * apps/web/src/phrase-breaks.ts の PARTICLES に合わせる。「け」「り」「か」は活用語尾（受け、取り、届か）と
 * 同じ形なので入れない。
 */
const PARTICLE_TAIL =
  /(?:が|を|に|は|も|の|へ|と|で|や|まで|でも|には|では|とは|にも|より|など|だけ|しか)$/u;

/** <wbr> の直後に来てよい文字は、平仮名でも行頭に置けない文字でもない。 */
const CANNOT_START_PHRASE = /^[\p{Script=Hiragana}ァィゥェォッャュョヮー、。，．」』）】]/u;

/** 文節の切れ目の前後の文字列。<wbr> を挟んだ、前の文節と次の文節 */
interface Seam {
  before: string;
  after: string;
}

interface Boundary {
  /** 前の行との間に、折り返しの対象になる空白があったか */
  space: boolean;
  /** 前の行との間の <wbr> の前後の文節。無ければ null */
  wbr: Seam | null;
  previousChar: string;
  nextChar: string;
}

interface Line {
  /** 行に載った文字。行末の空白は、描画が幅を返しても返さなくても同じ結果になるよう落とす */
  text: string;
  /** 前の行との境。最初の行は null */
  boundary: Boundary | null;
}

/** <wbr> を置いた位置が、文節の切れ目として正しくないときの理由。正しければ null。 */
function seamProblem({ before, after }: Seam): string | null {
  // 開き括弧の手前は、直前が何であっても行を替えてよい（行頭に開き括弧は置ける）
  if (OPENING_BRACKETS.includes(after.charAt(0))) return null;
  if (!PARTICLE_TAIL.test(before)) return "直前が助詞で閉じていない";
  if (CANNOT_START_PHRASE.test(after)) return "直後が平仮名か、行頭に置けない文字";
  return null;
}

/** 描画が折り返した位置が、語の途中でないか。 */
function isPhraseBoundary(boundary: Boundary): boolean {
  if (OPENING_BRACKETS.includes(boundary.previousChar)) return false;
  if (boundary.space || PUNCTUATION_END.includes(boundary.previousChar)) return true;
  if (boundary.wbr !== null) return seamProblem(boundary.wbr) === null;
  return (
    CLOSING_BRACKETS.includes(boundary.previousChar) &&
    !/^\p{Script=Hiragana}/u.test(boundary.nextChar)
  );
}

/**
 * 要素の本文を、描画が実際に選んだ折り返しで行に分け、<wbr> の前後の文節も集める。文字ごとの Range の位置で測る。
 * 同じ行かは、top の差が文字の高さの半分以内かで決める（小数の丸めや上付きの文字で揺れない）。
 */
async function measure(locator: Locator): Promise<{ lines: Line[]; seams: Seam[] }> {
  return locator.evaluate((element) => {
    const lines: Line[] = [];
    // <wbr> の前後の文節。兄弟の文字列と span（nobreak）を、隣の <wbr> まで集める
    const around = (wbr: Element, step: "previousSibling" | "nextSibling"): string => {
      let text = "";
      for (
        let sibling = wbr[step];
        sibling !== null && (sibling as Element).tagName !== "WBR";
        sibling = sibling[step]
      ) {
        text =
          step === "previousSibling"
            ? (sibling.textContent ?? "") + text
            : text + (sibling.textContent ?? "");
      }
      return text;
    };
    const wbrs = [...element.querySelectorAll("wbr")];
    const seams = wbrs.map((wbr) => ({
      before: around(wbr, "previousSibling"),
      after: around(wbr, "nextSibling"),
    }));
    let previous: { char: string; top: number; node: Text; index: number } | null = null;
    let skippedSpace = false;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (
      let node = walker.nextNode() as Text | null;
      node !== null;
      node = walker.nextNode() as Text | null
    ) {
      const data = node.data;
      for (let index = 0; index < data.length; index++) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const rect = range.getBoundingClientRect();
        const char = data[index] as string;
        if (rect.width === 0) {
          if (/\s/.test(char)) skippedSpace = true;
          continue;
        }
        if (previous === null || Math.abs(rect.top - previous.top) > rect.height / 2) {
          let boundary: Boundary | null = null;
          if (previous !== null) {
            const between = previous;
            const at = wbrs.findIndex(
              (candidate) =>
                between.node.compareDocumentPosition(candidate) &
                  Node.DOCUMENT_POSITION_FOLLOWING &&
                node.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_PRECEDING,
            );
            boundary = {
              space: skippedSpace,
              wbr: at === -1 ? null : (seams[at] as Seam),
              previousChar: previous.char,
              nextChar: char,
            };
          }
          lines.push({ text: "", boundary });
        }
        (lines[lines.length - 1] as Line).text += char;
        skippedSpace = false;
        previous = { char, top: rect.top, node, index };
      }
    }
    // 改行しない空白（U+00A0）は行末でも本文の一部なので残す
    for (const line of lines) line.text = line.text.replace(/[^\S\u00a0]+$/, "");
    return { lines, seams };
  });
}

async function layoutLines(locator: Locator): Promise<Line[]> {
  return (await measure(locator)).lines;
}

/** 要素の中の <wbr> ごとの、前後の文節。<wbr> の数と位置を調べる。 */
export async function phraseSeams(locator: Locator): Promise<Seam[]> {
  return (await measure(locator)).seams;
}

/** 要素の本文の、描画された行ごとの文字列。 */
export async function lineTexts(locator: Locator): Promise<string[]> {
  return (await layoutLines(locator)).map((line) => line.text);
}

/**
 * 要素の本文の折り返しのうち、句読点、空白、正しい位置の <wbr> でないものを「前の行の末尾の文字|次の行の先頭の文字」で返す。
 * 語の途中で切れていれば空でなくなる。閉じ括弧の直後は、助詞が続くときも文節の途中として返す。
 */
export async function midPhraseBreaks(locator: Locator): Promise<string[]> {
  const lines = await layoutLines(locator);
  const breaks: string[] = [];
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index] as Line;
    if (line.boundary === null || isPhraseBoundary(line.boundary)) continue;
    breaks.push(`${(lines[index - 1] as Line).text.slice(-1)}|${line.text.slice(0, 1)}`);
  }
  return breaks;
}

/**
 * 要素の中の <wbr> のうち、文節の切れ目として正しくない位置にあるものを「前の文節の末尾|次の文節の先頭」で返す。
 * 折り返しに現れない位置も調べる（幅が変わると、その位置で折り返す）。
 */
export async function misplacedWbrs(locator: Locator): Promise<string[]> {
  const { seams } = await measure(locator);
  return seams
    .filter((seam) => seamProblem(seam) !== null)
    .map((seam) => `${seam.before.slice(-3)}|${seam.after.slice(0, 3)}`);
}
