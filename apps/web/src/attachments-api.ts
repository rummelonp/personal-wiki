import { isAttachmentName } from "@personal-wiki/domain/attachment";
import type { Fetch } from "./pages-api";

/** `POST /api/attachments` が 201 で返す、保存した添付。`name` を本文の `![[name]]` に書く。 */
export interface UploadedAttachmentInfo {
  name: string;
  contentType: string;
  size: number;
}

export type UploadFailureKind =
  | "unauthorized"
  | "forbidden"
  | "too_large"
  | "unsupported_type"
  | "unavailable"
  | "error";

export type UploadResult =
  | { ok: true; value: UploadedAttachmentInfo }
  | { ok: false; kind: UploadFailureKind };

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * 添付を上げる。本文は File の生のバイト列で、種類は `Content-Type` に File の type を書く。
 * 失敗は kind で分ける。通信の失敗と、想定外の status や応答の形（411 を含む）は `error` にまとめる。
 */
export async function uploadAttachment(file: File, fetchFn: Fetch = fetch): Promise<UploadResult> {
  let res: Response;
  try {
    res = await fetchFn("/api/attachments", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": file.type },
      body: file,
    });
  } catch {
    return { ok: false, kind: "error" };
  }
  if (res.status === 201) {
    const body = recordOf(await readJson(res));
    // 本文に書く名前なので、サーバーが振る形でなければ（resolver が null にする名前を書かない）失敗にする
    if (
      typeof body.name === "string" &&
      isAttachmentName(body.name) &&
      typeof body.contentType === "string" &&
      typeof body.size === "number"
    ) {
      return {
        ok: true,
        value: { name: body.name, contentType: body.contentType, size: body.size },
      };
    }
    return { ok: false, kind: "error" };
  }
  switch (res.status) {
    case 401:
      return { ok: false, kind: "unauthorized" };
    case 403:
      return { ok: false, kind: "forbidden" };
    case 413:
      return { ok: false, kind: "too_large" };
    case 415:
      return { ok: false, kind: "unsupported_type" };
    case 503: {
      // 503 は Worker の一時的な不調でも返る。保存先が無い環境だけを「使えない」と伝える
      const unavailable = recordOf(await readJson(res)).error === "attachments_unavailable";
      return { ok: false, kind: unavailable ? "unavailable" : "error" };
    }
    default:
      return { ok: false, kind: "error" };
  }
}
