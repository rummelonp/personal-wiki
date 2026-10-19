import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { ROOT_PAGE_LIST_LIMIT } from "./page-html";
import { ownerCookie, ownerEnv } from "./test/owner";
import { type PageJson, T0 } from "./test/pages";
import { insertToken } from "./test/tokens";

/*
 * `/llms.txt` には、どの principal が取っても public で削除されていないページだけが入る。
 * draft、削除済み、public から draft に戻したページの title と id は、本文のどこにも出てはならない。
 */

const ORIGIN = "http://localhost";

async function setup(overrides: { SITE_NAME?: string; SITE_DESCRIPTION?: string } = {}) {
  const clock = { now: T0 };
  const app = createApp({ now: () => clock.now, recordWrite: () => {} });
  const cookie = await ownerCookie(T0);
  const bindings = { ...ownerEnv(), SITE_NAME: "", SITE_DESCRIPTION: "", ...overrides };
  const call = (path: string, init: RequestInit = {}) => app.request(path, init, bindings);
  const asOwner = (path: string, method: string, json?: unknown, headers = {}) => {
    clock.now += 1000;
    return call(path, {
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
  };
  async function setVisibility(id: string, visibility: "public" | "draft") {
    const res = await asOwner(`/api/pages/${id}/visibility`, "PUT", { visibility });
    if (res.status !== 200) throw new Error(`visibility failed: ${res.status}`);
    return res.json<PageJson>();
  }
  async function create(title: string, visibility: "public" | "draft" = "draft") {
    const res = await asOwner("/api/pages", "POST", { title, body: "" });
    if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
    const page = await res.json<PageJson>();
    return visibility === "draft" ? page : setVisibility(page.id, visibility);
  }
  return { cookie, call, asOwner, create, setVisibility };
}

/** `## Pages` の下のリンクの行。節が無ければ空。 */
function pageLines(text: string): string[] {
  const start = text.indexOf("\n## Pages\n\n");
  if (start === -1) return [];
  return text
    .slice(start + "\n## Pages\n\n".length)
    .split("\n")
    .filter((line) => line !== "");
}

describe("/llms.txt", () => {
  it("public で削除されていないページだけを、匿名にも owner と token にも更新日時の新しい順に並べる", async () => {
    const { call, asOwner, create, setVisibility, cookie } = await setup();
    const open = await create("Open Note", "public");
    const draft = await create("Hidden Plan");
    await create("Second", "public");
    const gone = await create("Gone", "public");
    const deleted = await asOwner(`/api/pages/${gone.id}`, "DELETE", undefined, {
      "If-Match": `"${gone.version}"`,
    });
    expect(deleted.status).toBe(204);
    const reverted = await create("Reverted", "public");
    await setVisibility(reverted.id, "draft");
    const updated = await asOwner(
      `/api/pages/${open.id}`,
      "PUT",
      { title: open.title, body: "x" },
      { "If-Match": `"${open.version}"` },
    );
    expect(updated.status).toBe(200);

    const token = await insertToken({ name: "reader", scopes: "read" });
    for (const headers of [{}, { Cookie: cookie }, { Authorization: `Bearer ${token}` }]) {
      const label = Object.keys(headers)[0] ?? "anonymous";
      const res = await call("/llms.txt", { headers });
      expect(res.status, label).toBe(200);
      const text = await res.text();
      expect(text, label).toBe(
        [
          "# personal-wiki",
          "",
          "## Pages",
          "",
          `- [Open Note](${ORIGIN}/Open_Note)`,
          `- [Second](${ORIGIN}/Second)`,
          "",
        ].join("\n"),
      );
      for (const word of [draft.id, "Hidden Plan", gone.id, "Gone", reverted.id, "Reverted"]) {
        expect(text, `${label} ${word}`).not.toContain(word);
      }
    }
  });

  it("text/plain の utf-8 で noindex を付けて返し、匿名には no-store、owner と token には private, no-store を付ける", async () => {
    const { call, create, cookie } = await setup();
    await create("Open Note", "public");
    const anonymous = await call("/llms.txt");
    expect(anonymous.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(anonymous.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(anonymous.headers.get("Cache-Control")).toBe("no-store");
    expect(anonymous.headers.get("ETag")).toBeNull();
    expect(anonymous.headers.get("Vary")).toContain("Cookie");
    expect(anonymous.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const token = await insertToken({ name: "reader", scopes: "read" });
    for (const headers of [{ Cookie: cookie }, { Authorization: `Bearer ${token}` }]) {
      const res = await call("/llms.txt", { headers });
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    }
  });

  it("public から draft に戻したページは、次の取得で一覧から消える", async () => {
    const { call, create, setVisibility } = await setup();
    const page = await create("Soon Private", "public");
    expect(pageLines(await (await call("/llms.txt")).text())).toEqual([
      `- [Soon Private](${ORIGIN}/Soon_Private)`,
    ]);
    await setVisibility(page.id, "draft");
    const text = await (await call("/llms.txt")).text();
    expect(text).toBe("# personal-wiki\n");
    expect(text).not.toContain(page.id);
  });

  it("SITE_NAME と SITE_DESCRIPTION を H1 と blockquote に出し、規則を満たさない説明文は出さない", async () => {
    const described = await setup({
      SITE_NAME: " rummelonp wiki ",
      SITE_DESCRIPTION: " 一人用の Markdown wiki。 ",
    });
    await described.create("Open Note", "public");
    expect(await (await described.call("/llms.txt")).text()).toBe(
      [
        "# rummelonp wiki",
        "",
        "> 一人用の Markdown wiki。",
        "",
        "## Pages",
        "",
        `- [Open Note](${ORIGIN}/Open_Note)`,
        "",
      ].join("\n"),
    );
    for (const description of ["a\nb", "a\u202eb", "😀".repeat(201), " "]) {
      const { call } = await setup({ SITE_DESCRIPTION: description });
      const text = await (await call("/llms.txt")).text();
      expect(text, JSON.stringify(description)).toMatch(/^# personal-wiki\n/);
      expect(text, JSON.stringify(description)).not.toMatch(/^>/m);
    }
  });

  it("title の Markdown の記号はリンクを壊さないよう escape し、URL の ( と ) は percent-encoding にする", async () => {
    const { call, create } = await setup();
    await create("a (b) c", "public");
    await create("x) [y] `z` <w> \\v", "public");
    expect(pageLines(await (await call("/llms.txt")).text())).toEqual([
      `- [x) \\[y\\] \\\`z\\\` \\<w> \\\\v](${ORIGIN}/x%29_%5By%5D_%60z%60_%3Cw%3E_%5Cv)`,
      `- [a (b) c](${ORIGIN}/a_%28b%29_c)`,
    ]);
  });

  it("予約語と重なる title は /p/<id> へ、/ を含む title は %2F の URL へリンクする", async () => {
    const { call, create } = await setup();
    const llms = await create("LLMS.txt", "public");
    const index = await create("index", "public");
    await create("Slash/", "public");
    expect(pageLines(await (await call("/llms.txt")).text())).toEqual([
      `- [Slash/](${ORIGIN}/Slash%2F)`,
      `- [index](${ORIGIN}/p/${index.id})`,
      `- [LLMS.txt](${ORIGIN}/p/${llms.id})`,
    ]);
  });

  it(`多くて ${ROOT_PAGE_LIST_LIMIT} 件で、古いページから外す`, async () => {
    const { call, create } = await setup();
    const titles: string[] = [];
    for (let i = 0; i <= ROOT_PAGE_LIST_LIMIT; i++) {
      titles.push((await create(`Page ${i}`, "public")).title);
    }
    const lines = pageLines(await (await call("/llms.txt")).text());
    expect(lines).toEqual(
      titles
        .slice(1)
        .reverse()
        .map((title) => `- [${title}](${ORIGIN}/${title.replace(" ", "_")})`),
    );
  });

  it("クエリが付いても同じ本文を返し、HEAD は GET と同じステータスとヘッダーを本文なしで返す", async () => {
    const { call, create } = await setup();
    await create("Open Note", "public");
    const plain = await (await call("/llms.txt")).text();
    expect(await (await call("/llms.txt?tag=x")).text()).toBe(plain);
    const head = await call("/llms.txt", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(head.headers.get("Cache-Control")).toBe("no-store");
    expect(await head.text()).toBe("");
  });

  it("下の階層と末尾の / は SPA の HTML でなく JSON の 404 にする", async () => {
    const { call } = await setup();
    for (const path of ["/llms.txt/", "/llms.txt/x"]) {
      const res = await call(path, { headers: { Accept: "text/html" } });
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({ error: "not_found" });
    }
  });

  it("D1 の一覧の取得が失敗したら、空の一覧でなく 503 を no-store で返す", async () => {
    const failingDb = {
      prepare: () => ({
        bind: () => ({
          all: async () => {
            throw new Error("D1 is unavailable");
          },
        }),
      }),
    } as unknown as D1Database;
    const res = await createApp().request("/llms.txt", {}, { ...ownerEnv(), DB: failingDb });
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).not.toContain("#");
  });
});
