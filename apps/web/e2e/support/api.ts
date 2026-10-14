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

export function ownerApi(origin: string, sessionSecret: string): OwnerApi {
  // Worker は cookie 付きの変更系に、同一オリジンの Origin と JSON を求める（auth/middleware.ts）
  const headers = {
    Cookie: `${SESSION_COOKIE_NAME}=${mintSessionValue(sessionSecret, OWNER_EMAIL)}`,
    Origin: origin,
    "Content-Type": "application/json",
  };

  async function call(path: string, init: RequestInit, expected: number): Promise<ApiPage> {
    const res = await fetch(`${origin}${path}`, {
      ...init,
      headers: { ...headers, ...init.headers },
    });
    if (res.status !== expected) {
      throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as ApiPage;
  }

  return {
    async createPage({ title, body, visibility = "draft" }) {
      const page = await call(
        "/api/pages",
        { method: "POST", body: JSON.stringify({ title, body }) },
        201,
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
      return call(
        `/api/pages/${page.id}`,
        {
          method: "PUT",
          headers: { "If-Match": `"${page.version}"` },
          body: JSON.stringify({ title: input.title ?? page.title, body: input.body ?? page.body }),
        },
        200,
      );
    },
  };
}
