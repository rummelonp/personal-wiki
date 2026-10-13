import type { Fetch, Visibility } from "./pages-api";

/** `POST /api/link-rewrites/step` の応答（apps/worker/src/pages/link-rewrites.ts の LinkRewriteStepResult）。 */
export interface LinkRewriteStepResult {
  /** 本文を書き換えたリンク元。書き換えるリンクが無く、積んだ分を捨てただけのときは null */
  processed: {
    sourcePageId: string;
    title: string;
    visibility: Visibility;
    /** 書き換えたあとの版 */
    version: number;
    rewritten: number;
  } | null;
  /** 読んだあとにリンク元か対象ページが変わった。積んだ分は残るので、呼び直せば進む */
  conflict: boolean;
  /** 書き換えられずに捨てたリンク元の id（意図しない変化が出る、本文の上限を超える、試行の上限に達した） */
  failed: string[];
  remaining: number;
}

/**
 * 失敗の種類。not_found は step の無い（古い）Worker、forbidden は read の token など書けない principal。
 * 通信の失敗と想定外の status や応答の形は error にまとめる。
 */
export type StepFailureKind = "unauthorized" | "forbidden" | "not_found" | "error";

export type StepResult =
  | { ok: true; value: LinkRewriteStepResult }
  | { ok: false; kind: StepFailureKind };

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function parseProcessed(value: unknown): LinkRewriteStepResult["processed"] | undefined {
  if (value === null) return null;
  const v = recordOf(value);
  if (
    typeof v.sourcePageId === "string" &&
    typeof v.title === "string" &&
    (v.visibility === "public" || v.visibility === "draft") &&
    typeof v.version === "number" &&
    typeof v.rewritten === "number"
  ) {
    return {
      sourcePageId: v.sourcePageId,
      title: v.title,
      visibility: v.visibility,
      version: v.version,
      rewritten: v.rewritten,
    };
  }
  return undefined;
}

function parseStep(value: unknown): LinkRewriteStepResult | null {
  const v = recordOf(value);
  const processed = parseProcessed(v.processed);
  if (
    processed === undefined ||
    typeof v.conflict !== "boolean" ||
    !Array.isArray(v.failed) ||
    !v.failed.every((id) => typeof id === "string") ||
    typeof v.remaining !== "number"
  ) {
    return null;
  }
  return { processed, conflict: v.conflict, failed: v.failed, remaining: v.remaining };
}

/** title の変更で積んだリンクの書き換えを、リンク元 1 ページ分進める。 */
export async function stepLinkRewrites(fetchFn: Fetch = fetch): Promise<StepResult> {
  let res: Response;
  try {
    // cookie の書き込みは JSON の本文を要求する（CSRF の対策）ので、空の object を送る
    res = await fetchFn("/api/link-rewrites/step", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch {
    return { ok: false, kind: "error" };
  }
  switch (res.status) {
    case 200: {
      const value = parseStep(await res.json().catch(() => null));
      return value === null ? { ok: false, kind: "error" } : { ok: true, value };
    }
    case 401:
      return { ok: false, kind: "unauthorized" };
    case 403:
      return { ok: false, kind: "forbidden" };
    case 404:
      return { ok: false, kind: "not_found" };
    default:
      return { ok: false, kind: "error" };
  }
}
