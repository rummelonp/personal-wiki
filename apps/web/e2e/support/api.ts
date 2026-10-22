import { mintSessionValue, SESSION_COOKIE_NAME } from "./session";
import { OWNER_EMAIL } from "./stack";

/** owner として REST を呼ぶ。テストのデータの用意と、衝突を起こすための別の場所からの更新に使う。 */

export interface ApiPage {
  id: string;
  title: string;
  body: string;
  visibility: "draft" | "public";
  version: number;
}

export interface OwnerApi {
  createPage(input: {
    title: string;
    body: string;
    visibility?: "draft" | "public";
  }): Promise<ApiPage>;
  getPage(id: string): Promise<ApiPage>;
  updatePage(page: ApiPage, input: { title?: string; body?: string }): Promise<ApiPage>;
}

/**
 * wrangler dev の ProxyWorker が UserWorker への接続を失うと、GET と HEAD は送り直されるが、POST と PUT は
 * miniflare の entry worker が例外の stack を本文にした 500 にして返す。本番は ProxyWorker を通らない。
 * 負荷が高いときだけ起きるので、ほかの 500 は隠さず、本文の先頭の行がこの例外のときだけ送り直す。
 * stack には `Error: ` の接頭辞と呼び出し元の行が付くことがあるので、先頭の行のメッセージで比べる。
 */
const CONNECTION_LOST_LINE = /^(?:\w*Error: )?Network connection lost\.$/;
const MAX_ATTEMPTS = 3;

async function isConnectionLost(res: Response): Promise<boolean> {
  if (res.status !== 500) return false;
  const firstLine = (await res.clone().text()).trim().split("\n", 1)[0] ?? "";
  return CONNECTION_LOST_LINE.test(firstLine.trim());
}

async function errorCode(res: Response): Promise<{ error?: string; existing?: { id: string } }> {
  try {
    return (await res.clone().json()) as { error?: string; existing?: { id: string } };
  } catch {
    return {};
  }
}

export function ownerApi(
  origin: string,
  sessionSecret: string,
  fetchImpl: typeof fetch = fetch,
): OwnerApi {
  // Worker は cookie 付きの変更系に、同一オリジンの Origin と JSON を求める（auth/middleware.ts）
  const headers = {
    Cookie: `${SESSION_COOKIE_NAME}=${mintSessionValue(sessionSecret, OWNER_EMAIL)}`,
    Origin: origin,
    "Content-Type": "application/json",
  };

  /**
   * 接続が切れたのが Worker の処理の前か後かは分からないので、送り直した後の応答が「前の送信が効いた」
   * ことを示すときは、`adopt` がそれを確かめて成功として返す。`adopt` を渡さない要求は、送り直しても
   * 副作用が重ならない（GET、同じ値を置く PUT）ものに限る。
   */
  async function call(
    path: string,
    init: RequestInit,
    expected: number,
    adopt?: (res: Response) => Promise<ApiPage | undefined>,
  ): Promise<ApiPage> {
    for (let attempt = 1; ; attempt++) {
      const res = await fetchImpl(`${origin}${path}`, {
        ...init,
        headers: { ...headers, ...init.headers },
      });
      if (attempt < MAX_ATTEMPTS && (await isConnectionLost(res))) {
        await res.body?.cancel();
        continue;
      }
      if (res.status === expected) return (await res.json()) as ApiPage;
      const adopted = attempt > 1 ? await adopt?.(res) : undefined;
      if (adopted !== undefined) return adopted;
      throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
    }
  }

  return {
    async createPage({ title, body, visibility = "draft" }) {
      // 送り直した POST が title_conflict になったら、前の送信が作ったページ（同じ本文の版 1 の draft）かを確かめる。
      // POST は visibility を送らないので、作った直後のページは必ず draft である。
      const adoptCreated = async (res: Response) => {
        const { error, existing } = await errorCode(res);
        if (res.status !== 409 || error !== "title_conflict" || existing === undefined) return;
        const created = await call(`/api/pages/${existing.id}`, { method: "GET" }, 200);
        const fresh =
          created.version === 1 && created.visibility === "draft" && created.body === body;
        return fresh ? created : undefined;
      };
      const page = await call(
        "/api/pages",
        { method: "POST", body: JSON.stringify({ title, body }) },
        201,
        adoptCreated,
      );
      if (visibility === "draft") return page;
      return call(
        `/api/pages/${page.id}/visibility`,
        { method: "PUT", body: JSON.stringify({ visibility }) },
        200,
      );
    },
    getPage(id) {
      return call(`/api/pages/${id}`, { method: "GET" }, 200);
    },
    updatePage(page, input) {
      const title = input.title ?? page.title;
      const body = input.body ?? page.body;
      // 送り直した PUT が version_conflict になったら、前の送信が効いた（版が 1 つ進み、中身が同じ）かを確かめる
      const adoptUpdated = async (res: Response) => {
        if (res.status !== 409 || (await errorCode(res)).error !== "version_conflict") return;
        const current = await call(`/api/pages/${page.id}`, { method: "GET" }, 200);
        const applied =
          current.version === page.version + 1 && current.title === title && current.body === body;
        return applied ? current : undefined;
      };
      return call(
        `/api/pages/${page.id}`,
        {
          method: "PUT",
          headers: { "If-Match": `"${page.version}"` },
          body: JSON.stringify({ title, body }),
        },
        200,
        adoptUpdated,
      );
    },
  };
}
