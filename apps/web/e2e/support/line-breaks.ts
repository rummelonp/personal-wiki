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
 * widths を渡すと、locator の要素の style.width をその順に変えながら測る。幅を振る測定を 1 回の evaluate にまとめるため。
 * 幅ごとに evaluate を往復すると、並列の E2E で負荷が高いとき、往復の遅れが幅の数だけ積もってテストの時間切れになる。
 * null は幅を変えずに測る。
 * parts を渡すと、幅を変える要素（locator）の中の、セレクターに当たる要素を幅ごとに測る（当たらなければ null）。
 * 渡さなければ locator の要素そのものを測る。
 */
async function measureAcrossWidths(
  locator: Locator,
  widths: readonly (number | null)[],
  parts: readonly string[] | null = null,
): Promise<{ appliedWidth: number; parts: ({ lines: Line[]; seams: Seam[] } | null)[] }[]> {
  return locator.evaluate(
    (container, { widthList, selectors }) => {
      const measureOnce = (element: Element): { lines: Line[]; seams: Seam[] } => {
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
      };
      return widthList.map((width) => {
        if (width !== null) (container as HTMLElement).style.width = `${width}px`;
        const appliedWidth = container.getBoundingClientRect().width;
        const targets =
          selectors === null
            ? [container]
            : selectors.map((selector) => container.querySelector(selector));
        return {
          appliedWidth,
          parts: targets.map((target) => (target === null ? null : measureOnce(target))),
        };
      });
    },
    { widthList: [...widths], selectors: parts === null ? null : [...parts] },
  );
}

async function measure(locator: Locator): Promise<{ lines: Line[]; seams: Seam[] }> {
  const [measured] = await measureAcrossWidths(locator, [null]);
  return measured?.parts[0] as { lines: Line[]; seams: Seam[] };
}

/** 幅を振って測った、1 つの幅での結果。 */
export interface WrapAtWidth {
  /** 実際に当たった container の幅。指定の幅に変えられたかを確かめる */
  appliedWidth: number;
  /** parts と同じ順。セレクターに当たる要素が無ければ null */
  parts: ({ lineTexts: string[]; midPhraseBreaks: string[] } | null)[];
}

/**
 * container の幅を振り、その中の parts の要素ごとに、描画された行の文字列と、語の途中の折り返しを返す。
 * 通知のように、測る要素（見出しと本文）とは別の要素（通知の枠）の幅を変えるときに使う。幅は 1 回の evaluate で振る。
 */
export async function wrapAcrossWidths(
  container: Locator,
  parts: readonly string[],
  widths: readonly number[],
): Promise<WrapAtWidth[]> {
  const measured = await measureAcrossWidths(container, widths, parts);
  return measured.map(({ appliedWidth, parts: measuredParts }) => ({
    appliedWidth,
    parts: measuredParts.map((part) =>
      part === null
        ? null
        : {
            lineTexts: part.lines.map((line) => line.text),
            midPhraseBreaks: midPhraseBreaksOf(part.lines),
          },
    ),
  }));
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

function splitNumbersOf(lines: readonly Line[]): string[] {
  const splits: string[] = [];
  for (let index = 1; index < lines.length; index++) {
    const before = (lines[index - 1] as Line).text.slice(-1);
    const after = (lines[index] as Line).text.slice(0, 1);
    const unitAfterNumber = /\d/.test(before) && !/[\d,.:/]/.test(after);
    if (unitAfterNumber || (before === "約" && /\d/.test(after))) splits.push(`${before}|${after}`);
  }
  return splits;
}

function midPhraseBreaksOf(lines: readonly Line[]): string[] {
  const breaks: string[] = [];
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index] as Line;
    if (line.boundary === null || isPhraseBoundary(line.boundary)) continue;
    breaks.push(`${(lines[index - 1] as Line).text.slice(-1)}|${line.text.slice(0, 1)}`);
  }
  return breaks;
}

/**
 * 要素の本文の折り返しのうち、数とそれに続く単位（「3|文字」）や、「約」と数（「約|3」）を別の行に分けたものを
 * 「前の行の末尾の文字|次の行の先頭の文字」で返す。数の中の区切り（「65,|536」「19:|09」「1/|3」）と、
 * 日付と時刻の間の空白での折り返しは数どうしなので返さない。
 */
export async function splitNumbers(locator: Locator): Promise<string[]> {
  return splitNumbersOf((await measure(locator)).lines);
}

/** 要素の幅を振り、splitNumbers に当たる折り返しを重複なしで集める。幅は 1 回の evaluate で振る。 */
export async function splitNumbersAcrossWidths(
  locator: Locator,
  widths: readonly number[],
): Promise<string[]> {
  const measured = await measureAcrossWidths(locator, widths);
  return [
    ...new Set(
      measured.flatMap(({ parts }) => parts.flatMap((part) => splitNumbersOf(part?.lines ?? []))),
    ),
  ];
}

/**
 * 要素の本文の折り返しのうち、句読点、空白、正しい位置の <wbr> でないものを「前の行の末尾の文字|次の行の先頭の文字」で返す。
 * 語の途中で切れていれば空でなくなる。閉じ括弧の直後は、助詞が続くときも文節の途中として返す。
 */
export async function midPhraseBreaks(locator: Locator): Promise<string[]> {
  return midPhraseBreaksOf((await measure(locator)).lines);
}

/** 要素の幅を振り、midPhraseBreaks に当たる折り返しを重複なしで集める。幅は 1 回の evaluate で振る。 */
export async function midPhraseBreaksAcrossWidths(
  locator: Locator,
  widths: readonly number[],
): Promise<string[]> {
  const measured = await measureAcrossWidths(locator, widths);
  return [
    ...new Set(
      measured.flatMap(({ parts }) =>
        parts.flatMap((part) => midPhraseBreaksOf(part?.lines ?? [])),
      ),
    ),
  ];
}

/**
 * 要素の中の <wbr> のうち、文節の切れ目として正しくない位置にあるものを「前の文節の末尾|次の文節の先頭」で返す。
 * 折り返しに現れない位置も調べる（幅が変わると、その位置で折り返す）。
 */
export async function misplacedWbrs(locator: Locator): Promise<string[]> {
  return misplacedWbrsOf((await measure(locator)).seams);
}

function misplacedWbrsOf(seams: readonly Seam[]): string[] {
  return seams
    .filter((seam) => seamProblem(seam) !== null)
    .map((seam) => `${seam.before.slice(-3)}|${seam.after.slice(0, 3)}`);
}

/** measureWrap の結果。各項目は、同名の関数が返す値と同じ。 */
export interface WrapSummary {
  lineTexts: string[];
  midPhraseBreaks: string[];
  seamCount: number;
  misplacedWbrs: string[];
}

/**
 * lineTexts、midPhraseBreaks、<wbr> の数、misplacedWbrs を 1 回の evaluate で測る。
 * 画面の幅を実際に振るテストは幅ごとに測るので、項目ごとに evaluate を呼ぶと、負荷の高い runner で
 * 往復の遅れが幅の数と項目の数の積だけ積もる。
 */
export async function measureWrap(locator: Locator): Promise<WrapSummary> {
  const { lines, seams } = await measure(locator);
  return {
    lineTexts: lines.map((line) => line.text),
    midPhraseBreaks: midPhraseBreaksOf(lines),
    seamCount: seams.length,
    misplacedWbrs: misplacedWbrsOf(seams),
  };
}
