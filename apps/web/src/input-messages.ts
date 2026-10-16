import type { PageInputProblem } from "@personal-wiki/domain/page-input";

const numberFormat = new Intl.NumberFormat("ja-JP");

/** 画面に出す数。桁区切りを付ける（「65,536」）。 */
export const formatCount = (value: number): string => numberFormat.format(value);

// 数と単位の間を NBSP にする。普通の空白だと狭い幅で「18」と「バイト」が別の行に分かれる
const withUnit = (value: number, unit: string): string => `${formatCount(value)} ${unit}`;

/**
 * 保存できない入力の説明。送る前の検査とサーバーの失敗の両方で同じ文を出す。
 * 長さはバイトのまま出す。上限がバイトで決まっていて、文字数に直すと文字の種類でずれるため。
 */
export function inputProblemMessage(problem: PageInputProblem): string {
  switch (problem.reason) {
    case "invalid_title":
      // title の比較は _ を空白とみなすので、_ だけの title も空として拒まれる
      return "タイトルが空か、空白と _ だけです。ほかの文字を入れてください。";
    case "title_too_long":
      return `タイトルが ${withUnit(problem.bytes, "バイト")}あり、上限の ${withUnit(problem.max, "バイト")}を超えているため保存できません。${withUnit(problem.bytes - problem.max, "バイト")}以上短くしてください。`;
    case "body_too_large":
      return `本文が ${withUnit(problem.bytes, "バイト")}あり、上限の ${withUnit(problem.max, "バイト")}を超えているため保存できません。${withUnit(problem.bytes - problem.max, "バイト")}以上減らすか、ページを分けてください。`;
    case "control_char":
      // 本文で拒むのは NUL だけ。印はエディタが赤く付ける
      return problem.field === "title"
        ? `タイトルの ${withUnit(problem.at.column, "文字目")}に、目に見えない制御文字（${problem.at.codePoint}）が入っていて保存できません。その文字を消してください。`
        : `本文の ${withUnit(problem.at.line, "行目")}に、目に見えない文字（NUL）が入っていて保存できません。赤い印の文字を消してください。`;
  }
}

/** 通知の見出し。畳んだ通知では見出しだけが残るので、何が原因かを見出しで言い切る。 */
export function inputProblemTitle(problem: PageInputProblem): string {
  switch (problem.reason) {
    case "invalid_title":
      return "タイトルが無いので保存できません";
    case "title_too_long":
      return "タイトルが長すぎて保存できません";
    case "body_too_large":
      return "本文が長すぎて保存できません";
    case "control_char":
      return "見えない文字があって保存できません";
  }
}
