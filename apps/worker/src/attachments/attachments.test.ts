import { env } from "cloudflare:workers";
import { ATTACHMENT_MAX_BYTES, isAttachmentName } from "@personal-wiki/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import type { Bindings } from "../env";
import { generatePageId } from "../pages/id";
import { ownerCookie, ownerEnv, ownerEnvWithoutBucket } from "../test/owner";
import { type PageJson, T0 } from "../test/pages";
import { insertToken } from "../test/tokens";

const ORIGIN = "http://localhost";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

/** 形は合うが、どこにも保存していない名前 */
const MISSING_NAME = "ZZZZZZZZZZZZZZZZZZZZZZ.png";

function bucketOf(bindings: Bindings): R2Bucket {
  if (bindings.BUCKET === undefined) throw new Error("R2 の binding が無い");
  return bindings.BUCKET;
}

/**
 * get と head の呼び出しを数える R2。workerd の R2Bucket は private field を持つので、
 * メソッドは元のオブジェクトに bind して返す。
 */
function countingBucket() {
  const counts = { get: 0 };
  const target = bucketOf(env);
  const bucket = new Proxy(target, {
    get(t, property) {
      if (property === "get") {
        return (...args: Parameters<R2Bucket["get"]>) => {
          counts.get += 1;
          return t.get(...args);
        };
      }
      const value = Reflect.get(t, property, t);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
  return { bucket, counts };
}

async function setup(bindings: Bindings = ownerEnv()) {
  const clock = { now: T0 };
  const app = createApp({ now: () => clock.now, recordWrite: () => {} });
  const cookie = await ownerCookie(T0);
  const writeToken = await insertToken({ name: "writer", scopes: "read write" });
  const readToken = await insertToken({ name: "reader", scopes: "read" });
  const call = (path: string, init: RequestInit = {}, over: Bindings = bindings) =>
    app.request(path, init, over);
  const ownerHeaders = { Cookie: cookie, Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" };
  const asOwnerJson = (path: string, method: string, json: unknown, headers = {}) =>
    call(path, {
      method,
      headers: { ...ownerHeaders, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(json),
    });
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  function upload(
    bytes: Uint8Array = PNG,
    type = "image/png",
    headers: Record<string, string> = bearer(writeToken),
    over: Bindings = bindings,
  ) {
    return call(
      "/api/attachments",
      {
        method: "POST",
        headers: { "Content-Type": type, "Content-Length": String(bytes.byteLength), ...headers },
        body: bytes,
      },
      over,
    );
  }
  async function uploaded(bytes: Uint8Array = PNG, type = "image/png"): Promise<string> {
    const res = await upload(bytes, type);
    if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
    return (await res.json<{ name: string }>()).name;
  }
  async function create(title: string, body: string): Promise<PageJson> {
    clock.now += 1000;
    const res = await asOwnerJson("/api/pages", "POST", { title, body });
    if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
    return res.json<PageJson>();
  }
  async function update(page: PageJson, body: string): Promise<PageJson> {
    clock.now += 1000;
    const res = await asOwnerJson(
      `/api/pages/${page.id}`,
      "PUT",
      { title: page.title, body },
      { "If-Match": `"${page.version}"` },
    );
    if (res.status !== 200) throw new Error(`update failed: ${res.status}`);
    return res.json<PageJson>();
  }
  async function setVisibility(page: PageJson, visibility: "public" | "draft") {
    clock.now += 1000;
    const res = await asOwnerJson(`/api/pages/${page.id}/visibility`, "PUT", { visibility });
    if (res.status !== 200) throw new Error(`visibility failed: ${res.status}`);
    return res.json<PageJson>();
  }
  async function remove(page: PageJson) {
    const res = await call(`/api/pages/${page.id}`, {
      method: "DELETE",
      headers: {
        ...ownerHeaders,
        "Content-Type": "application/json",
        "If-Match": `"${page.version}"`,
      },
    });
    if (res.status !== 204) throw new Error(`delete failed: ${res.status}`);
  }
  const served = (page: { id: string }, name: string) =>
    `/api/pages/${page.id}/attachments/${name}`;
  return {
    app,
    call,
    ownerHeaders,
    bearer,
    writeToken,
    readToken,
    upload,
    uploaded,
    create,
    update,
    setVisibility,
    remove,
    served,
  };
}

/** 存在しないパスの 404 と同じ形か。匿名に、読めない理由（無い、参照が無い、削除済み）を区別させない */
async function expectNotFound(res: Response, label: string) {
  expect(res.status, label).toBe(404);
  expect(await res.json(), label).toEqual({ error: "not_found" });
  expect(res.headers.get("Cache-Control"), label).toBe("no-store");
  expect(res.headers.get("ETag"), label).toBeNull();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("添付の名前", () => {
  it("乱数 22 文字の base64url と拡張子で、添付の名前の形に合う", () => {
    for (let i = 0; i < 200; i++) {
      const id = generatePageId();
      expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(isAttachmentName(`${id}.png`)).toBe(true);
    }
  });
});

describe("POST /api/attachments", () => {
  it("write の token で保存し、名前、種類、大きさを返す。R2 と D1 に入る", async () => {
    const { upload } = await setup();
    const res = await upload();
    expect(res.status).toBe(201);
    const body = await res.json<{ name: string; contentType: string; size: number }>();
    expect(body).toEqual({ name: expect.any(String), contentType: "image/png", size: PNG.length });
    expect(isAttachmentName(body.name)).toBe(true);
    expect(body.name.endsWith(".png")).toBe(true);
    const row = await env.DB.prepare("SELECT * FROM attachments WHERE name = ?1")
      .bind(body.name)
      .first();
    expect(row).toEqual({
      name: body.name,
      content_type: "image/png",
      size: PNG.length,
      created_at: T0,
      created_by: "token:writer",
    });
    const object = await bucketOf(env).get(`attachments/${body.name}`);
    expect(object?.httpMetadata?.contentType).toBe("image/png");
    expect(new Uint8Array((await object?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(PNG);
  });

  it("同一オリジンの owner の cookie で、画像の Content-Type なら CSRF の検査を通る", async () => {
    const { upload, ownerHeaders } = await setup();
    const res = await upload(JPEG, "image/jpeg", ownerHeaders);
    expect(res.status).toBe(201);
    const { name } = await res.json<{ name: string }>();
    expect(name.endsWith(".jpg")).toBe(true);
    const row = await env.DB.prepare("SELECT created_by FROM attachments WHERE name = ?1")
      .bind(name)
      .first();
    expect(row).toEqual({ created_by: "owner" });
  });

  it("cookie の要求は、別オリジンからと、画像でも JSON でもない Content-Type を 403 にする", async () => {
    const { call, upload, ownerHeaders } = await setup();
    const crossSite = await upload(PNG, "image/png", {
      ...ownerHeaders,
      Origin: "https://evil.example",
      "Sec-Fetch-Site": "cross-site",
    });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toEqual({ error: "csrf_rejected" });
    const sameSite = await upload(PNG, "image/png", {
      ...ownerHeaders,
      Origin: "https://other.localhost",
      "Sec-Fetch-Site": "same-site",
    });
    expect(sameSite.status).toBe(403);
    for (const type of ["text/plain", "multipart/form-data; boundary=x", "image/svg+xml"]) {
      const res = await upload(PNG, type, ownerHeaders);
      expect(res.status, type).toBe(403);
    }
    expect((await upload(PNG, "image/png", ownerHeaders)).status).toBe(201);
    // 添付の例外は、このパスにだけ効く
    const otherPath = await call("/api/pages", {
      method: "POST",
      headers: { ...ownerHeaders, "Content-Type": "image/png" },
      body: PNG,
    });
    expect(otherPath.status).toBe(403);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM attachments").first()).toEqual({
      n: 1,
    });
  });

  it("匿名は 401、read の token は 403", async () => {
    const { upload, bearer, readToken } = await setup();
    expect((await upload(PNG, "image/png", {})).status).toBe(401);
    expect((await upload(PNG, "image/png", bearer(readToken))).status).toBe(403);
  });

  it("Content-Type は大文字やパラメータを含んでも受ける", async () => {
    const { upload } = await setup();
    const res = await upload(PNG, "IMAGE/PNG; x=y");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ contentType: "image/png" });
  });

  it("受けない形式、magic bytes の不一致、svg は 415 で、何も保存しない", async () => {
    const { upload } = await setup();
    const cases: [Uint8Array, string][] = [
      [SVG, "image/svg+xml"],
      [PNG, "text/html"],
      [PNG, "application/octet-stream"],
      [PNG, "application/json"],
      [JPEG, "image/png"],
      [PNG, "image/jpeg"],
      [new Uint8Array(0), "image/png"],
      [new TextEncoder().encode("<html><script>alert(1)</script>"), "image/gif"],
    ];
    for (const [bytes, type] of cases) {
      const res = await upload(bytes, type);
      expect(res.status, type).toBe(415);
    }
    const missingType = await upload(PNG, "");
    expect(missingType.status).toBe(415);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM attachments").first()).toEqual({
      n: 0,
    });
    expect((await bucketOf(env).list()).objects).toEqual([]);
  });

  it("Content-Length が無ければ 411、上限を超えれば 413", async () => {
    const { call, bearer, writeToken, upload } = await setup();
    const noLength = await call("/api/attachments", {
      method: "POST",
      headers: { ...bearer(writeToken), "Content-Type": "image/png" },
      body: PNG,
    });
    expect(noLength.status).toBe(411);

    const declared = await upload(PNG, "image/png", {
      ...bearer(writeToken),
      "Content-Length": String(ATTACHMENT_MAX_BYTES + 1),
    });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({
      error: "attachment_too_large",
      max: ATTACHMENT_MAX_BYTES,
    });

    // Content-Length を小さく偽っても、実際の長さで打ち切る
    const big = new Uint8Array(ATTACHMENT_MAX_BYTES + 1);
    big.set(PNG);
    const lied = await upload(big, "image/png", {
      ...bearer(writeToken),
      "Content-Length": String(PNG.length),
    });
    expect(lied.status).toBe(413);

    const atLimit = new Uint8Array(ATTACHMENT_MAX_BYTES);
    atLimit.set(PNG);
    expect((await upload(atLimit)).status).toBe(201);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM attachments").first()).toEqual({
      n: 1,
    });
  });

  it("R2 の binding が無ければ 503", async () => {
    const { upload, bearer, writeToken } = await setup();
    const res = await upload(PNG, "image/png", bearer(writeToken), ownerEnvWithoutBucket());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "attachments_unavailable" });
  });
});

