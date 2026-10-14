import { describe, expect, it } from "vitest";
import { frontmatterEnd } from "./frontmatter";
import { parseFrontmatterFields } from "./frontmatter-fields";

const block = (...lines: string[]) => ["---", ...lines, "---"].join("\n");

describe("parseFrontmatterFields", () => {
  it("flow list を読む", () => {
    expect(parseFrontmatterFields(block("tags: [a, b]", "aliases: [別名]"))).toEqual({
      tags: ["a", "b"],
      aliases: ["別名"],
      otherKeys: [],
    });
  });

  it("block list を読む", () => {
    const fields = parseFrontmatterFields(
      block("tags:", "  - a", "  - b", "aliases:", "- 別名", "title: X"),
    );
    expect(fields).toEqual({ tags: ["a", "b"], aliases: ["別名"], otherKeys: ["title"] });
  });

  it("scalar を読み、`,` で分けない", () => {
    expect(parseFrontmatterFields(block("tags: a, b")).tags).toEqual(["a, b"]);
  });

  it("quoted を読み、中の空白を残す", () => {
    const fields = parseFrontmatterFields(block(`tags: ["a b", 'c']`, `aliases: " 別 名 "`));
    expect(fields.tags).toEqual(["a b", "c"]);
    expect(fields.aliases).toEqual([" 別 名 "]);
  });

  it("YAML の null は値として返さず、quote されていれば文字列として返す", () => {
    const fields = parseFrontmatterFields(
      block("tags: [~, null, Null, NULL, NuLl, '~']", "aliases:", "  - ~", "  - 別名"),
    );
    expect(fields.tags).toEqual(["NuLl", "~"]);
    expect(fields.aliases).toEqual(["別名"]);
    expect(parseFrontmatterFields(block("tags: ~")).tags).toEqual([]);
  });

  it("単数形の `tag`・`alias` と大文字小文字の違いも同じキーとして読む", () => {
    const fields = parseFrontmatterFields(block("Tag: a", "ALIAS: 別名"));
    expect(fields).toEqual({ tags: ["a"], aliases: ["別名"], otherKeys: [] });
  });

  it("同じキーが複数回あれば値をつなぎ、重複と空を落とす", () => {
    const fields = parseFrontmatterFields(block("tags: [a, , a, b]", "tag: [b, c]"));
    expect(fields.tags).toEqual(["a", "b", "c"]);
  });

  it("入れ子・anchor・複数行スカラは空として扱い、キー名だけを数える", () => {
    const fields = parseFrontmatterFields(
      block("tags:", "  nested: a", "aliases: &anchor", "note: |", "  複数行", "  スカラ"),
    );
    expect(fields.tags).toEqual([]);
    expect(fields.aliases).toEqual([]);
    expect(fields.otherKeys).toEqual(["note"]);
  });

  it("他のキーの block list の項目をキーとして数えない", () => {
    expect(parseFrontmatterFields(block("cssclasses:", "  - wide")).otherKeys).toEqual([
      "cssclasses",
    ]);
  });

  it("空白の揺れと行頭のコメント、CRLF を許す", () => {
    const text = ["---", "# コメント", "tags  :   [ a ,b ]", "", "  - 無関係", "---"].join("\r\n");
    expect(parseFrontmatterFields(text)).toEqual({
      tags: ["a", "b"],
      aliases: [],
      otherKeys: [],
    });
  });

  it("`:` の後ろに空白の無い行はキーとして読まない", () => {
    expect(parseFrontmatterFields(block("tags:[a]"))).toEqual({
      tags: [],
      aliases: [],
      otherKeys: [],
    });
  });

  it("閉じ `---` より後ろは読まない", () => {
    const fields = parseFrontmatterFields(`${block("tags: [a]")}\ntags: [b]\n`);
    expect(fields.tags).toEqual(["a"]);
  });

  it("区切り行の無い中身だけでも読む", () => {
    expect(parseFrontmatterFields("tags: [a]").tags).toEqual(["a"]);
  });

  it("frontmatterEnd で切り出した範囲をそのまま渡せる", () => {
    const body = `${block("tags: [a]")}\n\n本文 #b`;
    const end = frontmatterEnd(body);
    expect(end).not.toBeNull();
    expect(parseFrontmatterFields(body.slice(0, end ?? 0)).tags).toEqual(["a"]);
  });

  it("壊れた YAML でも throw しない", () => {
    const broken = ["---", "tags: [a, b", "aliases: ]]", ": 値だけ", "- 項目だけ", "\t: \t"];
    expect(() => parseFrontmatterFields(broken.join("\n"))).not.toThrow();
    expect(parseFrontmatterFields(broken.join("\n")).tags).toEqual(["a", "b"]);
  });

  it("空白の長い行でも線形の時間で返す", () => {
    // 正規表現が二次だとここで固まる（`KEY_LINE` のコメント）。畳んでいる間は選択が動くたびに
    // 呼ばれるので、1 回の parse が 1 frame に収まる必要がある。
    const spaces = " ".repeat(100_000);
    // `.` が跨げない文字。値を `.` で取ると、この文字の手前で `$` が失敗して backtrack する
    const lineSeparator = String.fromCodePoint(0x2028);
    const text = block(
      // `tags:` の下の 2 行は block list なので `BLOCK_ITEM` を通る。1 つ目は末尾を空白以外で
      // 終わらせて「末尾の空白を貪欲に取って終わり」の近道を塞ぎ、2 つ目は `$` を失敗させる
      "tags:",
      `- x${spaces}y`,
      `- ${spaces}${lineSeparator}`,
      // 以下は `KEY_LINE` を通る。`:` の直後から空白が続く形でないと `$` の失敗が繰り返されない
      `aliases: ${spaces}${lineSeparator}`,
      `a${spaces}`,
    );
    const started = Date.now();
    const fields = parseFrontmatterFields(text);
    // 二次なら 10 万文字で数十秒かかるので、1 秒でも区別できる。100ms では並行して負荷が高いときに揺れた
    expect(Date.now() - started).toBeLessThan(1000);

    // 空白と U+2028 だけの値は `trimEnd` で空になって落ちる
    expect(fields.tags).toEqual([`x${spaces}y`]);
    expect(fields.aliases).toEqual([]);
    expect(fields.otherKeys).toEqual([]);
  });

  it("空の frontmatter は何も返さない", () => {
    expect(parseFrontmatterFields(block())).toEqual({ tags: [], aliases: [], otherKeys: [] });
    expect(parseFrontmatterFields("")).toEqual({ tags: [], aliases: [], otherKeys: [] });
  });
});
