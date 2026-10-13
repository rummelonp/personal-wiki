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

export const pageIdSchema = z.string().describe("ページの id（read_page などが返す 22 文字の id）");

export const readPageTool = defineTool({
  name: "read_page",
  scope: "read",
  title: "ページを読む",
  description: [
    "ページを id か title で 1 件読み、本文（Markdown）、version、visibility、URL を返す。",
    "id と title はどちらか一方だけを指定する。本文の `[[title]]` のリンクは title を渡して辿る。title は大文字小文字と全角半角を区別しない。",
    "titleUrl は public のページで、title が予約語と重ならないときだけ返る。",
  ].join("\n"),
  inputSchema: z.strictObject({
    id: pageIdSchema.optional(),
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
    "ページを新しく作る。作る前に search で同じ主題を探し、あれば作らずに append_to_page か update_page を使う。",
    "ページは常に draft で作られる。title は wiki 全体で一意で、重なると title_conflict になる。",
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
    "ページの title と body を丸ごと置き換える。構成を直すときだけ使い、メモや調べた結果は append_to_page で足す。",
    "read_page で取った version が必須。title を変えないときも読んだ title を渡す。",
    "version が合わないと version_conflict になり、current に最新の title、body、version が返る。current を読み直して変更を載せ直し、current.version で保存し直す。上書きで押し切らない。",
    LIMITS,
  ].join("\n"),
  inputSchema: z.strictObject({
    id: pageIdSchema,
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
    "ページの本文の末尾に text を書き足す。メモや調べた結果はこのツールで足す。version は要らない。",
    "本文が改行で終わっていなければ改行を 1 つ挟む。段落を分けたいときは text の先頭に空行を入れる。",
    "append_conflict（他の保存との競合が続いた）で失敗したら、同じ text をそのまま送り直してよい。",
    LIMITS,
  ].join("\n"),
  inputSchema: z.strictObject({
    id: pageIdSchema,
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
