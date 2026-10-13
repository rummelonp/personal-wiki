import {
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_MAX_BYTES,
  attachmentExtensionForType,
  attachmentTypeForName,
  isAttachmentName,
  matchesAttachmentMagic,
} from "@personal-wiki/domain";
import type { Context, Hono } from "hono";
import { allowAnonymousRead, requireScope } from "../auth/middleware";
import { readableVisibilityOf } from "../auth/principal";
import type { AppEnv } from "../env";
import { generatePageId, isPageId } from "../pages/id";
import { actorOf } from "../pages/revisions";
import { ATTACHMENT_UPLOAD_PATH, uploadContentTypeOf } from "./content-type";
import { readBounded } from "./read-bounded";

export interface AttachmentRoutesOptions {
  now: () => number;
}

type AttachmentContext = Context<AppEnv>;

interface AttachmentRow {
  content_type: string;
  size: number;
}

const objectKey = (name: string) => `attachments/${name}`;

/**
 * 画像を直接開かれたときの保険。magic bytes の検査は先頭しか見ないので、画像としても HTML や script
 * としても読める polyglot は防げない。sandbox でスクリプトも同一オリジンの扱いも与えない。
 */
const ATTACHMENT_CSP = "default-src 'none'; sandbox";

function tooLarge(c: AttachmentContext): Response {
  return c.json({ error: "attachment_too_large", max: ATTACHMENT_MAX_BYTES }, 413);
}

/** `*` と、弱い比較で一致する ETag を受ける（名前ごとに中身は不変なので強弱を区別する意味が無い）。 */
function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header.split(",").some((raw) => {
    const tag = raw.trim();
    return tag === "*" || tag === etag || tag === `W/${etag}`;
  });
}

/**
 * 認可を通った添付を返す。呼ぶ前に、principal がこの添付を読めることを D1 で確かめておく
 * （304 も認可の後にしか返さない。先に返すと、参照を外した添付や他人の名前の存在を確かめられる）。
 * Content-Type は D1 の行の値を使い、リクエストや R2 の metadata の値は使わない。
 */
