import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { ownerCookie, ownerEnv } from "../test/owner";
import { T0 } from "../test/pages";
import { insertToken } from "../test/tokens";
import { encodeBase64Url } from "./base64url";
import { safeReturnUrl } from "./routes";

const ORIGIN = "http://localhost";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const RESOURCE_METADATA_URL = `${ORIGIN}/.well-known/oauth-protected-resource/mcp`;
const SAME_ORIGIN = { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" };
const FORM = "application/x-www-form-urlencoded";

function setup({ oauthKv = true }: { oauthKv?: boolean } = {}) {
  const app = createApp({ now: () => T0 });
  const bindings = ownerEnv();
  if (!oauthKv) delete bindings.OAUTH_KV;
  const request = (path: string, init: RequestInit = {}) => app.request(path, init, bindings);
  return { app, request };
}

type Request = ReturnType<typeof setup>["request"];

async function pkcePair() {
  const verifier = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: encodeBase64Url(new Uint8Array(digest)) };
}

interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  client_name?: string;
}

async function register(request: Request, metadata: Record<string, unknown> = {}) {
  const res = await request("/_auth/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [CALLBACK],
      client_name: "Claude",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...metadata,
    }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return res.json<RegisteredClient>();
}

function authorizePath(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "read write",
    resource: `${ORIGIN}/mcp`,
    ...extra,
  });
  return `/_auth/oauth/authorize?${params}`;
}

/** owner として同意画面を開き、フォームの handle と、同意画面を開いたブラウザの cookie を返す。 */
async function openConsent(request: Request, path: string) {
  const session = await ownerCookie(T0);
  const res = await request(path, { headers: { Cookie: session } });
  expect(res.status, await res.clone().text()).toBe(200);
  const html = await res.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  if (handle === undefined) throw new Error(`同意画面に handle が無い: ${html}`);
  const binding = res.headers.get("Set-Cookie")?.split(";")[0];
  if (binding === undefined) throw new Error("同意画面が binding の cookie を付けていない");
  return { res, html, handle, cookie: `${session}; ${binding}` };
}

type Consent = Awaited<ReturnType<typeof openConsent>>;

function submitConsent(
  request: Request,
  path: string,
  consent: Consent,
  fields: Record<string, string> = {},
  headers: Record<string, string> = SAME_ORIGIN,
) {
  return request(path, {
    method: "POST",
    headers: { Cookie: consent.cookie, "Content-Type": FORM, ...headers },
    body: new URLSearchParams({
      handle: consent.handle,
      decision: "approve",
      access: "write",
      ...fields,
    }).toString(),
  });
}

