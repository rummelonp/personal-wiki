import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { SESSION_COOKIE_NAME } from "../auth/session";
import { ownerCookie, ownerEnv } from "../test/owner";
import { type PageJson, T0 } from "../test/pages";
import { insertToken } from "../test/tokens";

/*
 * 匿名から見た公開範囲の境界。draft は id での直接取得だけで読め、title での取得、一覧、検索、
 * タグ、backlink には出ない。匿名向けの応答のどこにも draft の id が現れないことを、
 * 登録されている GET の API を総当たりして確かめる。
 */

const ORIGIN = "http://localhost";

interface Listed {
  id: string;
  title: string;
}

async function setup() {
  const clock = { now: T0 };
  const app = createApp({ now: () => clock.now, recordWrite: () => {} });
  const cookie = await ownerCookie(T0);
  const call = (path: string, init: RequestInit = {}) => app.request(path, init, ownerEnv());
  const anonymous = (path: string) => call(path);
  const asOwner = (path: string, method = "GET", json?: unknown, headers = {}) =>
    call(path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        ...headers,
      },
      body: json === undefined ? null : JSON.stringify(json),
    });

  async function create(title: string, body: string): Promise<PageJson> {
    clock.now += 1000;
    const res = await asOwner("/api/pages", "POST", { title, body });
    if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
    return res.json<PageJson>();
  }
  async function setVisibility(page: PageJson, visibility: "public" | "draft") {
    clock.now += 1000;
    const res = await asOwner(`/api/pages/${page.id}/visibility`, "PUT", { visibility });
    if (res.status !== 200) throw new Error(`visibility failed: ${res.status}`);
    return res.json<PageJson>();
  }
  async function remove(page: PageJson) {
    const res = await asOwner(`/api/pages/${page.id}`, "DELETE", undefined, {
      "If-Match": `"${page.version}"`,
    });
    if (res.status !== 204) throw new Error(`delete failed: ${res.status}`);
  }

  return { app, clock, cookie, call, anonymous, asOwner, create, setVisibility, remove };
}

/**
 * public の Open Note と Linker、draft の Hidden Plan、削除済みの Gone を作る。
 * - Open Note は Hidden Plan へ wikilink と embed を張り、Hidden Plan は Open Note へリンクする
 * - Hidden Plan だけが持つ語（zebrafish、秘蔵）、タグ（draftonly、shared/inner）、表記（Shared）がある
 */
async function seed() {
  const ctx = await setup();
  const draft = await ctx.create(
    "Hidden Plan",
    "#Shared #shared/inner #draftonly\n下書きの zebrafish と秘蔵の話\n[[Open Note]]",
  );
  const open = await ctx.setVisibility(
    await ctx.create(
      "Open Note",
      "#shared #pub\n公開の kangaroo\n[[Hidden Plan]]\n![[Hidden Plan]]\n[[Missing Page]]",
    ),
    "public",
  );
  const linker = await ctx.setVisibility(
    await ctx.create("Linker", "#pub\n[[Open Note]] を参照する"),
    "public",
  );
  const gone = await ctx.setVisibility(
    await ctx.create("Gone", "#gone 消した ghostword"),
    "public",
  );
  await ctx.remove(gone);
  return { ...ctx, draft, open, linker, gone };
}

/** draft にだけ書かれた文字列。匿名向けの応答には、draft を id で取ったとき以外は現れない。 */
const DRAFT_ONLY_MARKERS = ["zebrafish", "秘蔵", "draftonly", "shared/inner"];

