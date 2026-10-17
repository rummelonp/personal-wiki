// "zod" の `z` を経由すると zod の全ロケールがバンドルに入る（約 580KB）。SDK と同じ "zod/v4" から名前空間で取る
import { MAX_BODY_BYTES, MAX_TITLE_BYTES } from "@personal-wiki/domain";
import * as z from "zod/v4";
import { readableVisibilityOf } from "../auth/principal";
import {
  appendToPageAs,
  createPageAs,
  describeWriteError,
  findPageByInputId,
  linkRewritesField,
  updatePageAs,
} from "../pages/operations";
import { findRevision, listRevisions, parseRevisionCursor } from "../pages/revision-history";
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT } from "../pages/search";
import { type AppendError, findPageByTitle, type Page, type WriteError } from "../pages/store";
import { pageUrls } from "../pages/urls";
import { defineTool, toolError, toolResult, type WikiToolContext } from "./tool";

const LIMITS = [
  `上限は UTF-8 で title が ${MAX_TITLE_BYTES} バイト、body が ${MAX_BODY_BYTES} バイト。`,
  "title の改行とタブは空白に置き換わる。title に NUL などの C0 の制御文字か DEL、body と text に NUL を含めると invalid_field になる。",
  "上限を超えたときの応答には送った値のバイト数（actual。追記では追記後の本文のバイト数で、今の本文のバイト数は currentBytes）が、制御文字の応答には位置（line、column、codePoint）が入る。",
].join("");
/** instructions を AI に渡さないクライアントもあるので、書き込みの tool ごとに description にも書く */
const NO_SECRETS =
  "draft も URL を知っていれば誰でも読めるので、パスワードやトークンなどの秘密を書かない。";

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

/** REST の If-Match が受け付ける 15 桁と同じ上限。Number で誤差なく表せる範囲に収まる */
const MAX_VERSION = 999_999_999_999_999;

const versionSchema = z.number().int().positive().max(MAX_VERSION);

/** 版の番号が飛ぶことと、まとめで番号が進むこと。list_revisions と read_page の両方の説明に載せる */
const REVISION_NUMBERS =
  "版の番号は連続しない。オーナーがブラウザで続けて保存した分は、最初の保存から 10 分までを 1 つの版にまとめ、まとめるたびにその版の番号が進む（前の番号の版は無くなる）。";