async function attachmentResponse(
  c: AttachmentContext,
  bucket: R2Bucket,
  name: string,
  row: AttachmentRow,
  { anonymous }: { anonymous: boolean },
): Promise<Response> {
  // 行は保存の検査を通った値のはずだが、手で直した行や復元した行も来うる。受けない種類や、名前の拡張子と
  // 食い違う種類のまま返すと、ブラウザが画像以外として扱いうるので配信しない
  if (row.content_type !== attachmentTypeForName(name)) {
    console.error(
      JSON.stringify({
        event: "attachments.unexpected_content_type",
        name,
        contentType: row.content_type,
      }),
    );
    return c.notFound();
  }
  const etag = `"${name}"`;
  const headers = new Headers({ ETag: etag });
  // 匿名の draft の画像を共有キャッシュに置かせず、毎回の再検証で参照を外したことをすぐ効かせる。
  // owner と token は resolvePrincipal が private, no-store で上書きする
  if (anonymous) headers.set("Cache-Control", "private, no-cache");
  if (matchesIfNoneMatch(c.req.header("If-None-Match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  headers.set("Content-Type", row.content_type);
  headers.set("Content-Disposition", `inline; filename="${name}"`);
  headers.set("Content-Security-Policy", ATTACHMENT_CSP);
  // HEAD は D1 の行だけで答え、R2 は読まない。R2 にオブジェクトが無い添付でも、GET の 404 と違って
  // HEAD は 200 になる。保存は R2 に置いてから行を作るので、行だけがある状態は R2 側の欠落でしか起きない
  if (c.req.method === "HEAD") {
    headers.set("Content-Length", String(row.size));
    return new Response(null, { headers });
  }
  const object = await bucket.get(objectKey(name));
  if (object === null) {
    console.error(JSON.stringify({ event: "attachments.object_missing", name }));
    return c.notFound();
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}

/**
 * 添付の保存と配信のルートを登録する。R2 の binding が無ければ、保存は 503、配信は 404 にする。
 * 削除のルートはまだ無く、参照が無くなった添付も R2 に残る。
 */
export function registerAttachmentRoutes(app: Hono<AppEnv>, { now }: AttachmentRoutesOptions) {
  return (
    app
      // 本文は画像のバイト列そのもので、種類は Content-Type で示す。cookie での呼び出しを CSRF の検査が
      // 通す条件は auth/middleware.ts の rejectCrossSiteCookieWrites
      .post(ATTACHMENT_UPLOAD_PATH, requireScope("write"), async (c) => {
        const bucket = c.env.BUCKET;
        if (bucket === undefined) return c.json({ error: "attachments_unavailable" }, 503);
        const declared = c.req.header("Content-Length");
        if (declared === undefined) return c.json({ error: "length_required" }, 411);
        if (!/^[0-9]{1,16}$/.test(declared.trim())) {
          return c.json({ error: "invalid_content_length" }, 400);
        }
        if (Number(declared) > ATTACHMENT_MAX_BYTES) return tooLarge(c);
        const type = uploadContentTypeOf(c.req.header("Content-Type"));
        if (type === null) {
          return c.json(
            { error: "unsupported_media_type", accepted: ATTACHMENT_CONTENT_TYPES },
            415,
          );
        }
        const bytes = await readBounded(c.req.raw.body, ATTACHMENT_MAX_BYTES);
        if (bytes === null) return tooLarge(c);
        if (!matchesAttachmentMagic(type, bytes)) {
          return c.json({ error: "content_mismatch", contentType: type }, 415);
        }
        const name = `${generatePageId()}.${attachmentExtensionForType(type)}`;
        // 名前は 128 bit の乱数なので、既存のオブジェクトを put で上書きすることは無いものとして扱う。
        // R2 に置いてから D1 に行を作る。D1 が失敗して残るのは行の無い R2 のオブジェクトだけで、
        // 配信は行を見て判断するのでどこからも読めない。逆の順だと、中身の無い行を本文から参照できてしまう
        await bucket.put(objectKey(name), bytes, { httpMetadata: { contentType: type } });
        await c.env.DB.prepare(
          "INSERT INTO attachments (name, content_type, size, created_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
          .bind(name, type, bytes.byteLength, now(), actorOf(c.get("principal")))
          .run();
        return c.json({ name, contentType: type, size: bytes.byteLength }, 201);
      })
      // 本文の ![[name]] の表示に使う。匿名は、削除されていないそのページが本文で参照している添付だけを
      // 読める（public と draft を問わない。draft は id の URL で匿名に読めるのに合わせる）。read 以上の
      // principal は、行があればどの添付も読める。読めないものは、存在しないものと同じ 404 にする
      .get("/api/pages/:id/attachments/:name", allowAnonymousRead(), async (c) => {
        const id = c.req.param("id");
        const name = c.req.param("name");
        if (!isPageId(id) || !isAttachmentName(name)) return c.notFound();
        const bucket = c.env.BUCKET;
        if (bucket === undefined) return c.notFound();
        const anonymous = readableVisibilityOf(c.get("principal")) !== "all";
        const row = await c.env.DB.prepare(
          `SELECT a.content_type, a.size FROM attachments AS a
           WHERE a.name = ?2 AND (?3 OR EXISTS (
             SELECT 1 FROM attachment_refs AS r JOIN pages AS p ON p.id = r.page_id
             WHERE r.page_id = ?1 AND r.name = a.name AND p.deleted_at IS NULL))`,
        )
          .bind(id, name, anonymous ? 0 : 1)
          .first<AttachmentRow>();
        if (row === null) return c.notFound();
        return attachmentResponse(c, bucket, name, row, { anonymous });
      })
      // 参照の無い添付を token のスクリプトが読むための口
      .get("/api/attachments/:name", requireScope("read"), async (c) => {
        const name = c.req.param("name");
        if (!isAttachmentName(name)) return c.notFound();
        const bucket = c.env.BUCKET;
        if (bucket === undefined) return c.notFound();
        const row = await c.env.DB.prepare(
          "SELECT content_type, size FROM attachments WHERE name = ?1",
        )
          .bind(name)
          .first<AttachmentRow>();
        if (row === null) return c.notFound();
        return attachmentResponse(c, bucket, name, row, { anonymous: false });
      })
  );
}
