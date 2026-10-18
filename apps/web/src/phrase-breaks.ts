/*
 * word-break: auto-phrase を解釈しない描画（iPhone の WebKit）で、日本語の文を文節の切れ目で折り返すための分割。
 * 文節の切れ目に <wbr> を置き、文節の中は word-break: keep-all で切らせない。
 *
 * Intl.Segmenter の word は形態素の粒度（「でき|ま|せん|で|した」「し|ゃ|べり」）なので、そのままでは使えない。
 * 切るのは、内容語の後ろに助詞だけが続き、次が平仮名以外で始まる位置に限る（「画面を|読み込めませんでした」）。
 * 次が平仮名で始まるときは、活用語尾や補助動詞（「分から|ない」「読も|う」）の可能性があるので切らない。
 * 活用語尾や複合動詞（「読み|込め」）の中は、平仮名や漢字の並びだけでは見分けられないので切らない。
 * 文法を解析しないので、auto-phrase より粗くなる。粗い側に倒す理由は、細かく切ると語の途中で折り返すためである。
 */

/**
 * 助詞の 1 語。文節はこれで閉じる。動詞の活用語尾と同じ形の語は入れない（「か」は「届か|ない」、「から」は「分から|ない」の語尾に当たる）。
 */
const PARTICLES = new Set([
  "が",
  "を",
  "に",
  "は",
  "も",
  "の",
  "へ",
  "と",
  "で",
  "や",
  "まで",
  "でも",
  "には",
  "では",
  "とは",
  "にも",
  "より",
  "など",
  "だけ",
  "しか",
]);

/** 行頭に置かない文字（line-break: strict の対象）。<wbr> の直後に置くと禁則を破るので、文節の先頭にしない。 */
const LINE_HEAD_PROHIBITED = /^[ゃゅょっぁぃぅぇぉゎャュョッァィゥェォヮー]/u;

// 先頭の文字だけを見る。送り仮名を持つ語（見直し、下書き）は漢字で始まる内容語として扱う
const HIRAGANA = /^\p{Script=Hiragana}/u;

/** 閉じ括弧。引用した名前（「title」）は内容語と同じに扱い、その後ろの助詞で文節を閉じる。 */
const CLOSING_BRACKET = /^[」』）】]$/u;

const startsWithHiragana = (text: string): boolean => HIRAGANA.test(text);

/** 平仮名の列が助詞だけでできているか。「までは」「だけが」のように重なった助詞も 1 つの尾とみなす。 */
function isParticleTail(tail: readonly string[]): boolean {
  return tail.length > 0 && tail.every((token) => PARTICLES.has(token));
}

/** 文字列を、文節ごとの断片に分ける。断片をつなぐと元の文字列になる。 */
export function splitPhrases(text: string, segmenter: Intl.Segmenter): string[] {
  const phrases: string[] = [];
  let current = "";
  // 現在の文節が、内容語（平仮名で始まらない語）の後に助詞だけが続く形のとき、その助詞の列
  let particles: string[] | null = null;
  let previous: { text: string; wordLike: boolean } | null = null;

  for (const { segment, isWordLike: wordLikeOrUndefined } of segmenter.segment(text)) {
    const isWordLike = wordLikeOrUndefined === true;
    // 切るのは、助詞だけの尾を持つ文節の後ろで、次が別の語になるときだけ
    const breakBefore =
      previous?.wordLike === true &&
      isWordLike &&
      !LINE_HEAD_PROHIBITED.test(segment) &&
      !startsWithHiragana(segment) &&
      particles !== null &&
      isParticleTail(particles);
    if (breakBefore) {
      phrases.push(current);
      current = "";
      particles = null;
    }
    if (!isWordLike) particles = CLOSING_BRACKET.test(segment) ? [] : null;
    else if (!startsWithHiragana(segment)) particles = [];
    else if (particles !== null) particles.push(segment);
    current += segment;
    previous = { text: segment, wordLike: isWordLike };
  }
  if (current !== "") phrases.push(current);
  return phrases;
}