export const readPageTool = defineTool({
  name: "read_page",
  scope: "read",
  title: "ページを読む",
  description: [
    "ページを id か title で 1 件読み、本文（Markdown）、version、visibility、URL を返す。",
    "id と title はどちらか一方だけを指定する。本文の `[[title]]` のリンクは title を渡して辿る。title は大文字小文字と全角半角を区別せず、`_` と空白を同じ文字として扱う。",
    "titleUrl は public のページで、title が予約語と重ならないときだけ返る。",
    "revision に list_revisions の各件の version を渡すと、上の階層は今のページの値（id、title、version、visibility、createdAt、updatedAt、URL）だけで body を含まず、読んだ版の中身は revision（version、title、body、createdAt、author）に入る。update_page には上の階層の version を渡す。",
    `その版が無ければ revision_not_found になる。${REVISION_NUMBERS}少し前に見た番号が無くなっていたら、list_revisions を呼び直す。`,
  ].join("\n"),
  inputSchema: z.strictObject({
    id: pageIdSchema.optional(),
    title: z.string().describe("ページの title").optional(),
    revision: versionSchema
      .optional()
      .describe("読む版の番号（list_revisions の version）。省くと今の版を読む"),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run({ id, title, revision }, ctx) {
    if ((id === undefined) === (title === undefined)) {
      return toolError({
        error: "invalid_arguments",
        message: "id と title のどちらか一方だけを指定する",
      });
    }
    const page =
      id === undefined
        ? await findPageByTitle(ctx.db, title as string, readableVisibilityOf(ctx.principal))
        : await findPageByInputId(ctx.db, id);
    if (page === null) return toolError({ error: "not_found" });
    if (revision === undefined) {
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
    }
    const found = await findRevision(ctx.db, page.id, revision, ctx.clientName);
    // ページを読んだ直後に消されたときも、ページが無いときと同じレスポンスにする
    if (!found.ok) {
      return toolError({ error: found.reason === "page_not_found" ? "not_found" : found.reason });
    }
    const current = found.page;
    // 今のページと過去の版を同じ階層に混ぜると、古い title を今の title と取り違える
    return toolResult({
      id: current.id,
      title: current.title,
      visibility: current.visibility,
      version: current.version,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      ...pageUrls(ctx.origin, current),
      revision: {
        version: found.revision.version,
        title: found.revision.title,
        body: found.revision.body,
        createdAt: found.revision.createdAt,
        author: found.revision.author,
      },
    });
  },
});

export const listRevisionsTool = defineTool({
  name: "list_revisions",
  scope: "read",
  title: "版の履歴",
  description: [
    "ページの版の履歴を新しい順に返す。各件は version、title、createdAt、author で、本文は含まない。本文は read_page に id と revision（各件の version）を渡して読む。nextCursor が null でなければ、cursor に渡して続きを取る。",
    "id と title はどちらか一方だけを指定する。ページが無ければ not_found。",
    REVISION_NUMBERS,
    "createdAt はその版の編集を始めた時刻（まとめた版では最初の保存の時刻）。先頭の版の version が read_page の version と同じなら、read_page の updatedAt がその版の最後の保存の時刻になる（公開範囲の切り替えは version と updatedAt を進めるが、版を積まない）。",
    "author.kind は owner（オーナー）、token（API token。name は token の名前）、oauth（OAuth の接続。name は接続の名前で、登録が消えていれば null）、other（どれにも当たらない記録。actor にそのまま入る）のどれか。",
  ].join("\n"),
  inputSchema: z.strictObject({
    id: pageIdSchema.optional(),
    title: z.string().describe("ページの title").optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIST_MAX_LIMIT)
      .optional()
      .describe(`返す件数。既定 ${LIST_DEFAULT_LIMIT}、上限 ${LIST_MAX_LIMIT}`),
    cursor: z
      .string()
      .optional()
      .describe("続きを取るときに、前の結果の nextCursor をそのまま渡す"),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run({ id, title, limit, cursor }, ctx) {
    if ((id === undefined) === (title === undefined)) {
      return toolError({
        error: "invalid_arguments",
        message: "id と title のどちらか一方だけを指定する",
      });
    }
    const before = cursor === undefined ? null : parseRevisionCursor(cursor);
    if (cursor !== undefined && before === null) {
      return toolError({ error: "invalid_field", field: "cursor" });
    }
    const pageId =
      id ??
      (await findPageByTitle(ctx.db, title as string, readableVisibilityOf(ctx.principal)))?.id;
    if (pageId === undefined) return toolError({ error: "not_found" });
    const list = await listRevisions(ctx.db, pageId, {
      limit: limit ?? LIST_DEFAULT_LIMIT,
      before,
      clientName: ctx.clientName,
    });
    if (list === null) return toolError({ error: "not_found" });
    return toolResult(list);
  },
});

export const createPageTool = defineTool({
  name: "create_page",
  scope: "write",
  title: "ページを作る",
  description: [
    "ページを新しく作る。作る前に search で同じ主題を探し、あれば作らずに append_to_page か update_page を使う。",
    "ページは常に draft で作られる。title は wiki 全体で一意で、重なると title_conflict になる。`_` と空白だけが違う title も重なるとみなす。",
    LIMITS,
    NO_SECRETS,
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
    "title を変えても、他のページの `[[旧 title]]` はすぐには書き換わらない。オーナーが wiki を開いたときや、定期実行を設定していればその発火ごとに 1 ページずつ新しい title に書き換わり、それまでリンク元は旧 title のリンクのままで、新しい title の list_backlinks にも出ない。linkRewrites.queued は書き換えを待つページの数。",
    "書き換わったページ（このページ自身を含む）は version が進むので、続けて書き換えるときは read_page で読み直す。書き換えるのは、title を変えた時点で旧 title にリンクしていたページだけ。そのページの `[[旧 title]]` は、書き換わる前に足したものも、旧 title で別のページを作ったあとに書いたものも、新しい title に書き換わる（新しく作った同名のページは指さない）。それ以外のページが title を変えたあとに書いた `[[旧 title]]` は書き換わらない。",
    "title に `[ ] | # ^` を含む、または `\\` で終わると書き換えを積まずに linkRewrites.skipped を返す。そのときの旧 title のリンクは、あとで別の title に変えても書き換わらない。",
    LIMITS,
    NO_SECRETS,
  ].join("\n"),
  inputSchema: z.strictObject({
    id: pageIdSchema,
    version: versionSchema.describe("read_page で読んだときの version"),
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
    if (result.ok) {
      return toolResult({ ...pageSummary(result.page, ctx.origin), ...linkRewritesField(result) });
    }
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
    NO_SECRETS,
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

export const PAGE_TOOLS = [
  readPageTool,
  listRevisionsTool,
  createPageTool,
  updatePageTool,
  appendToPageTool,
];