describe("GET /api/pages/:id/attachments/:name の認可", () => {
  async function seed() {
    const s = await setup();
    const [onPublic, onDraft, onOther, unreferenced, onGone, unlinked, toDraft] = [
      await s.uploaded(),
      await s.uploaded(JPEG, "image/jpeg"),
      await s.uploaded(),
      await s.uploaded(),
      await s.uploaded(),
      await s.uploaded(),
      await s.uploaded(),
    ] as [string, string, string, string, string, string, string];
    let pub = await s.create(
      "Public",
      `![[${onPublic}]] ![[${MISSING_NAME}]] ![[${unlinked}]]\n\`\`\`\n![[${unreferenced}]]\n\`\`\``,
    );
    pub = await s.setVisibility(pub, "public");
    const draft = await s.create("Draft", `![[${onDraft}]]`);
    const other = await s.create("Other", `![[${onOther}]]`);
    const gone = await s.create("Gone", `![[${onGone}]]`);
    await s.remove(gone);
    let back = await s.create("Back", `![[${toDraft}]]`);
    back = await s.setVisibility(back, "public");
    back = await s.setVisibility(back, "draft");
    pub = await s.update(pub, `![[${onPublic}]] ![[${MISSING_NAME}]] 参照を外した`);
    return {
      ...s,
      pub,
      draft,
      other,
      gone,
      back,
      names: { onPublic, onDraft, onOther, unreferenced, onGone, unlinked, toDraft },
    };
  }

  it("匿名は、削除されていないページが参照する添付だけを読める（public と draft を問わない）", async () => {
    const { call, served, pub, draft, back, names } = await seed();
    const readable: [string, string, Uint8Array][] = [
      [served(pub, names.onPublic), "image/png", PNG],
      [served(draft, names.onDraft), "image/jpeg", JPEG],
      [served(back, names.toDraft), "image/png", PNG],
    ];
    for (const [path, type, bytes] of readable) {
      const res = await call(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Content-Type"), path).toBe(type);
      expect(res.headers.get("Content-Length"), path).toBe(String(bytes.length));
      expect(res.headers.get("Cache-Control"), path).toBe("private, no-cache");
      expect(res.headers.get("Content-Security-Policy"), path).toBe("default-src 'none'; sandbox");
      expect(res.headers.get("X-Content-Type-Options"), path).toBe("nosniff");
      const name = path.slice(path.lastIndexOf("/") + 1);
      expect(res.headers.get("ETag"), path).toBe(`"${name}"`);
      expect(res.headers.get("Content-Disposition"), path).toBe(`inline; filename="${name}"`);
      expect(new Uint8Array(await res.arrayBuffer()), path).toEqual(bytes);
    }
  });

  it("匿名には、別ページの参照、参照なし、存在しない、削除したページ、参照を外した後を同じ 404 にする", async () => {
    const { call, served, pub, draft, other, gone, names } = await seed();
    const hidden = [
      served(pub, names.onDraft),
      served(draft, names.onOther),
      served(other, names.onPublic),
      // コードブロックの中の embed は参照ではない
      served(pub, names.unreferenced),
      served(pub, MISSING_NAME),
      served(gone, names.onGone),
      served(pub, names.unlinked),
      served({ id: "AAAAAAAAAAAAAAAAAAAAAA" }, names.onPublic),
    ];
    for (const path of hidden) await expectNotFound(await call(path), path);
    // 参照を外した添付は、手元のキャッシュの ETag を付けても 304 にしない
    const conditional = await call(served(pub, names.unlinked), {
      headers: { "If-None-Match": `"${names.unlinked}"` },
    });
    await expectNotFound(conditional, "If-None-Match");
  });

  it("owner と read の token は、参照の無い添付も private, no-store で読める", async () => {
    const { call, served, pub, ownerHeaders, bearer, readToken, writeToken, names } = await seed();
    for (const headers of [ownerHeaders, bearer(readToken), bearer(writeToken)]) {
      for (const path of [
        served(pub, names.unreferenced),
        served(pub, names.onDraft),
        `/api/attachments/${names.unreferenced}`,
      ]) {
        const res = await call(path, { headers });
        expect(res.status, path).toBe(200);
        expect(res.headers.get("Cache-Control"), path).toBe("private, no-store");
        expect(res.headers.get("Content-Type"), path).toBe(
          path.includes(names.onDraft) ? "image/jpeg" : "image/png",
        );
      }
      await expectNotFoundOwner(await call(served(pub, MISSING_NAME), { headers }));
    }
  });

  it("If-None-Match が名前の ETag に合えば、R2 を読まずに 304 を返す", async () => {
    const { call, served, pub, names } = await seed();
    const { bucket, counts } = countingBucket();
    const bindings = ownerEnv({ BUCKET: bucket });
    for (const tag of [
      `"${names.onPublic}"`,
      `W/"${names.onPublic}"`,
      `"x", "${names.onPublic}"`,
      "*",
    ]) {
      const res = await call(
        served(pub, names.onPublic),
        { headers: { "If-None-Match": tag } },
        bindings,
      );
      expect(res.status, tag).toBe(304);
      expect(res.headers.get("ETag"), tag).toBe(`"${names.onPublic}"`);
      expect(res.headers.get("Cache-Control"), tag).toBe("private, no-cache");
      expect(await res.text(), tag).toBe("");
    }
    expect(counts.get).toBe(0);
    const stale = await call(
      served(pub, names.onPublic),
      { headers: { "If-None-Match": '"other.png"' } },
      bindings,
    );
    expect(stale.status).toBe(200);
    expect(counts.get).toBe(1);
  });

  it("HEAD は本文なしで同じヘッダーを返し、R2 から本文を読まない", async () => {
    const { call, served, pub, names } = await seed();
    const { bucket, counts } = countingBucket();
    const res = await call(
      served(pub, names.onPublic),
      { method: "HEAD" },
      ownerEnv({ BUCKET: bucket }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Length")).toBe(String(PNG.length));
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(await res.text()).toBe("");
    expect(counts.get).toBe(0);
    const hidden = await call(served(pub, names.unreferenced), { method: "HEAD" });
    expect(hidden.status).toBe(404);
    expect(hidden.headers.get("ETag")).toBeNull();
  });

  it("形の違う name と id は、行や参照があっても 404", async () => {
    const { call, served, pub, ownerHeaders, names } = await seed();
    // 行と R2 のオブジェクトと参照がそろっていても、受けない拡張子の名前は配信しない
    const svgName = "SSSSSSSSSSSSSSSSSSSSSS.svg";
    await bucketOf(env).put(`attachments/${svgName}`, SVG);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO attachments (name, content_type, size, created_at, created_by) VALUES (?1, 'image/svg+xml', 1, 0, 'owner')",
      ).bind(svgName),
      env.DB.prepare("INSERT INTO attachment_refs (page_id, name) VALUES (?1, ?2)").bind(
        pub.id,
        svgName,
      ),
    ]);
    const upper = names.onPublic.replace(".png", ".PNG");
    const paths = [
      served(pub, svgName),
      served(pub, upper),
      served(pub, `..%2F${names.onPublic}`),
      served(pub, `${names.onPublic.slice(0, 10)}%2F${names.onPublic.slice(10)}`),
      served(pub, `${names.onPublic}%00`),
      served({ id: "short" }, names.onPublic),
      served({ id: `${pub.id}x` }, names.onPublic),
      `/api/attachments/${svgName}`,
      `/api/attachments/${upper}`,
    ];
    for (const path of paths) {
      const anonymous = await call(path);
      // /api/attachments/:name は read の scope を要るので、匿名は形を見る前に 401 になる
      expect(anonymous.status, path).toBe(path.startsWith("/api/pages/") ? 404 : 401);
      expect((await call(path, { headers: ownerHeaders })).status, path).toBe(404);
    }
  });

  it("R2 の binding が無ければ 404。R2 にオブジェクトが無ければ 404 にしてログに出す", async () => {
    const { call, served, pub, ownerHeaders, names } = await seed();
    const noBucket = ownerEnvWithoutBucket();
    await expectNotFound(await call(served(pub, names.onPublic), {}, noBucket), "no bucket");
    expect(
      (await call(`/api/attachments/${names.onPublic}`, { headers: ownerHeaders }, noBucket))
        .status,
    ).toBe(404);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await bucketOf(env).delete(`attachments/${names.onPublic}`);
    await expectNotFound(await call(served(pub, names.onPublic)), "missing object");
    expect(errors).toHaveBeenCalledWith(
      JSON.stringify({ event: "attachments.object_missing", name: names.onPublic }),
    );
  });
});

/** owner と token の 404 は private, no-store になる（resolvePrincipal が上書きする）。 */
async function expectNotFoundOwner(res: Response) {
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
  expect(res.headers.get("Cache-Control")).toBe("private, no-store");
}

describe("GET /api/attachments/:name", () => {
  it("匿名は 401", async () => {
    const { call, uploaded } = await setup();
    const name = await uploaded();
    expect((await call(`/api/attachments/${name}`)).status).toBe(401);
  });
});
