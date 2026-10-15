import type * as z from "zod/v4";
import { VISIBILITY_NOT_ALLOWED_MESSAGE } from "../pages/operations";

const EXPECTED_TYPES: Record<string, string> = {
  string: "文字列",
  number: "数値",
  int: "整数",
};

/**
 * tool の入力が schema に合わないときの本文。REST の入力の検証と同じ語彙（error のコードと field）にして、
 * エージェントが REST と同じ手がかりで直せるようにする。報告するのは 1 件で、REST も最初の 1 件で止まる。
 * 知らないキーを先にするのは、REST が型の検査より先にキーを調べるのに合わせるため。
 */
export function describeInputError(
  issues: readonly z.core.$ZodIssue[],
  args: unknown,
): { error: string; [key: string]: unknown } {
  const issue = issues.find((i) => i.code === "unrecognized_keys") ?? issues[0];
  if (issue === undefined) return { error: "invalid_field" };
  if (issue.code === "unrecognized_keys") {
    // REST はキーを順に調べて最初の不正なキーを返すが、visibility は理由を添えたいので位置に関係なく先に返す
    if (issue.keys.includes("visibility")) {
      return { error: "visibility_not_allowed", message: VISIBILITY_NOT_ALLOWED_MESSAGE };
    }
    return { error: "unknown_field", field: issue.keys[0] };
  }
  if (issue.path.length === 0) {
    return { error: "invalid_json", message: "arguments は object で渡す" };
  }
  const field = issue.path.join(".");
  const given = issue.path.length === 1 ? (args as Record<string, unknown>)[field] : undefined;
  if (issue.code === "invalid_type") {
    if (given === undefined) return { error: "missing_field", field };
    const expected = EXPECTED_TYPES[issue.expected];
    const message = expected === undefined ? `${issue.expected} で渡す` : `${expected}で渡す`;
    return { error: "invalid_field", field, message };
  }
  if (issue.code === "too_big") {
    // 2^53 を超える数は、.int() の安全な整数の上限と .max() の両方に当たる。REST の上限と同じ値を返すため、小さい方を採る
    const max = Math.min(
      ...issues
        .filter((i) => i.code === "too_big" && i.path.join(".") === field)
        .map((i) => Number((i as z.core.$ZodIssueTooBig).maximum)),
    );
    return { error: "invalid_field", field, max };
  }
  if (issue.code === "too_small") {
    const unit = issue.origin === "string" ? " 文字" : " ";
    const message = issue.inclusive
      ? `${issue.minimum}${unit}以上で渡す`
      : `${issue.minimum} を超える値で渡す`;
    return { error: "invalid_field", field, message };
  }
  // zod の既定の文面は英語で、エージェントへの手がかりとして REST とそろわないので出さない
  return { error: "invalid_field", field };
}