function postToken(request: Request, form: Record<string, string>, headers = {}) {
  return request("/_auth/oauth/token", {
    method: "POST",
    headers: { "Content-Type": FORM, ...headers },
    body: new URLSearchParams(form).toString(),
  });
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

/** 登録、同意、コードの交換までを通し、発行されたトークンを返す。 */
async function connect(request: Request, access: "read" | "write") {
  const client = await register(request);
  const { verifier, challenge } = await pkcePair();
  const path = authorizePath(client.client_id, challenge);
  const consent = await openConsent(request, path);
  const approved = await submitConsent(request, path, consent, { access });
  expect(approved.status).toBe(302);
  const code = new URL(approved.headers.get("Location") ?? "").searchParams.get("code");
  if (code === null) throw new Error("code が返らない");
  const res = await postToken(request, {
    grant_type: "authorization_code",
    code,
    redirect_uri: CALLBACK,
    client_id: client.client_id,
    code_verifier: verifier,
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return { client, tokens: await res.json<TokenResponse>() };
}

interface RpcResponse {
  result?: Record<string, unknown> & {
    content?: { text: string }[];
    isError?: boolean;
    tools?: { name: string }[];
  };
  error?: { code: number; message: string };
}

async function readRpc(res: Response): Promise<RpcResponse> {
  const text = await res.text();
  if (res.headers.get("Content-Type")?.includes("text/event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    return JSON.parse(line?.slice("data: ".length) ?? "null") as RpcResponse;
  }
  return JSON.parse(text) as RpcResponse;
}

function postMcp(request: Request, token: string | undefined, method: string, params?: unknown) {
  return request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
}

async function callTool(request: Request, token: string, name: string, args: unknown) {
  const res = await postMcp(request, token, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  const { result } = await readRpc(res);
  return {
    isError: result?.isError === true,
    json: JSON.parse(result?.content?.[0]?.text ?? "null") as Record<string, unknown>,
  };
}

describe("OAuth のメタデータ", () => {
  it("認可サーバーのメタデータは /_auth/oauth/* のエンドポイントと S256 だけの PKCE を示す", async () => {
    const { request } = setup();
    const res = await request("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/_auth/oauth/authorize`,
      token_endpoint: `${ORIGIN}/_auth/oauth/token`,
      registration_endpoint: `${ORIGIN}/_auth/oauth/register`,
      scopes_supported: ["read", "write"],
      code_challenge_methods_supported: ["S256"],
      response_types_supported: ["code"],
    });
  });

  it("保護されたリソースのメタデータは resource が /mcp の URL と一致する", async () => {
    const { request } = setup();
    const res = await request("/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ORIGIN],
      bearer_methods_supported: ["header"],
      scopes_supported: ["read", "write"],
      resource_name: "personal-wiki",
    });
  });

  it("未認証の /mcp は resource_metadata 付きの challenge を返し、REST は素の Bearer のまま", async () => {
    const { request } = setup();
    const mcp = await postMcp(request, undefined, "tools/list");
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("WWW-Authenticate")).toBe(
      `Bearer realm="OAuth", resource_metadata="${RESOURCE_METADATA_URL}"`,
    );
    const rest = await request("/api/pages", { method: "POST" });
    expect(rest.status).toBe(401);
    expect(rest.headers.get("WWW-Authenticate")).toBe("Bearer");
  });
});

describe("client の登録（DCR）", () => {
  it("公開 client を登録し、client_id を返す", async () => {
    const { request } = setup();
    const client = await register(request);
    expect(client.client_id).toEqual(expect.any(String));
    expect(client.client_secret).toBeUndefined();
    expect(client.client_name).toBe("Claude");
  });

  it("https でも loopback でもない redirect URI は登録できない", async () => {
    const { request } = setup();
    const res = await request("/_auth/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"], client_name: "x" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("認可と同意画面", () => {
  it("owner のセッションが無ければ、元の URL を return に入れて /_auth/login へ送る", async () => {
    const { request } = setup();
    const client = await register(request);
    const path = authorizePath(client.client_id, (await pkcePair()).challenge);
    const res = await request(path);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "", ORIGIN);
    expect(location.pathname).toBe("/_auth/login");
    expect(location.searchParams.get("return")).toBe(path);
    // ログイン後の戻り先の検証が、redirect_uri などの URL を含む認可の要求を落とさない
    expect(safeReturnUrl(location.searchParams.get("return") ?? undefined, ORIGIN)).toBe(
      `${ORIGIN}${path}`,
    );
  });

  it("owner には client 名、送り先、要求された scope をエスケープして見せ、フレームと保存を禁じる", async () => {
    const { request } = setup();
    const client = await register(request, { client_name: "<script>x</script>" });
    const path = authorizePath(client.client_id, (await pkcePair()).challenge);
    const { res, html } = await openConsent(request, path);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' https://claude.ai");
    expect(res.headers.get("Set-Cookie")).toMatch(/^__Host-oauth-consent-/);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&#60;script&#62;x&#60;/script&#62;");
    expect(html).toContain("<strong>claude.ai</strong>");
    expect(html).toContain(CALLBACK);
    expect(html).toContain('value="write" checked');
  });

  it("承認すると redirect URI に code と state と iss を付けて戻す", async () => {
    const { request } = setup();
    const client = await register(request);
    const path = authorizePath(client.client_id, (await pkcePair()).challenge);
    const consent = await openConsent(request, path);
    const res = await submitConsent(request, path, consent);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
    expect(location.searchParams.get("code")).toEqual(expect.any(String));
    expect(location.searchParams.get("state")).toBe("state-1");
    expect(location.searchParams.get("iss")).toBe(ORIGIN);
  });

  it("拒否すると access_denied を付けて戻す", async () => {
    const { request } = setup();
    const client = await register(request);
    const path = authorizePath(client.client_id, (await pkcePair()).challenge);
    const consent = await openConsent(request, path);
    const res = await submitConsent(request, path, consent, { decision: "deny" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("別のオリジンからの送信は 403 にし、handle を消費しない", async () => {
    const { request } = setup();
    const client = await register(request);
    const path = authorizePath(client.client_id, (await pkcePair()).challenge);
    const consent = await openConsent(request, path);
    for (const headers of [
      { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "same-site" },
      { Origin: "https://evil.example" },
      {},
    ]) {
      const res = await submitConsent(request, path, consent, {}, headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(await res.json()).toEqual({ error: "csrf_rejected" });
    }
    expect((await submitConsent(request, path, consent)).status).toBe(302);
  });

  it("使用済みの handle と、同意画面を開いたブラウザの cookie が無い送信は受け付けない", async () => {
    const { request } = setup();
    const client = await register(request);
    const path = authorizePath(client.client_id, (await pkcePair()).challenge);
    const consent = await openConsent(request, path);

    const withoutBinding = { ...consent, cookie: await ownerCookie(T0) };
    const unbound = await submitConsent(request, path, withoutBinding);
    expect(unbound.status).toBe(400);
    expect(unbound.headers.get("Location")).toBeNull();

    expect((await submitConsent(request, path, consent)).status).toBe(302);
    const replayed = await submitConsent(request, path, consent);
    expect(replayed.status).toBe(400);
    expect(replayed.headers.get("Location")).toBeNull();
  });

  it("owner でなければ同意を送れない", async () => {
    const { request } = setup();
    const client = await register(request);
    const path = authorizePath(client.client_id, (await pkcePair()).challenge);
    const consent = await openConsent(request, path);
    const binding = consent.cookie.split("; ")[1] ?? "";
    const res = await submitConsent(request, path, { ...consent, cookie: binding });
    expect(res.status).toBe(401);
  });

  it("PKCE の無い要求と plain の PKCE は同意画面を出さずに client へ戻す", async () => {
    const { request } = setup();
    const client = await register(request);
    const session = await ownerCookie(T0);
    for (const extra of [{ code_challenge_method: "plain" }, { code_challenge: "" }]) {
      const path = authorizePath(client.client_id, "x".repeat(43), extra);
      const res = await request(path, { headers: { Cookie: session } });
      expect(res.status, path).toBe(302);
      expect(new URL(res.headers.get("Location") ?? "").searchParams.get("error")).toBe(
        "invalid_request",
      );
    }
  });

  it("登録されていない redirect URI には戻さず、この画面で誤りを出す", async () => {
    const { request } = setup();
    const client = await register(request);
    const path = authorizePath(client.client_id, (await pkcePair()).challenge, {
      redirect_uri: "https://evil.example/cb",
    });
    const res = await request(path, { headers: { Cookie: await ownerCookie(T0) } });
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });
});

describe("トークンの交換", () => {
  it("S256 の code_verifier で code をトークンに交換し、更新トークンで新しいトークンを得る", async () => {
    const { request } = setup();
    const { client, tokens } = await connect(request, "read");
    expect(tokens).toMatchObject({ token_type: "bearer", expires_in: 3600, scope: "read" });

    const refreshed = await postToken(request, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json<TokenResponse>();
    expect(next.access_token).not.toBe(tokens.access_token);
    expect((await postMcp(request, next.access_token, "tools/list")).status).toBe(200);
  });

  it("code_verifier が合わなければ交換できない", async () => {
    const { request } = setup();
    const client = await register(request);
    const { challenge } = await pkcePair();
    const path = authorizePath(client.client_id, challenge);
    const consent = await openConsent(request, path);
    const approved = await submitConsent(request, path, consent);
    const code = new URL(approved.headers.get("Location") ?? "").searchParams.get("code") ?? "";
    const res = await postToken(request, {
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      client_id: client.client_id,
      code_verifier: (await pkcePair()).verifier,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("client_secret の Basic 認証は wiki の資格情報として読まず、ライブラリに渡す", async () => {
    const { request } = setup();
    const client = await register(request, { token_endpoint_auth_method: "client_secret_basic" });
    expect(client.client_secret).toEqual(expect.any(String));
    const { verifier, challenge } = await pkcePair();
    const path = authorizePath(client.client_id, challenge);
    const consent = await openConsent(request, path);
    const approved = await submitConsent(request, path, consent);
    const code = new URL(approved.headers.get("Location") ?? "").searchParams.get("code") ?? "";
    const basic = btoa(`${client.client_id}:${client.client_secret}`);
    const res = await postToken(
      request,
      { grant_type: "authorization_code", code, redirect_uri: CALLBACK, code_verifier: verifier },
      { Authorization: `Basic ${basic}` },
    );
    expect(res.status, await res.clone().text()).toBe(200);
  });
});

describe("OAuth のトークンでの /mcp", () => {
  it("read のトークンは読めるが書けない", async () => {
    const { request } = setup();
    const { tokens } = await connect(request, "read");
    const list = await postMcp(request, tokens.access_token, "tools/list");
    expect(list.status).toBe(200);
    expect((await readRpc(list)).result?.tools?.map((tool) => tool.name)).toContain("read_page");

    const denied = await callTool(request, tokens.access_token, "create_page", {
      title: "x",
      body: "",
    });
    expect(denied).toEqual({
      isError: true,
      json: { error: "forbidden", message: "この token には write の scope が無い" },
    });
  });

  it("write のトークンは書け、actor は oauth: と client_id になる", async () => {
    const { request } = setup();
    const { client, tokens } = await connect(request, "write");
    const created = await callTool(request, tokens.access_token, "create_page", {
      title: "From Claude",
      body: "本文",
    });
    expect(created.isError).toBe(false);
    const row = await env.DB.prepare("SELECT actor FROM revisions WHERE page_id = ?")
      .bind(created.json.id)
      .first<{ actor: string }>();
    expect(row?.actor).toBe(`oauth:${client.client_id}`);

    const read = await callTool(request, tokens.access_token, "read_page", {
      id: created.json.id,
    });
    expect(read.json).toMatchObject({ title: "From Claude", body: "本文" });
  });

  it("REST の /api/* では OAuth のトークンを受け付けない", async () => {
    const { request } = setup();
    const { tokens } = await connect(request, "write");
    const headers = { Authorization: `Bearer ${tokens.access_token}` };
    expect((await request("/api/pages/recent", { headers })).status).toBe(401);
    expect((await request("/api/me", { headers })).status).toBe(401);
  });

  it("壊れた形や未発行のトークンは 401", async () => {
    const { request } = setup();
    await connect(request, "read");
    for (const token of ["owner:grant:secret", "a:b", "a:b:c:d"]) {
      const res = await postMcp(request, token, "tools/list");
      expect(res.status, token).toBe(401);
    }
  });

  it("api_tokens の Bearer は OAuth と並んで動き、actor は token: のまま", async () => {
    const { request } = setup();
    await connect(request, "write");
    const token = await insertToken({ name: "laptop", scopes: "read write" });
    const created = await callTool(request, token, "create_page", { title: "By Token", body: "" });
    expect(created.isError).toBe(false);
    const row = await env.DB.prepare("SELECT actor FROM revisions WHERE page_id = ?")
      .bind(created.json.id)
      .first<{ actor: string }>();
    expect(row?.actor).toBe("token:laptop");
  });
});

describe("OAUTH_KV が無い環境", () => {
  it("OAuth のエンドポイントは 404、/mcp の challenge は素の Bearer になる", async () => {
    const { request } = setup({ oauthKv: false });
    for (const [method, path] of [
      ["GET", "/.well-known/oauth-authorization-server"],
      ["GET", "/.well-known/oauth-protected-resource/mcp"],
      ["POST", "/_auth/oauth/token"],
      ["POST", "/_auth/oauth/register"],
      ["GET", "/_auth/oauth/authorize?response_type=code"],
    ] as const) {
      const res = await request(path, { method });
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    const owner = await request("/_auth/oauth/authorize", {
      headers: { Cookie: await ownerCookie(T0) },
    });
    expect(owner.status).toBe(404);

    const mcp = await postMcp(request, undefined, "tools/list");
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("KV があったときに発行したトークンは、KV を外すと 401 になり、api_tokens は動く", async () => {
    const withKv = setup();
    const { tokens } = await connect(withKv.request, "read");
    const { request } = setup({ oauthKv: false });
    expect((await postMcp(request, tokens.access_token, "tools/list")).status).toBe(401);
    const token = await insertToken({ name: "laptop", scopes: "read" });
    expect((await postMcp(request, token, "tools/list")).status).toBe(200);
  });
});
