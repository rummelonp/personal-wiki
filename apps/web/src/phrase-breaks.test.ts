import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitPhrases } from "./phrase-breaks";

const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
const split = (text: string): string[] => splitPhrases(text, segmenter);
const LINE_HEAD_PROHIBITED = /^[ゃゅょっぁぃぅぇぉゎャュョッァィゥェォヮー]/u;

// 語の途中の切れ目。複合動詞（読み|込む）と、活用語尾が助詞と同じ形の語（届か|ない）
const MID_WORD_SEAM = /(?:読み|書き|呼び|作り|見|取り|引き|切り)\|[込出直換替]|[届書開動分]か\|/u;

describe("splitPhrases", () => {
  it("内容語とそれに続く平仮名を 1 つの文節にまとめる", () => {
    expect(split("ショートカットのキャンセルができませんでした")).toEqual([
      "ショートカットの",
      "キャンセルができませんでした",
    ]);
    expect(split("画像を添付できませんでした")).toEqual(["画像を", "添付できませんでした"]);
  });

  it("重なった助詞は 1 つの尾として、後ろの語との間だけで切る", () => {
    expect(split("別の場所でも更新されています")).toEqual(["別の", "場所でも", "更新されています"]);
  });

  it("「しゃべり」のように小さい仮名で始まる断片を、前の文節から離さない", () => {
    const phrases = split("にっこりしゃべりながら");
    expect(phrases.join("")).toBe("にっこりしゃべりながら");
    for (const phrase of phrases) expect(phrase).not.toMatch(LINE_HEAD_PROHIBITED);
    // 助詞の直後に、単独の語として長音が来る形（Intl.Segmenter が「ー」を切り出す）
    expect(split("データをーを読む")).toEqual(["データをーを", "読む"]);
  });

  it("接頭辞「お」「ご」を語から離さない", () => {
    expect(split("お試しください")).toEqual(["お試しください"]);
    for (const phrase of split("ご覧になるにはお手数ですがログインしてください")) {
      expect(phrase).not.toMatch(/^[覧手]/u);
    }
  });

  it("句読点と空白の前後では切らない（その位置の折り返しは描画に任せる）", () => {
    expect(split("Cloudflare Workers の設定を変更しました")).toEqual([
      "Cloudflare Workers の設定を",
      "変更しました",
    ]);
    expect(split("通信が戻ってから、もう一度お試しください。")).toEqual([
      "通信が",
      "戻ってから、もう一度お試しください。",
    ]);
  });

  it("閉じ括弧は内容語の終わりとして、直後の助詞までを 1 つの文節にする", () => {
    expect(split("「公開設定」のページを保存できませんでした")).toEqual([
      "「公開設定」の",
      "ページを",
      "保存できませんでした",
    ]);
    expect(split("（仮）のページ")).toEqual(["（仮）の", "ページ"]);
    // 助詞が続かない閉じ括弧の後ろは、描画が括弧の後ろで折り返せるので切れ目を足さない
    expect(split("「A」ページ")).toEqual(["「A」ページ"]);
  });

  it("複合動詞の中を切らない", () => {
    for (const text of [
      "書き込めませんでした",
      "呼び出せませんでした",
      "作り直せます",
      "ログインし直す",
      "書き換わりました",
    ]) {
      expect(split(text)).toEqual([text]);
    }
    expect(split("画面を読み込めませんでした")).toEqual(["画面を", "読み込めませんでした"]);
  });

  it("活用語尾が助詞と同じ形の語（届か|ない）の中を切らない", () => {
    for (const text of [
      "届かない",
      "書かれていません",
      "開かれています",
      "動かなくなりました",
      "分からなかった",
    ]) {
      expect(split(text)).toEqual([text]);
    }
    expect(split("ページが開かれています")).toEqual(["ページが", "開かれています"]);
  });

  it("送り仮名のある語（見出し、下書き、進める）も内容語として、文節の切れ目を作る", () => {
    expect(split("見出しを書き換えられませんでした")).toEqual([
      "見出しを",
      "書き換えられませんでした",
    ]);
    expect(split("下書きを引き継ぎました")).toEqual(["下書きを", "引き継ぎました"]);
    expect(split("見直しを進めるための下書きを書き換えられませんでした")).toEqual([
      "見直しを",
      "進めるための下書きを",
      "書き換えられませんでした",
    ]);
  });

  it("通知で使う程度の文は、語の途中で切らず、見出しの 1 行（375px 幅の 16px で 17 字ほど）に収まる文節に分かれる", () => {
    const sentences = [
      "見出しを書き換えられませんでした",
      "下書きを引き継ぎました",
      "見直しを進めるための下書きを書き換えられませんでした",
      "ページを書き換えられませんでした",
      "ログインし直すと、残りを続きから書き換えます",
      "この画面の内容を破棄して、別の場所の内容に置き換えますか",
      "他のページのリンクは自動では書き換わりません",
      "タイトルを保存してからコピーできます",
      "ページを作るにはログインが必要です",
      "リンク先を調べられませんでした",
      "ページを保存できませんでした",
    ];
    for (const sentence of sentences) {
      const phrases = split(sentence);
      expect(phrases.join("")).toBe(sentence);
      expect(phrases.join("|")).not.toMatch(MID_WORD_SEAM);
      for (const phrase of phrases) expect(phrase.length).toBeLessThanOrEqual(16);
    }
  });

  it("どの入力でも、断片をつなぐと元の文字列になり、行頭に置けない文字で始まらない", () => {
    const texts = [
      "ちょっとしたシャッターを切ってください。ニュースのキャンセルはじゅうぶんにっこりしゃべりながら、きっちりぎゅっとゆっくりフェッチしたデータをコーヒーのようにリフレッシュします。",
      "「公開設定」のページを保存できませんでした。",
      "",
      "ABC 123",
    ];
    for (const text of texts) {
      const phrases = split(text);
      expect(phrases.join("")).toBe(text);
      for (const phrase of phrases) expect(phrase).not.toMatch(LINE_HEAD_PROHIBITED);
    }
  });

  it("画面のソースにある日本語の文字列で、語の途中を切らない", () => {
    const dir = new URL(".", import.meta.url);
    let checked = 0;
    for (const file of readdirSync(dir)) {
      if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
      const source = readFileSync(new URL(file, dir), "utf8");
      for (const [run] of source.matchAll(/[ぁ-んァ-ヶ一-龠ー、。「」（）々]{6,}/g)) {
        const phrases = split(run);
        expect(phrases.join(""), run).toBe(run);
        expect(phrases.join("|"), run).not.toMatch(MID_WORD_SEAM);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});
