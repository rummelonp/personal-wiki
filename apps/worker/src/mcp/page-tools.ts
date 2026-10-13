import { z } from "zod";
import {
  appendToPageAs,
  createPageAs,
  describeWriteError,
  findPageByInputId,
  updatePageAs,
} from "../pages/operations";
import {
  type AppendError,
  findPageByTitle,
  MAX_BODY_BYTES,
  MAX_TITLE_BYTES,
  type Page,
  type WriteError,
} from "../pages/store";
import { pageUrls } from "../pages/urls";
import { defineTool, toolError, toolResult, type WikiToolContext } from "./tool";

const LIMITS = `上限は UTF-8 で title が ${MAX_TITLE_BYTES} バイト、body が ${MAX_BODY_BYTES} バイト。`;
const NO_SECRETS =
  "draft でも URL を知っていれば誰でも読めるので、パスワード、API キー、トークン、個人情報などの秘密は書かない。";

/** 書き込みの結果。上限近い本文を書き込みのたびに送り返さないよう、本文は含めない。 */
function pageSummary(page: Page, origin: string) {
  return {
    id: page.id,
    title: page.title,
    visibility: page.visibility,
    version: page.version,
    updatedAt: page.updatedAt,
    ...pageUrls(origin, page),
  };
}

function writeError(error: WriteError | AppendError) {
  return toolError(describeWriteError(error).body);
}

const pageId = z.string().describe("ページの id（read_page などが返す 22 文字の id）");

export const readPageTool = defineTool({
  name: "read_page",
  scope: "read",
  title: "ページを読む",
  description: [
    "wiki のページを id か title で 1 件読み、本文（Markdown）、version、visibility、URL を返す。",
    "id と title はどちらか一方だけを指定する。title は大文字小文字と全角半角を区別しない。",
    "url は `/p/<id>` の URL。titleUrl は public のページで、title が予約語と重ならないときだけ返る。",
    "update_page の前に、このツールで最新の version を取る。",
  ].join("\n"),
  inputSchema: z.strictObject({
    id: pageId.optional(),
    title: z.string().describe("ページの title").optional(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run({ id, title }, ctx) {
    if ((id === undefined) === (title === undefined)) {
      return toolError({
        error: "invalid_arguments",
        message: "id と title のどちらか一方だけを指定する",
      });
    }
    const page =
      id === undefined
        ? await findPageByTitle(ctx.db, title as string)
        : await findPageByInputId(ctx.db, id);
    if (page === null) return toolError({ error: "not_found" });
    return toolResult({
      id: page.id,
      title: page.title,
      body: page.body,
      visibility: page.visibility,
      version: page.version,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
      ...pageUrls(ctx.origin, page),
    });
  },
});

export const createPageTool = defineTool({
  name: "create_page",
  scope: "write",
  title: "ページを作る",
  description: [
    "wiki にページを新しく作る。ページは常に draft で作られる。公開（public にする）はオーナーがブラウザで行い、このツールではできない。",
    NO_SECRETS,
    "同じ title のページがあると title_conflict になる。既存のページへのメモの追加は append_to_page を使う。",
    LIMITS,
  ].join("\n"),
  inputSchema: z.strictObject({
    title: z.string().describe("ページの title（1 行）"),
    body: z.string().describe("本文の Markdown"),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  async run({ title, body }, ctx) {
    const result = await createPageAs(ctx, { title, body });
    if (!result.ok) return writeError(result);
    return toolResult(pageSummary(result.page, ctx.origin));
  },
});

export const updatePageTool = defineTool({
  name: "update_page",
  scope: "write",
  title: "ページを書き換える",
  description: [
    "既存のページの title と body を丸ごと置き換える。先に read_page で読み、そのとき返った version を渡す。title を変えないときも、読んだ title をそのまま渡す。",
    "読んだあとに別の保存が入っていると version_conflict になり、current に最新の title、body、version が返る。current に変更を当て直し、current.version を渡して保存し直す。",
    "末尾に書き足すだけなら、version の要らない append_to_page を使う。visibility は変えられない。",
    NO_SECRETS,
    LIMITS,
  ].join("\n"),
  inputSchema: z.strictObject({
    id: pageId,
    version: z.number().int().positive().describe("read_page で読んだときの version"),
    title: z.string().describe("保存後の title（変えないときは読んだ title）"),
    body: z.string().describe("保存後の本文の Markdown 全体"),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  async run({ id, version, title, body }, ctx) {
    const result = await updatePageAs(ctx, { id, expectedVersion: version, title, body });
    if (result.ok) return toolResult(pageSummary(result.page, ctx.origin));
    if (result.reason !== "version_conflict") return writeError(result);
    return versionConflict(ctx, id, result);
  },
});

/**
 * 版の競合では、読み直しの往復を省けるよう最新版を添える。currentVersion は競合を検出した時点の版で、
 * current はその後に読んだ版なので、間に保存が入れば current.version の方が新しい。
 */
async function versionConflict(
  ctx: WikiToolContext,
  id: string,
  error: Extract<WriteError, { reason: "version_conflict" }>,
) {
  const current = await findPageByInputId(ctx.db, id);
  if (current === null) return toolError({ error: "not_found" });
  return toolError({
    ...describeWriteError(error).body,
    current: { title: current.title, body: current.body, version: current.version },
  });
}

export const appendToPageTool = defineTool({
  name: "append_to_page",
  scope: "write",
  title: "ページに追記する",
  description: [
    "ページの本文の末尾に text を書き足す。version は要らず、他の保存と重なってもサーバーが最新版に足し直す。作業メモやログの追記はこのツールを使う。",
    "本文が改行で終わっていなければ改行を 1 つ挟む。段落を分けたいときは text の先頭に空行を入れる。",
    NO_SECRETS,
    LIMITS,
  ].join("\n"),
  inputSchema: z.strictObject({
    id: pageId,
    text: z.string().min(1).describe("末尾に足す Markdown"),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  async run({ id, text }, ctx) {
    const result = await appendToPageAs(ctx, { id, text });
    if (!result.ok) return writeError(result);
    return toolResult(pageSummary(result.page, ctx.origin));
  },
});

export const PAGE_TOOLS = [readPageTool, createPageTool, updatePageTool, appendToPageTool];
