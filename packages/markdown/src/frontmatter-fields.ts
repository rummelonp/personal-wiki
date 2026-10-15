export interface FrontmatterFields {
  /**
   * `tags` / `tag` の値。書かれたままで、tag 名として読めるかの判定は呼び出し側の責務
   * （`frontmatterTagName`）。YAML の null だけはここで落ちる（`parseFrontmatterFields` 参照）
   */
  readonly tags: string[];
  /** `aliases` / `alias` の値。同じく書かれたまま */
  readonly aliases: string[];
  /** 上の 2 つ以外のトップレベルのキー名。重複は除く。畳んだ枠が「ほか N 項目」を出すのに使う */
  readonly otherKeys: string[];
}

const DELIMITER = "---";

/**
 * トップレベルの `key: value`。
 *
 * 行頭に空白があるものは入れ子なので対象外。`:` の後ろは行末か空白 1 つ以上で、
 * `tags:foo` は YAML でも mapping にならないので key として読まない。
 *
 * この parser は畳んでいる間、選択が動くたびに呼ばれ、派生データの抽出（`extractDerived`）からも呼ぶので、
 * 1 行あたり線形でなければならない。backtrack が二次になる書き方を 2 つ避けている。
 *
 * - 末尾の空白は正規表現で落とさず `trimEnd` に任せる。`([^:]*?)[ \t]*:` のように lazy な繰り返しと
 *   trim の繰り返しを重ねると、同じ空白を取り合って `:` の無い長い空白行で秒単位になる。
 * - 値は `.` でなく `[\s\S]` で取る。`.` は U+2028、U+2029 を跨げないため、それを含む行では
 *   `(.*)$` の `$` が失敗し、`[ \t]+` と `.*` の境目で backtrack する。
 */
const KEY_LINE = /^([^\s#][^:]*):(?:[ \t]+([\s\S]*))?$/;

/** block list の項目（`- a`、値の無い `-`）。末尾の空白と `[\s\S]` の理由は `KEY_LINE` と同じ */
const BLOCK_ITEM = /^[ \t]*-(?:[ \t]+([\s\S]*))?$/;

/** 値として読まない先頭文字。複数行スカラ（`|`、`>`）、anchor、alias、tag（`!!str`）。 */
const UNSUPPORTED_VALUE = /^[|>&*!]/;

const FIELDS: Record<string, "tags" | "aliases"> = {
  tags: "tags",
  tag: "tags",
  aliases: "aliases",
  alias: "aliases",
};

function unquote(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    // escape は解かない。`"a\"b"` のような書き方は外側だけを剥がして中身をそのまま返す
    return value.slice(1, -1);
  }
  return value;
}

/** YAML 1.2 の null（`~`、`null`、`Null`、`NULL`）。`NuLl` のような他の綴りは文字列 */
const NULL_SCALAR = /^(?:~|null|Null|NULL)$/;

/**
 * 1 つのスカラを値にする。YAML の null は「値が無い」ので `null` を返し、呼び出し側が落とす。
 *
 * quote を剥がした後では `~` と `"~"` を見分けられないので、null の判定はここでしかできない。
 * tag 名、title として読めるかどうかの判定は、剥がした後の文字列に対して呼び出し側が行う。
 */
function scalarValue(raw: string): string | null {
  return NULL_SCALAR.test(raw) ? null : unquote(raw);
}

/**
 * 1 行に書かれた値を項目に分ける。
 *
 * flow list（`[a, b]`）は `,` で分け、それ以外は 1 つのスカラとして扱う。
 * `tags: a, b` は YAML では 1 つの文字列であり、Obsidian も list として書くことを求めている
 * ので、ここでも分けずに 1 値として返す。
 */
function parseInlineValue(value: string): (string | null)[] {
  if (!value.startsWith("[")) return [scalarValue(value)];
  const close = value.lastIndexOf("]");
  const inner = close > 0 ? value.slice(1, close) : value.slice(1);
  // quote の中の `,` は分けてしまう。2 キーのための subset なので、この精度で足りる
  return inner.split(",").map((item) => scalarValue(item.trim()));
}

/**
 * frontmatter の `tags` と `aliases` だけを読む YAML の subset parser。
 *
 * `text` は `frontmatterEnd` で切り出した block（前後の `---` 行を含む）でも、その中身だけでもよい。
 * `---` の行は読み飛ばし、2 つ目の `---` で読み終える。
 *
 * `yaml` package を使わないのは、この 2 キーのために parser 一式を bundle へ載せないためである
 * （editor は browser で動く）。代わりに扱う範囲を次に限る。
 *
 * - 読むのはトップレベルの `tags`／`tag`／`aliases`／`alias` だけ。キー名の大文字小文字は区別しない。
 * - 値は flow list（`[a, b]`）、block list（`- a`）、scalar（`a`）、quoted（`"a"`、`'a'`）。
 * - 入れ子、anchor／alias、複数行スカラは読まず、空として扱う。
 * - flow list の `,` は quote の中でも分ける（`['山田, 太郎']` は 2 項目。既知の制限）。
 * - YAML の null（`~`、`null`、`Null`、`NULL`）は値として返さない。quote されていれば文字列。
 * - 行頭の `#` の行は読み飛ばす。行末の `#` はコメントとして扱わない（tag の `#` と紛れるため）。
 * - 同じキーが複数回書かれていれば値をつなぎ、重複は先に現れたほうを残す。
 *
 * 不正な YAML でも throw せず、読めた範囲だけを返す。
 */
export function parseFrontmatterFields(text: string): FrontmatterFields {
  const tags: string[] = [];
  const aliases: string[] = [];
  const otherKeys: string[] = [];
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));

  const add = (into: string[], values: readonly (string | null)[]): void => {
    for (const value of values) {
      if (value !== null && value !== "" && !into.includes(value)) into.push(value);
    }
  };

  let index = 0;
  if (lines[index]?.trim() === DELIMITER) index += 1;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    index += 1;
    if (line.trim() === DELIMITER) break;

    const match = KEY_LINE.exec(line);
    if (!match) continue;
    const key = (match[1] ?? "").trimEnd();
    const field = FIELDS[key.toLowerCase()];
    if (!field && !otherKeys.includes(key)) otherKeys.push(key);

    const value = (match[2] ?? "").trimEnd();
    if (value !== "") {
      if (field && !UNSUPPORTED_VALUE.test(value))
        add(field === "tags" ? tags : aliases, parseInlineValue(value));
      continue;
    }

    // 値が無いキーの後ろには block list が続きうる。項目でない行に当たったら、その行は
    // 次のキーとして読み直すのでここでは消費しない。
    const items: (string | null)[] = [];
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (next.trim() === "" || next.trimStart().startsWith("#")) {
        index += 1;
        continue;
      }
      const item = BLOCK_ITEM.exec(next);
      if (!item) break;
      index += 1;
      items.push(scalarValue((item[1] ?? "").trimEnd()));
    }
    if (field) add(field === "tags" ? tags : aliases, items);
  }

  return { tags, aliases, otherKeys };
}