describe("匿名の読み取り", () => {
  it("public は title と id で読め、draft は id でだけ読める", async () => {
    const { anonymous, draft, open } = await seed();

    const byTitle = await anonymous(`/api/pages/by-title?title=${encodeURIComponent("open note")}`);
    expect(byTitle.status).toBe(200);
    expect(await byTitle.json()).toMatchObject({ id: open.id, visibility: "public" });

    const openById = await anonymous(`/api/pages/${open.id}`);
    expect(await openById.json()).toMatchObject({ id: open.id, title: "Open Note" });

    const draftById = await anonymous(`/api/pages/${draft.id}`);
    expect(draftById.status).toBe(200);
    expect(await draftById.json()).toMatchObject({
      id: draft.id,
      title: "Hidden Plan",
      visibility: "draft",
    });
    expect(draftById.headers.get("Cache-Control")).toBe("no-store");

    const draftByTitle = await anonymous(
      `/api/pages/by-title?title=${encodeURIComponent("Hidden Plan")}`,
    );
    expect(draftByTitle.status).toBe(404);
  });

  it("draft の title、存在しない title、削除済みの title と id、存在しない id、形式の違う id は同じ 404", async () => {
    const { anonymous, gone } = await seed();
    const responses = await Promise.all(
      [
        `/api/pages/by-title?title=${encodeURIComponent("Hidden Plan")}`,
        `/api/pages/by-title?title=${encodeURIComponent("Missing Page")}`,
        `/api/pages/by-title?title=${encodeURIComponent("Gone")}`,
        `/api/pages/${gone.id}`,
        "/api/pages/AAAAAAAAAAAAAAAAAAAAAA",
        "/api/pages/short",
      ].map(async (path) => {
        const res = await anonymous(path);
        return {
          path,
          status: res.status,
          body: await res.text(),
          headers: Object.fromEntries(res.headers),
        };
      }),
    );
    const [first, ...others] = responses;
    const { path: _firstPath, ...expected } = first as (typeof responses)[number];
    expect(expected).toMatchObject({ status: 404, body: JSON.stringify({ error: "not_found" }) });
    for (const { path, ...response } of others) expect(response, path).toEqual(expected);
  });

  it("一覧、タグ、検索、backlink には public だけが出る", async () => {
    const { anonymous, draft, open, linker } = await seed();
    const ids = (pages: Listed[]) => pages.map((page) => page.id);

    const recent = await (await anonymous("/api/pages/recent")).json<{ pages: Listed[] }>();
    expect(ids(recent.pages)).toEqual([linker.id, open.id]);

    const shared = await (await anonymous("/api/pages/recent?tag=shared")).json<{
      pages: Listed[];
    }>();
    expect(ids(shared.pages)).toEqual([open.id]);
    for (const tag of ["draftonly", "shared/inner"]) {
      const res = await anonymous(`/api/pages/recent?tag=${encodeURIComponent(tag)}`);
      expect(await res.json(), tag).toEqual({ pages: [], nextCursor: null });
    }

    // 件数と表記も public のページだけから作る（owner には Shared の表記で 2 件と見える）
    const tags = await (await anonymous("/api/tags")).json();
    expect(tags).toEqual({
      tags: [
        { tag: "pub", count: 2 },
        { tag: "shared", count: 1 },
      ],
    });

    for (const [q, expected] of [
      ["zebrafish", []],
      ["秘蔵", []],
      ["Hidden", [open.id]],
      ["kangaroo", [open.id]],
      ["ghostword", []],
    ] as const) {
      const res = await anonymous(`/api/search?q=${encodeURIComponent(q)}`);
      expect(ids((await res.json<{ results: Listed[] }>()).results), q).toEqual(expected);
    }

    const openBacklinks = await (await anonymous(`/api/pages/${open.id}/backlinks`)).json<{
      pages: Listed[];
    }>();
    expect(ids(openBacklinks.pages)).toEqual([linker.id]);

    // draft は id を知っていれば読めるので、その backlink も引ける。返すのは public のリンク元だけ
    const draftBacklinks = await (await anonymous(`/api/pages/${draft.id}/backlinks`)).json<{
      pages: Listed[];
    }>();
    expect(ids(draftBacklinks.pages)).toEqual([open.id]);
  });

  it("一覧を 1 件ずつたどっても、cursor を含めて draft の id が出ない", async () => {
    const { anonymous, draft, open, linker, clock, create, setVisibility } = await seed();
    // draft を最も新しくし、public の間にも挟む
    await setVisibility(await create("Between", "#shared"), "public");
    clock.now += 1000;
    const fresh = await create("Newest Draft", "#shared [[Open Note]]");

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const res = await anonymous(`/api/pages/recent?limit=1${query}`);
      const text = await res.text();
      expect(text).not.toContain(draft.id);
      expect(text).not.toContain(fresh.id);
      const list = JSON.parse(text) as { pages: Listed[]; nextCursor: string | null };
      seen.push(...list.pages.map((page) => page.id));
      cursor = list.nextCursor;
    } while (cursor !== null);
    expect(seen).toHaveLength(3);
    expect(seen).toContain(open.id);
    expect(seen).toContain(linker.id);
  });

  it("public を draft に戻すと、title、一覧、タグ、検索、backlink から消え、id では読める", async () => {
    const { anonymous, open, linker, setVisibility, draft } = await seed();
    const byTitle = () => anonymous(`/api/pages/by-title?title=${encodeURIComponent("Open Note")}`);
    expect((await byTitle()).status).toBe(200);

    await setVisibility(open, "draft");

    const missing = await anonymous(
      `/api/pages/by-title?title=${encodeURIComponent("Missing Page")}`,
    );
    const reverted = await byTitle();
    expect(reverted.status).toBe(404);
    expect(await reverted.text()).toBe(await missing.text());
    expect(reverted.headers.get("Cache-Control")).toBe("no-store");

    expect((await anonymous(`/api/pages/${open.id}`)).status).toBe(200);
    const recent = await (await anonymous("/api/pages/recent")).json<{ pages: Listed[] }>();
    expect(recent.pages.map((page) => page.id)).toEqual([linker.id]);
    expect(await (await anonymous("/api/tags")).json()).toEqual({
      tags: [{ tag: "pub", count: 1 }],
    });
    const search = await (await anonymous("/api/search?q=kangaroo")).json();
    expect(search).toEqual({ results: [] });
    const backlinks = await (await anonymous(`/api/pages/${draft.id}/backlinks`)).json();
    expect(backlinks).toEqual({ pages: [], nextCursor: null });
  });

  it("検証できない cookie は匿名として扱い、draft を一覧に出さない", async () => {
    const { call, draft } = await seed();
    const res = await call("/api/pages/recent", {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=garbage` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(draft.id);
  });
});

describe("匿名向けの応答の総当たり", () => {
  /**
   * 登録されている GET の `/api/*` のルートと、匿名で呼ぶ具体的なパス。ルートを足すとこの表との
   * 突き合わせが落ちるので、足したルートも draft の id を返さないかをここで確かめることになる。
   * draft を id で取る `/api/pages/:draftId` だけは、draft の id を含むのが正しいので除いて別に確かめる。
   */
  function anonymousRequests(pages: {
    draft: PageJson;
    open: PageJson;
    linker: PageJson;
    gone: PageJson;
  }): Record<string, string[]> {
    const { draft, open, linker, gone } = pages;
    const title = (value: string) => `/api/pages/by-title?title=${encodeURIComponent(value)}`;
    const search = (q: string) => `/api/search?q=${encodeURIComponent(q)}`;
    return {
      "/api/healthz": ["/api/healthz"],
      "/api/me": ["/api/me"],
      "/api/pages/by-title": [
        title("Open Note"),
        title("Linker"),
        title("Hidden Plan"),
        title("hidden plan"),
        title("Gone"),
        title("Missing Page"),
      ],
      "/api/pages/recent": [
        "/api/pages/recent",
        "/api/pages/recent?limit=1",
        "/api/pages/recent?limit=100",
        "/api/pages/recent?tag=shared",
        "/api/pages/recent?tag=Shared",
        "/api/pages/recent?tag=shared/inner",
        "/api/pages/recent?tag=draftonly",
        "/api/pages/recent?tag=pub",
      ],
      "/api/tags": ["/api/tags"],
      "/api/search": [
        search("zebrafish"),
        search("秘蔵"),
        search("Hidden"),
        search("Hidden Plan"),
        search("Open"),
        search("kangaroo"),
        search("shared"),
        search("draftonly"),
        search("下書"),
        search("の"),
      ],
      "/api/pages/:id": [
        `/api/pages/${open.id}`,
        `/api/pages/${linker.id}`,
        `/api/pages/${gone.id}`,
        "/api/pages/AAAAAAAAAAAAAAAAAAAAAA",
      ],
      "/api/pages/:id/backlinks": [
        `/api/pages/${open.id}/backlinks`,
        `/api/pages/${linker.id}/backlinks`,
        `/api/pages/${draft.id}/backlinks`,
        `/api/pages/${gone.id}/backlinks`,
      ],
    };
  }

  it("登録されている GET の API をすべて表に載せている", async () => {
    const { app, ...pages } = await seed();
    const registered = new Set(
      app.routes
        .filter((route) => route.method === "GET" && route.path.startsWith("/api/"))
        .map((route) => route.path),
    );
    expect([...registered].sort()).toEqual(Object.keys(anonymousRequests(pages)).sort());
  });

  it("どの応答の本文にも draft の id、draft だけの語、削除済みの id が現れない", async () => {
    const { anonymous, ...pages } = await seed();
    const forbidden = [pages.draft.id, pages.gone.id, ...DRAFT_ONLY_MARKERS];
    const paths = Object.values(anonymousRequests(pages)).flat();
    for (const path of paths) {
      const res = await anonymous(path);
      expect(res.status, path).toBeLessThan(500);
      const text = await res.text();
      for (const word of forbidden) expect(text, `${path} に ${word}`).not.toContain(word);
      if (path.startsWith("/api/pages") || path.startsWith("/api/search") || path === "/api/tags") {
        expect(res.headers.get("Cache-Control"), path).toBe("no-store");
      }
    }
  });

  it("draft を id で取ったときだけ draft の本文を返す", async () => {
    const { anonymous, draft } = await seed();
    const text = await (await anonymous(`/api/pages/${draft.id}`)).text();
    for (const word of [draft.id, "zebrafish"]) expect(text).toContain(word);
  });
});

describe("owner と token の読み取りは変わらない", () => {
  it("owner は draft を title、一覧、タグ、検索、backlink で見られ、応答は private, no-store", async () => {
    const { asOwner, draft, open, linker } = await seed();
    const byTitle = await asOwner(`/api/pages/by-title?title=${encodeURIComponent("Hidden Plan")}`);
    expect(byTitle.status).toBe(200);
    expect(byTitle.headers.get("Cache-Control")).toBe("private, no-store");
    expect(byTitle.headers.get("Vary")).toBe("Authorization, Cookie");

    const recent = await (await asOwner("/api/pages/recent")).json<{ pages: Listed[] }>();
    expect(recent.pages.map((page) => page.id)).toEqual([linker.id, open.id, draft.id]);
    expect(await (await asOwner("/api/tags")).json()).toEqual({
      tags: [
        { tag: "pub", count: 2 },
        { tag: "Shared", count: 2 },
        { tag: "draftonly", count: 1 },
        { tag: "shared/inner", count: 1 },
      ],
    });
    const search = await (await asOwner("/api/search?q=zebrafish")).json<{ results: Listed[] }>();
    expect(search.results.map((hit) => hit.id)).toEqual([draft.id]);
    const backlinks = await (await asOwner(`/api/pages/${open.id}/backlinks`)).json<{
      pages: Listed[];
    }>();
    expect(backlinks.pages.map((page) => page.id)).toEqual([linker.id, draft.id]);
  });

  it("read の token は draft を title と一覧で見られる", async () => {
    const { call, draft } = await seed();
    const token = await insertToken({ name: "reader", scopes: "read" });
    const headers = { Authorization: `Bearer ${token}` };
    const byTitle = await call(`/api/pages/by-title?title=${encodeURIComponent("Hidden Plan")}`, {
      headers,
    });
    expect(byTitle.status).toBe(200);
    expect(byTitle.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await (await call("/api/pages/recent", { headers })).text()).toContain(draft.id);
    expect(await (await call("/api/search?q=秘蔵", { headers })).text()).toContain(draft.id);
  });

  it("同じパスでも、owner の応答と匿名の応答は principal で分かれ、匿名には draft が出ない", async () => {
    const { asOwner, anonymous, draft } = await seed();
    const owner = await asOwner("/api/pages/recent");
    expect(await owner.text()).toContain(draft.id);
    const anon = await anonymous("/api/pages/recent");
    expect(await anon.text()).not.toContain(draft.id);
    expect(anon.headers.get("Cache-Control")).toBe("no-store");
    expect(anon.headers.get("Vary")).toBe("Authorization, Cookie");
  });
});
