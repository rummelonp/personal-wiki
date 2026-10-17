import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { policyKindOf } from "../auth/middleware";
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from "../auth/session";
import { ownerCookie, ownerEnv } from "../test/owner";
import { type PageJson, T0 } from "../test/pages";
import { insertToken } from "../test/tokens";
import { RESOLVE_MAX_TITLES } from "./routes";

/*
 * 匿名から見た公開範囲の境界。draft は id での直接取得だけで読め、title での取得、一覧、検索、
 * タグ、backlink には出ない。匿名向けのレスポンスのどこにも draft の id が現れないことを、
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

/** draft にだけ書かれた文字列。匿名向けのレスポンスには、draft を id で取ったとき以外は現れない。 */
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

  it("draft の title、存在しない title、削除済み／存在しない／形式の違う id（本文と backlink）は同じ 404", async () => {
    const { anonymous, gone } = await seed();
    const responses = await Promise.all(
      [
        `/api/pages/by-title?title=${encodeURIComponent("Hidden Plan")}`,
        `/api/pages/by-title?title=${encodeURIComponent("Missing Page")}`,
        `/api/pages/by-title?title=${encodeURIComponent("Gone")}`,
        `/api/pages/${gone.id}`,
        "/api/pages/AAAAAAAAAAAAAAAAAAAAAA",
        "/api/pages/short",
        `/api/pages/${gone.id}/backlinks`,
        "/api/pages/AAAAAAAAAAAAAAAAAAAAAA/backlinks",
        "/api/pages/short/backlinks",
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

    const titles = await (await anonymous("/api/pages/titles")).json<{ pages: Listed[] }>();
    expect(ids(titles.pages)).toEqual([linker.id, open.id]);

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
      ["秘蔵の", []],
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

  it("title での backlink は、draft の title と存在しない title で同じレスポンスになり、public のリンク元だけを返す", async () => {
    const { anonymous, open, linker, create, setVisibility } = await seed();
    const ids = (pages: Listed[]) => pages.map((page) => page.id);
    // draft のリンク元。owner には見え、匿名には出ない
    await create("Draft Linker", "[[Hidden Plan]] [[Missing Page]] [[Open Note]]");
    // public のリンク元を足し、Hidden Plan と Missing Page の両方を指させる
    const both = await setVisibility(
      await create("Both", "[[hidden plan]] [[missing page]]"),
      "public",
    );
    const read = async (title: string) => {
      const res = await anonymous(
        `/api/pages/by-title/backlinks?title=${encodeURIComponent(title)}`,
      );
      return {
        status: res.status,
        headers: Object.fromEntries(res.headers),
        body: await res.text(),
      };
    };
    const draftTitle = await read("Hidden Plan");
    const missingTitle = await read("Missing Page");
    expect(draftTitle).toEqual(missingTitle);
    expect(draftTitle.status).toBe(200);
    expect(JSON.parse(draftTitle.body)).toEqual({
      pages: [
        { id: both.id, title: "Both", visibility: "public", updatedAt: both.updatedAt },
        { id: open.id, title: "Open Note", visibility: "public", updatedAt: open.updatedAt },
      ],
      nextCursor: null,
    });
    // public のページ自身は除き、draft のリンク元（Hidden Plan、Draft Linker）は出さない
    const openTitle = JSON.parse((await read("open note")).body) as { pages: Listed[] };
    expect(ids(openTitle.pages)).toEqual([linker.id]);
  });

  it("検索語が NFKC の後で 3 文字に満たなければ 400 で拒み、3 文字からは検索する", async () => {
    const { anonymous, asOwner, open, draft } = await seed();
    const ids = (pages: Listed[]) => pages.map((page) => page.id);
    // `ｶﾞｷ` は NFKC で `ガキ` の 2 文字になり、`㌀` は `アパート` の 4 文字に開く
    for (const q of ["k", "ka", " ka　", "公開", "ｶﾞｷ"]) {
      const res = await anonymous(`/api/search?q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(400);
      expect(await res.json(), q).toMatchObject({ error: "query_too_short", field: "q", min: 3 });
    }
    for (const [q, expected] of [
      ["kan", [open.id]],
      ["公開の", [open.id]],
      ["㌀", []],
    ] as const) {
      const res = await anonymous(`/api/search?q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
      expect(ids((await res.json<{ results: Listed[] }>()).results), q).toEqual(expected);
    }
    // owner は短い語も探せる（read の token は下の「read の token は draft を…」で確かめる）
    const owner = await asOwner(`/api/search?q=${encodeURIComponent("秘蔵")}`);
    expect(owner.status).toBe(200);
    expect(ids((await owner.json<{ results: Listed[] }>()).results)).toEqual([draft.id]);
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

    const titleSeen: string[] = [];
    cursor = null;
    do {
      const query: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const text = await (await anonymous(`/api/pages/titles?limit=1${query}`)).text();
      expect(text).not.toContain(draft.id);
      expect(text).not.toContain(fresh.id);
      const list = JSON.parse(text) as { pages: Listed[]; nextCursor: string | null };
      titleSeen.push(...list.pages.map((page) => page.id));
      cursor = list.nextCursor;
    } while (cursor !== null);
    expect(titleSeen).toEqual(seen);
  });

  it("backlink を 1 件ずつたどっても、より新しい draft のリンク元が出ず、public のリンク元を取りこぼさない", async () => {
    const { anonymous, open, linker, draft, clock, create } = await seed();
    // public の Linker より新しい draft のリンク元を作る。絞り込みが LIMIT の後なら 1 ページ目が空になる
    clock.now += 1000;
    const fresh = await create("Newest Draft", "#shared [[Open Note]]");

    const pages: Listed[][] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const res = await anonymous(`/api/pages/${open.id}/backlinks?limit=1${query}`);
      const text = await res.text();
      expect(text).not.toContain(draft.id);
      expect(text).not.toContain(fresh.id);
      const list = JSON.parse(text) as { pages: Listed[]; nextCursor: string | null };
      pages.push(list.pages);
      cursor = list.nextCursor;
    } while (cursor !== null);
    expect(pages[0]?.map((page) => page.id)).toEqual([linker.id]);
    expect(pages.flat().map((page) => page.id)).toEqual([linker.id]);
  });

  it("検索の limit=1 でも、より関連の強い draft に押し出されず public を返す", async () => {
    const { anonymous, asOwner, open, draft } = await seed();
    const path = `/api/search?q=shared&limit=1`;
    // owner には draft が先頭に出る（このテストが LIMIT の前の絞り込みを確かめられる前提）
    const owner = await (await asOwner(path)).json<{ results: Listed[] }>();
    expect(owner.results.map((hit) => hit.id)).toEqual([draft.id]);
    const anon = await (await anonymous(path)).json<{ results: Listed[] }>();
    expect(anon.results.map((hit) => hit.id)).toEqual([open.id]);
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
    const titles = await (await anonymous("/api/pages/titles")).json<{ pages: Listed[] }>();
    expect(titles.pages.map((page) => page.id)).toEqual([linker.id]);
    expect(await (await anonymous("/api/tags")).json()).toEqual({
      tags: [{ tag: "pub", count: 1 }],
    });
    const search = await (await anonymous("/api/search?q=kangaroo")).json();
    expect(search).toEqual({ results: [] });
    const backlinks = await (await anonymous(`/api/pages/${draft.id}/backlinks`)).json();
    expect(backlinks).toEqual({ pages: [], nextCursor: null });
  });
});

describe("検証できないセッション cookie", () => {
  /** ページの読み取りの 9 つのルートを 1 つずつ呼ぶパス。 */
  function readPaths(open: PageJson): string[] {
    return [
      `/api/pages/by-title?title=${encodeURIComponent("Open Note")}`,
      `/api/pages/resolve?title=${encodeURIComponent("Open Note")}`,
      "/api/pages/recent",
      "/api/pages/titles",
      "/api/tags",
      `/api/search?q=${encodeURIComponent("Open")}`,
      `/api/pages/${open.id}`,
      `/api/pages/${open.id}/backlinks`,
      `/api/pages/by-title/backlinks?title=${encodeURIComponent("Open Note")}`,
    ];
  }

  function expectCookieCleared(res: Response) {
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=;`));
    for (const attribute of ["Max-Age=0", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) {
      expect(setCookie).toContain(attribute);
    }
  }

  const garbage = `${SESSION_COOKIE_NAME}=garbage`;

  it("ページの読み取りは 401 にして cookie を消さず、同じ cookie で続けて読んでも 401 のまま", async () => {
    const { call, open, clock } = await seed();
    const stale = {
      garbage,
      expired: await ownerCookie(clock.now - SESSION_TTL_SECONDS * 1000 - 1000),
      wrongSecret: await ownerCookie(clock.now, "x".repeat(44)),
    };
    for (const [variant, cookie] of Object.entries(stale)) {
      for (const round of [1, 2]) {
        for (const path of readPaths(open)) {
          const label = `${variant} ${round} ${path}`;
          const res = await call(path, { headers: { Cookie: cookie } });
          expect(res.status, label).toBe(401);
          expect(await res.json(), label).toEqual({ error: "unauthorized" });
          expect(res.headers.get("Set-Cookie"), label).toBeNull();
          expect(res.headers.get("Vary"), label).toBe("Authorization, Cookie");
        }
      }
    }
  });

  it("OWNER_EMAILS から外れた owner の cookie も 401 にし、消さない", async () => {
    const { app, open, cookie } = await seed();
    const env = ownerEnv({ OWNER_EMAILS: "other@example.com" });
    for (const path of readPaths(open)) {
      const res = await app.request(path, { headers: { Cookie: cookie } }, env);
      expect(res.status, path).toBe(401);
      expect(res.headers.get("Set-Cookie"), path).toBeNull();
    }
  });

  it("HEAD も GET と同じく 401 にする", async () => {
    const { call, open } = await seed();
    const res = await call(`/api/pages/${open.id}`, {
      method: "HEAD",
      headers: { Cookie: garbage },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("/api/me は匿名として答えて cookie を消し、その後は匿名として public だけを読める", async () => {
    const { call, anonymous, open } = await seed();
    const me = await call("/api/me", { headers: { Cookie: garbage } });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      kind: "anonymous",
      features: { attachments: true, linkRewrites: true, oauth: true },
    });
    expectCookieCleared(me);
    // ブラウザは Max-Age=0 の cookie を捨てるので、以降のリクエストは cookie を持たない
    for (const path of readPaths(open)) {
      const res = await anonymous(path);
      expect(res.status, path).toBe(200);
      const text = await res.text();
      for (const word of DRAFT_ONLY_MARKERS) expect(text, `${path} に ${word}`).not.toContain(word);
      expect(res.headers.get("Set-Cookie"), path).toBeNull();
    }
  });

  it("ヘルスチェックは匿名として通し、cookie には触らない", async () => {
    const { call } = await seed();
    const res = await call("/api/healthz", { headers: { Cookie: garbage } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("owner の設定が無い環境では cookie を検証できないので、匿名として読ませ、消さない", async () => {
    const { app, open, cookie } = await seed();
    const env = ownerEnv({ SESSION_SECRET: "" });
    for (const path of readPaths(open)) {
      const res = await app.request(path, { headers: { Cookie: cookie } }, env);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).not.toContain("zebrafish");
      expect(res.headers.get("Set-Cookie"), path).toBeNull();
    }
  });

  it("有効な owner の cookie は消さない", async () => {
    const { asOwner, open } = await seed();
    for (const path of readPaths(open)) {
      const res = await asOwner(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Set-Cookie"), path).toBeNull();
    }
  });
});

describe("匿名向けのレスポンスの総当たり", () => {
  /**
   * 匿名を受け付ける宣言（allowAnonymousRead と allowAnonymous）を付けたルートと、匿名で呼ぶ具体的な
   * パス。キーは `METHOD path`。そうしたルートを足すとこの表との突き合わせが落ちるので、足したルートも
   * draft の id を返さないかをここで確かめることになる。draft を id で取る `/api/pages/:draftId` だけは、
   * draft の id を含むのが正しいので除いて別に確かめる。
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
    const titleBacklinks = (value: string) =>
      `/api/pages/by-title/backlinks?title=${encodeURIComponent(value)}`;
    const resolve = (...titles: string[]) =>
      `/api/pages/resolve?${titles.map((t) => `title=${encodeURIComponent(t)}`).join("&")}`;
    return {
      "GET /api/healthz": ["/api/healthz"],
      "GET /api/me": ["/api/me"],
      "GET /_auth/login": ["/_auth/login", "/_auth/login?return=/Hidden%20Plan"],
      "POST /_auth/logout": ["/_auth/logout"],
      "GET /api/pages/by-title": [
        title("Open Note"),
        title("Linker"),
        title("Hidden Plan"),
        title("hidden plan"),
        title("Gone"),
        title("Missing Page"),
      ],
      "GET /api/pages/resolve": [
        resolve("Open Note", "hidden plan", "HIDDEN PLAN", "Gone", "Missing Page", "Linker"),
        resolve("hidden plan"),
        resolve(...Array.from({ length: RESOLVE_MAX_TITLES + 1 }, () => "hidden plan")),
        "/api/pages/resolve",
      ],
      "GET /api/pages/recent": [
        "/api/pages/recent",
        "/api/pages/recent?limit=1",
        "/api/pages/recent?limit=100",
        "/api/pages/recent?tag=shared",
        "/api/pages/recent?tag=Shared",
        "/api/pages/recent?tag=shared/inner",
        "/api/pages/recent?tag=draftonly",
        "/api/pages/recent?tag=pub",
        "/api/pages/recent?visibility=draft",
        "/api/pages/recent?visibility=draft&tag=shared",
        "/api/pages/recent?visibility=draft&tag=draftonly",
        "/api/pages/recent?visibility=public",
        "/api/pages/recent?visibility=public&tag=shared",
        "/api/pages/recent?visibility=bogus",
      ],
      "GET /api/pages/titles": [
        "/api/pages/titles",
        "/api/pages/titles?limit=1",
        "/api/pages/titles?limit=500",
      ],
      "GET /api/tags": [
        "/api/tags",
        "/api/tags?visibility=draft",
        "/api/tags?visibility=public",
        "/api/tags?visibility=bogus",
      ],
      "GET /api/search": [
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
      "GET /api/pages/:id": [
        `/api/pages/${open.id}`,
        `/api/pages/${linker.id}`,
        `/api/pages/${gone.id}`,
        "/api/pages/AAAAAAAAAAAAAAAAAAAAAA",
      ],
      "GET /api/pages/:id/backlinks": [
        `/api/pages/${open.id}/backlinks`,
        `/api/pages/${linker.id}/backlinks`,
        `/api/pages/${draft.id}/backlinks`,
        `/api/pages/${gone.id}/backlinks`,
      ],
      // 何も保存していないので、どれも 404。参照のある添付の配信は attachments/attachments.test.ts で確かめる
      "GET /api/pages/by-title/backlinks": [
        titleBacklinks("Open Note"),
        titleBacklinks("Hidden Plan"),
        titleBacklinks("hidden plan"),
        titleBacklinks("Missing Page"),
        titleBacklinks("Gone"),
        "/api/pages/by-title/backlinks",
      ],
      "GET /api/pages/:id/attachments/:name": [
        `/api/pages/${open.id}/attachments/AAAAAAAAAAAAAAAAAAAAAA.png`,
        `/api/pages/${draft.id}/attachments/AAAAAAAAAAAAAAAAAAAAAA.png`,
        `/api/pages/${gone.id}/attachments/AAAAAAAAAAAAAAAAAAAAAA.png`,
        `/api/pages/${open.id}/attachments/x.svg`,
      ],
      "GET /*": [
        "/",
        `/${encodeURIComponent("Hidden Plan")}`,
        `/${encodeURIComponent("Hidden Plan")}/`,
        `/p/${open.id}`,
        `/p/${open.id}/`,
      ],
      // OAuth の認可サーバー（auth/oauth-routes.ts）。認可と接続の一覧は owner でなければ /_auth/login へ送る
      "GET /.well-known/oauth-authorization-server": ["/.well-known/oauth-authorization-server"],
      "GET /.well-known/oauth-protected-resource/mcp": [
        "/.well-known/oauth-protected-resource/mcp",
      ],
      "POST /_auth/oauth/token": ["/_auth/oauth/token"],
      "POST /_auth/oauth/register": ["/_auth/oauth/register"],
      "GET /_auth/oauth/authorize": [
        "/_auth/oauth/authorize",
        `/_auth/oauth/authorize?response_type=code&client_id=${draft.id}&state=${draft.id}`,
      ],
      "GET /_auth/oauth/grants": ["/_auth/oauth/grants", `/_auth/oauth/grants?cursor=${draft.id}`],
    };
  }

  // SPA の配信が返す index.html。ASSETS の中身はビルドの成果物で、ページのデータを含まない
  const assets = {
    fetch: async (input: RequestInfo | URL) => {
      const { pathname } = new URL(String(input instanceof Request ? input.url : input));
      if (pathname !== "/") return new Response("not found", { status: 404 });
      return new Response("<!doctype html><title>wiki</title>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  } as unknown as Fetcher;

  it("匿名を受け付ける宣言を付けたルートをすべて表に載せている", async () => {
    const { app, ...pages } = await seed();
    const anonymousPolicies = new Set(["allowAnonymousRead", "allowAnonymous"]);
    const registered = new Set(
      app.routes
        .filter((route) => anonymousPolicies.has(policyKindOf(route.handler) ?? ""))
        .map((route) => `${route.method} ${route.path}`),
    );
    expect([...registered].sort()).toEqual(Object.keys(anonymousRequests(pages)).sort());
  });

  it("どのレスポンスの本文にも draft の id、draft だけの語、削除済みの id が現れない", async () => {
    const { app, ...pages } = await seed();
    const forbidden = [pages.draft.id, pages.gone.id, ...DRAFT_ONLY_MARKERS];
    for (const [route, paths] of Object.entries(anonymousRequests(pages))) {
      const method = route.split(" ")[0] as string;
      for (const path of paths) {
        const label = `${method} ${path}`;
        const res = await app.request(
          path,
          { method, headers: { Accept: "text/html" } },
          { ...ownerEnv(), ASSETS: assets },
        );
        expect(res.status, label).toBeLessThan(500);
        const text = await res.text();
        for (const word of forbidden) expect(text, `${label} に ${word}`).not.toContain(word);
        const html = res.headers.get("Content-Type")?.startsWith("text/html") === true;
        expect(res.headers.get("Cache-Control"), label).toBe(html ? "no-cache" : "no-store");
        if (path.startsWith("/api/"))
          expect(res.headers.get("X-Robots-Tag"), label).toBe("noindex");
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
  it("owner は draft を title、一覧、タグ、検索、backlink で見られ、レスポンスは private, no-store", async () => {
    const { asOwner, create, draft, open, linker } = await seed();
    const byTitle = await asOwner(`/api/pages/by-title?title=${encodeURIComponent("Hidden Plan")}`);
    expect(byTitle.status).toBe(200);
    expect(byTitle.headers.get("Cache-Control")).toBe("private, no-store");
    expect(byTitle.headers.get("Vary")).toBe("Authorization, Cookie");

    const recent = await (await asOwner("/api/pages/recent")).json<{ pages: Listed[] }>();
    expect(recent.pages.map((page) => page.id)).toEqual([linker.id, open.id, draft.id]);
    const titles = await (await asOwner("/api/pages/titles")).json<{ pages: Listed[] }>();
    expect(titles.pages.map((page) => page.id)).toEqual([linker.id, open.id, draft.id]);
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
    // title での backlink も draft のリンク元を含め、リンク先が draft でも無くても引ける
    for (const [title, expected] of [
      ["Open Note", [linker.id, draft.id]],
      ["Hidden Plan", [open.id]],
      ["Missing Page", [open.id]],
    ] as const) {
      const res = await asOwner(`/api/pages/by-title/backlinks?title=${encodeURIComponent(title)}`);
      expect(res.headers.get("Cache-Control"), title).toBe("private, no-store");
      const list = await res.json<{ pages: Listed[] }>();
      expect(
        list.pages.map((page) => page.id),
        title,
      ).toEqual(expected);
    }
    const draftLinker = await create("Draft Linker", "[[Missing Page]]");
    const missing = await (
      await asOwner(`/api/pages/by-title/backlinks?title=${encodeURIComponent("missing page")}`)
    ).json<{ pages: Listed[] }>();
    expect(missing.pages.map((page) => page.id)).toEqual([draftLinker.id, open.id]);
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
    expect(await (await call("/api/pages/titles", { headers })).text()).toContain(draft.id);
    expect(await (await call("/api/search?q=秘蔵", { headers })).text()).toContain(draft.id);
  });

  it("read の token は公開範囲で一覧を絞り込め、draft の指定で draft を見られる", async () => {
    const { call, draft, open, linker } = await seed();
    const token = await insertToken({ name: "reader", scopes: "read" });
    const headers = { Authorization: `Bearer ${token}` };
    const ids = async (query: string) =>
      (
        await (await call(`/api/pages/recent${query}`, { headers })).json<{ pages: Listed[] }>()
      ).pages.map((page) => page.id);
    expect(await ids("?visibility=draft")).toEqual([draft.id]);
    expect(await ids("?visibility=public")).toEqual([linker.id, open.id]);
  });

  it("同じパスでも、owner のレスポンスと匿名のレスポンスは principal で分かれ、匿名には draft が出ない", async () => {
    const { asOwner, anonymous, draft } = await seed();
    const owner = await asOwner("/api/pages/recent");
    expect(await owner.text()).toContain(draft.id);
    const anon = await anonymous("/api/pages/recent");
    expect(await anon.text()).not.toContain(draft.id);
    expect(anon.headers.get("Cache-Control")).toBe("no-store");
    expect(anon.headers.get("Vary")).toBe("Authorization, Cookie");
  });
});

describe("GET /api/pages/recent?visibility=", () => {
  type ListJson = { pages: Listed[]; nextCursor: string | null };
  const ids = (list: ListJson) => list.pages.map((page) => page.id);

  it("owner は公開範囲で絞り込め、tag と cursor を併用できる", async () => {
    const { asOwner, draft, open, linker } = await seed();
    const list = async (query: string) =>
      (await asOwner(`/api/pages/recent${query}`)).json<ListJson>();
    expect(ids(await list("?visibility=draft"))).toEqual([draft.id]);
    expect(ids(await list("?visibility=public"))).toEqual([linker.id, open.id]);
    // tag と AND で絞る。shared は draft と public の両方に付いている
    expect(ids(await list("?visibility=draft&tag=shared"))).toEqual([draft.id]);
    expect(ids(await list("?visibility=public&tag=shared"))).toEqual([open.id]);
    expect(ids(await list("?visibility=public&tag=draftonly"))).toEqual([]);

    const first = await list("?visibility=public&limit=1");
    expect(ids(first)).toEqual([linker.id]);
    const second = await list(`?visibility=public&limit=1&cursor=${first.nextCursor}`);
    expect(ids(second)).toEqual([open.id]);
    expect(second.nextCursor).toBeNull();
  });

  it("owner の draft の指定は limit=1 でたどっても draft だけを順に返し、public を挟まない", async () => {
    const { asOwner, create, draft } = await seed();
    const newer = await create("Newer Draft", "後から作った下書き");
    const list = async (query: string) =>
      (await asOwner(`/api/pages/recent${query}`)).json<ListJson>();
    const first = await list("?visibility=draft&limit=1");
    expect(ids(first)).toEqual([newer.id]);
    const second = await list(`?visibility=draft&limit=1&cursor=${first.nextCursor}`);
    expect(ids(second)).toEqual([draft.id]);
    expect(second.nextCursor).toBeNull();
  });

  it("write の token も draft の指定で draft を見られる", async () => {
    const { call, draft } = await seed();
    const token = await insertToken({ name: "writer", scopes: "read write" });
    const res = await call("/api/pages/recent?visibility=draft", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(ids(await res.json<ListJson>())).toEqual([draft.id]);
  });

  it("visibility を重ねて渡すと最初の値で絞る", async () => {
    const { asOwner, anonymous, draft } = await seed();
    const query = "/api/pages/recent?visibility=draft&visibility=public";
    expect(ids(await (await asOwner(query)).json<ListJson>())).toEqual([draft.id]);
    expect(await (await anonymous(query)).json()).toEqual({ pages: [], nextCursor: null });
  });

  it("匿名の draft の指定は、tag の有無に関係なく 200 の空の一覧で、public の指定は指定なしと同じ", async () => {
    const { anonymous } = await seed();
    for (const query of ["?visibility=draft", "?visibility=draft&tag=draftonly"]) {
      const res = await anonymous(`/api/pages/recent${query}`);
      expect(res.status, query).toBe(200);
      expect(await res.json(), query).toEqual({ pages: [], nextCursor: null });
    }
    // public のページが無いタグの指定（DB を引いて 0 件になる）と、本文もヘッダーも同じ
    const viaFilter = await anonymous("/api/pages/recent?visibility=draft");
    const viaTag = await anonymous("/api/pages/recent?tag=draftonly");
    expect(await viaFilter.text()).toBe(await viaTag.text());
    expect([...viaFilter.headers]).toEqual([...viaTag.headers]);
    // 空を返すのを入力の検証より前に動かすと、誤った指定で tag の側だけが 400 になって見分けられる
    for (const bad of ["limit=0", "cursor=x"]) {
      const filterBad = await anonymous(`/api/pages/recent?visibility=draft&${bad}`);
      const tagBad = await anonymous(`/api/pages/recent?tag=draftonly&${bad}`);
      expect(filterBad.status, bad).toBe(400);
      expect(await filterBad.text(), bad).toBe(await tagBad.text());
    }
    const all = await (await anonymous("/api/pages/recent")).json<ListJson>();
    const onlyPublic = await (
      await anonymous("/api/pages/recent?visibility=public")
    ).json<ListJson>();
    expect(onlyPublic).toEqual(all);
  });

  it("公開範囲に無い値は、principal に関係なく 400", async () => {
    const { anonymous, asOwner } = await seed();
    for (const value of ["", "bogus", "Draft", "all"]) {
      for (const [who, request] of [
        ["anonymous", anonymous],
        ["owner", asOwner],
      ] as const) {
        const res = await request(`/api/pages/recent?visibility=${value}`);
        expect(res.status, `${who} ${value}`).toBe(400);
        expect(await res.json(), `${who} ${value}`).toEqual({
          error: "invalid_field",
          field: "visibility",
        });
      }
    }
  });
});

describe("GET /api/tags?visibility=", () => {
  type TagsJson = { tags: { tag: string; count: number }[] };
  const DRAFT_TAGS = [
    { tag: "draftonly", count: 1 },
    { tag: "Shared", count: 1 },
    { tag: "shared/inner", count: 1 },
  ];
  const PUBLIC_TAGS = [
    { tag: "pub", count: 2 },
    { tag: "shared", count: 1 },
  ];

  it("owner は公開範囲で件数と表記を絞り込め、件数は同じ指定の一覧の件数に合う", async () => {
    const { asOwner } = await seed();
    const tags = async (query: string) => (await asOwner(`/api/tags${query}`)).json<TagsJson>();
    expect((await tags("?visibility=draft")).tags).toEqual(DRAFT_TAGS);
    expect((await tags("?visibility=public")).tags).toEqual(PUBLIC_TAGS);
    for (const visibility of ["draft", "public"]) {
      for (const { tag, count } of (await tags(`?visibility=${visibility}`)).tags) {
        const list = await (
          await asOwner(`/api/pages/recent?visibility=${visibility}&tag=${encodeURIComponent(tag)}`)
        ).json<{ pages: Listed[] }>();
        expect(list.pages.length, `${visibility} ${tag}`).toBe(count);
      }
    }
  });

  it("read と write の token は、owner と同じく draft の指定で draft のタグを見られる", async () => {
    const { call } = await seed();
    for (const scopes of ["read", "read write"] as const) {
      const token = await insertToken({ name: scopes, scopes });
      const headers = { Authorization: `Bearer ${token}` };
      const tags = async (query: string) =>
        (await call(`/api/tags${query}`, { headers })).json<TagsJson>();
      expect((await tags("?visibility=draft")).tags, scopes).toEqual(DRAFT_TAGS);
      expect((await tags("?visibility=public")).tags, scopes).toEqual(PUBLIC_TAGS);
    }
  });

  it("匿名の draft の指定は、draft のタグの有無に関係なく同じ 200 の空の一覧で、public の指定は指定なしと同じ", async () => {
    const empty = await setup();
    const before = await empty.anonymous("/api/tags?visibility=draft");
    const { anonymous } = await seed();
    const after = await anonymous("/api/tags?visibility=draft");
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ tags: [] });
    expect(await before.json()).toEqual({ tags: [] });
    // レスポンスのヘッダーも、指定なしの一覧と同じ形にする
    const plain = await anonymous("/api/tags");
    expect([...after.headers]).toEqual([...plain.headers]);
    expect(await (await anonymous("/api/tags?visibility=public")).json()).toEqual(
      await plain.json(),
    );
  });

  it("公開範囲に無い値は、principal に関係なく 400", async () => {
    const { anonymous, asOwner } = await seed();
    for (const value of ["", "bogus", "Draft", "all"]) {
      for (const [who, request] of [
        ["anonymous", anonymous],
        ["owner", asOwner],
      ] as const) {
        const res = await request(`/api/tags?visibility=${value}`);
        expect(res.status, `${who} ${value}`).toBe(400);
        expect(await res.json(), `${who} ${value}`).toEqual({
          error: "invalid_field",
          field: "visibility",
        });
      }
    }
  });
});
