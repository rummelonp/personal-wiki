import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import type { Bindings } from "../env";
import { fakeJwks, generateSigningKey, ownerCookie, ownerEnv, signAccessJwt } from "../test/owner";
import { T0 } from "../test/pages";
import { insertApiToken, insertToken } from "../test/tokens";
import { encodeBase64Url } from "./base64url";
import { consentPage, describeRegistration, registrationTimeOf } from "./oauth-routes";
import { oauthServerFor } from "./oauth-server";
import { safeReturnUrl } from "./routes";

const ORIGIN = "http://localhost";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const RESOURCE_METADATA_URL = `${ORIGIN}/.well-known/oauth-protected-resource/mcp`;
const SAME_ORIGIN = { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" };
const FORM = "application/x-www-form-urlencoded";

function setup({
  oauthKv = true,
  overrides = {},
  now = () => T0,
}: {
  oauthKv?: boolean;
  overrides?: Partial<Bindings>;
  now?: () => number;
} = {}) {
  const app = createApp({ now });
  const bindings = ownerEnv(overrides);
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

// 登録は Content-Length を必須にする。fetch は付けるが、app.request に文字列を渡しても付かない
function jsonHeaders(body: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Content-Length": String(new TextEncoder().encode(body).byteLength),
  };
}

async function register(request: Request, metadata: Record<string, unknown> = {}) {
  const body = JSON.stringify({
    redirect_uris: [CALLBACK],
    client_name: "Claude",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    ...metadata,
  });
  const res = await request("/_auth/oauth/register", {
    method: "POST",
    headers: jsonHeaders(body),
    body,
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

/** `<title>` と `<h1>` が同じ見出しで、本文が message であること */
function expectErrorPage(html: string, heading: string, message: string) {
  expect(html).toContain(`<title>${heading}</title>`);
  expect(html).toContain(`<h1>${heading}</h1>`);
  expect(html).toContain(`<p>${message}</p>`);
}

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
async function connect(
  request: Request,
  access: "read" | "write",
  {
    client: existing,
    tokenParams = {},
  }: { client?: RegisteredClient; tokenParams?: Record<string, string> } = {},
) {
  const client = existing ?? (await register(request));
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
    ...tokenParams,
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

  function postRegistration(
    request: Request,
    body: string,
    headers: Record<string, string | null> = {},
  ) {
    const merged: Record<string, string | null> = { ...jsonHeaders(body), ...headers };
    return request("/_auth/oauth/register", {
      method: "POST",
      headers: Object.fromEntries(
        Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== null),
      ),
      body,
    });
  }

  async function registeredClientCount() {
    if (env.OAUTH_KV === undefined) throw new Error("テストの環境に OAUTH_KV が無い");
    return (await env.OAUTH_KV.list({ prefix: "client:" })).keys.length;
  }

  it("許可リストに無い redirect URI は、KV に書く前に断る", async () => {
    const { request } = setup();
    for (const redirectUris of [
      ["https://evil.example/cb"],
      ["http://127.0.0.1:8765/callback"],
      ["https://claude.ai/api/mcp/auth_callback/"],
      [CALLBACK, "https://evil.example/cb"],
      [],
    ]) {
      const res = await postRegistration(
        request,
        JSON.stringify({ redirect_uris: redirectUris, client_name: "x" }),
      );
      expect(res.status, JSON.stringify(redirectUris)).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_client_metadata" });
    }
    expect(await registeredClientCount()).toBe(0);
  });

  it("OAUTH_REDIRECT_URIS で足した redirect URI は登録できる", async () => {
    const { request } = setup({
      overrides: {
        OAUTH_REDIRECT_URIS: " https://other.example/cb , http://127.0.0.1:8765/callback",
      },
    });
    await register(request, { redirect_uris: ["https://other.example/cb"] });
    await register(request, { redirect_uris: ["http://127.0.0.1:8765/callback", CALLBACK] });
    expect(await registeredClientCount()).toBe(2);
  });

  it("Content-Length が無い、上限を超える、申告と合わない登録は、ライブラリに渡す前に断る", async () => {
    const { request } = setup();
    const small = JSON.stringify({ redirect_uris: [CALLBACK], client_name: "x" });
    const large = JSON.stringify({ redirect_uris: [CALLBACK], padding: "a".repeat(4096) });

    const missing = await postRegistration(request, small, { "Content-Length": null });
    expect(missing.status).toBe(411);
    expect(await missing.json()).toMatchObject({ error: "invalid_request" });

    const malformed = await postRegistration(request, small, { "Content-Length": "12abc" });
    expect(malformed.status).toBe(400);

    // 申告が上限を超えれば、本文が小さくても断る
    const declaredLarge = await postRegistration(request, small, { "Content-Length": "4097" });
    expect(declaredLarge.status).toBe(413);

    // 申告を偽って大きな本文を送っても、読むのを上限で打ち切る
    const lying = await postRegistration(request, large, { "Content-Length": "100" });
    expect(lying.status).toBe(413);
    const lyingAtLimit = await postRegistration(request, large, { "Content-Length": "4096" });
    expect(lyingAtLimit.status).toBe(413);

    const mismatch = await postRegistration(request, small, {
      "Content-Length": String(small.length + 10),
    });
    expect(mismatch.status).toBe(400);

    expect(await registeredClientCount()).toBe(0);
  });

  it("大きすぎる body と長すぎる client_name は断る", async () => {
    const { request } = setup();
    const large = await postRegistration(
      request,
      JSON.stringify({ redirect_uris: [CALLBACK], client_name: "x", padding: "a".repeat(4096) }),
    );
    expect(large.status).toBe(413);
    const longName = await postRegistration(
      request,
      JSON.stringify({ redirect_uris: [CALLBACK], client_name: "あ".repeat(101) }),
    );
    expect(longName.status).toBe(400);
    expect(await registeredClientCount()).toBe(0);
    const client = await register(request, { client_name: "あ".repeat(100) });
    expect(client.client_name).toBe("あ".repeat(100));
  });

  it("1 日（UTC）の登録数が上限に達したら 429 にし、断った登録は数えない", async () => {
    let now = T0;
    const { request } = setup({ now: () => now });
    const rejected = await postRegistration(
      request,
      JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }),
    );
    expect(rejected.status).toBe(400);
    for (let i = 0; i < 20; i++) await register(request);
    const over = await postRegistration(request, JSON.stringify({ redirect_uris: [CALLBACK] }));
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ error: "temporarily_unavailable" });
    expect(await registeredClientCount()).toBe(20);

    now = T0 + 24 * 60 * 60 * 1000;
    await register(request);
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
    expect(html).toContain(`client_id: <code>${client.client_id}</code>`);
  });

  it("redirect の種類にかかわらず自分で始めた接続だけを許可する警告と、client の登録時刻を出す", async () => {
    const { request } = setup();
    const client = await register(request, { client_name: "<b>x</b>" });
    const path = authorizePath(client.client_id, (await pkcePair()).challenge);
    const { html } = await openConsent(request, path);
    expect(html).toContain("この接続を、いま自分で始めた場合だけ許可してください");
    expect(html).toContain("他の人から送られたリンクで開いた場合は、許可しないでください");
    expect(html).toMatch(/<dt>登録<\/dt>\s*<dd>[^<]*（\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC）/);
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("このコンピュータ上のアプリ");
  });

  it("loopback の redirect には、自分で始めた場合の警告に加えてローカルのアプリの警告を出す", async () => {
    const { request } = setup({ overrides: { OAUTH_REDIRECT_URIS: "http://127.0.0.1:8765/cb" } });
    const client = await register(request, { redirect_uris: ["http://127.0.0.1:8765/cb"] });
    const path = authorizePath(client.client_id, (await pkcePair()).challenge, {
      redirect_uri: "http://127.0.0.1:8765/cb",
    });
    const { html } = await openConsent(request, path);
    expect(html).toContain("このコンピュータ上のアプリ");
    expect(html).toContain("この接続を、いま自分で始めた場合だけ許可してください");
  });

  it("権限の既定は write を要求されても read にし、長い client 名は切って見せる", async () => {
    const { request } = setup();
    const client = await register(request, { client_name: "あ".repeat(100) });
    const path = authorizePath(client.client_id, (await pkcePair()).challenge);
    const { html } = await openConsent(request, path);
    expect(html).toContain('value="read" checked');
    expect(html).not.toContain('value="write" checked');
    expect(html).toContain(`${"あ".repeat(40)}…`);
    expect(html).not.toContain("あ".repeat(41));
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

  it("PKCE の無い要求と plain の PKCE は、client_secret を持つ client でも同意画面を出さずに戻す", async () => {
    const { request } = setup();
    const session = await ownerCookie(T0);
    for (const authMethod of ["none", "client_secret_basic"]) {
      const client = await register(request, { token_endpoint_auth_method: authMethod });
      const withoutPkce = new URL(authorizePath(client.client_id, ""), ORIGIN);
      withoutPkce.searchParams.delete("code_challenge");
      withoutPkce.searchParams.delete("code_challenge_method");
      for (const path of [
        withoutPkce.pathname + withoutPkce.search,
        authorizePath(client.client_id, "x".repeat(43), { code_challenge_method: "plain" }),
        authorizePath(client.client_id, ""),
      ]) {
        const res = await request(path, { headers: { Cookie: session } });
        expect(res.status, `${authMethod} ${path}`).toBe(302);
        const location = new URL(res.headers.get("Location") ?? "");
        expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
        expect(location.searchParams.get("error")).toBe("invalid_request");
        expect(location.searchParams.get("state")).toBe("state-1");
        expect(res.headers.get("Set-Cookie")).toBeNull();
      }
    }
  });

  it("同意画面を開いた後で client の登録が消えたら、送信にこの画面で誤りを出す", async () => {
    const { request } = setup();
    const client = await register(request);
    const path = authorizePath(client.client_id, (await pkcePair()).challenge);
    const consent = await openConsent(request, path);
    const bindings = ownerEnv();
    await oauthServerFor(bindings, ORIGIN).getOAuthApi(bindings).deleteClient(client.client_id);
    const res = await submitConsent(request, path, consent);
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
    expect(await res.text()).toContain("登録が見つかりません");
  });

  it("handle を含まない送信は、既定の見出しの誤りにする", async () => {
    const { request } = setup();
    const client = await register(request);
    const path = authorizePath(client.client_id, (await pkcePair()).challenge);
    const consent = await openConsent(request, path);
    const res = await request(path, {
      method: "POST",
      headers: { Cookie: consent.cookie, "Content-Type": FORM, ...SAME_ORIGIN },
      body: new URLSearchParams({ decision: "approve", access: "write" }).toString(),
    });
    expect(res.status).toBe(400);
    expectErrorPage(await res.text(), "接続できません", "送信の内容を読み取れませんでした。");
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

describe("ログインを経由した認可", () => {
  it("owner のセッションが無い認可の要求は、Access のログインを経て同意画面に戻る", async () => {
    const key = await generateSigningKey("key-1");
    const app = createApp({ now: () => T0, accessFetch: fakeJwks([key]).fetch });
    const bindings = ownerEnv();
    const request: Request = (path, init = {}) => app.request(path, init, bindings);
    const client = await register(request);
    const path = authorizePath(client.client_id, (await pkcePair()).challenge);

    const toLogin = await request(path);
    expect(toLogin.status).toBe(302);
    const login = await request(toLogin.headers.get("Location") ?? "", {
      headers: { "Cf-Access-Jwt-Assertion": await signAccessJwt(key, T0) },
    });
    expect(login.status).toBe(302);
    expect(login.headers.get("Location")).toBe(`${ORIGIN}${path}`);
    const session = login.headers.get("Set-Cookie")?.split(";")[0] ?? "";

    const consent = await request(path, { headers: { Cookie: session } });
    expect(consent.status).toBe(200);
    expect(await consent.text()).toContain('name="handle"');
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

  it("resource に /mcp の URL を付けた交換と更新を受け付ける", async () => {
    const { request } = setup();
    const resource = `${ORIGIN}/mcp`;
    const { client, tokens } = await connect(request, "read", { tokenParams: { resource } });
    expect((await postMcp(request, tokens.access_token, "tools/list")).status).toBe(200);
    const refreshed = await postToken(request, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
      resource,
    });
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    const next = await refreshed.json<TokenResponse>();
    expect((await postMcp(request, next.access_token, "tools/list")).status).toBe(200);
  });

  it("/mcp と一致しない resource は invalid_target にする", async () => {
    const { request } = setup();
    const client = await register(request);
    const { verifier, challenge } = await pkcePair();
    const path = authorizePath(client.client_id, challenge);
    const approved = await submitConsent(request, path, await openConsent(request, path));
    const code = new URL(approved.headers.get("Location") ?? "").searchParams.get("code") ?? "";
    const res = await postToken(request, {
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: `${ORIGIN}/mcp/`,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_target" });

    const connected = await connect(request, "read");
    const refreshed = await postToken(request, {
      grant_type: "refresh_token",
      refresh_token: connected.tokens.refresh_token,
      client_id: connected.client.client_id,
      resource: `${ORIGIN}/mcp/`,
    });
    expect(refreshed.status).toBe(400);
    expect(await refreshed.json()).toMatchObject({ error: "invalid_target" });
  });

  it("read の grant は、write を求めて更新しても read のまま", async () => {
    const { request } = setup();
    const { client, tokens } = await connect(request, "read");
    const refreshed = await postToken(request, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
      scope: "read write",
    });
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    const next = await refreshed.json<TokenResponse>();
    expect(next.scope).toBe("read");
    const denied = await callTool(request, next.access_token, "create_page", {
      title: "x",
      body: "",
    });
    expect(denied).toEqual({
      isError: true,
      json: { error: "forbidden", message: "この token には write の scope が無い" },
    });
  });

  it("同じ client を許可し直すと、以前のトークンは使えなくなる", async () => {
    const { request } = setup();
    const first = await connect(request, "write");
    const second = await connect(request, "read", { client: first.client });
    expect((await postMcp(request, first.tokens.access_token, "tools/list")).status).toBe(401);
    const refreshed = await postToken(request, {
      grant_type: "refresh_token",
      refresh_token: first.tokens.refresh_token,
      client_id: first.client.client_id,
    });
    expect(refreshed.status).toBe(400);
    expect((await postMcp(request, second.tokens.access_token, "tools/list")).status).toBe(200);
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

  describe("期限", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("期限切れのアクセストークンは、resource_metadata 付きの challenge で 401 にする", async () => {
      const { request } = setup();
      const { tokens } = await connect(request, "read");
      expect((await postMcp(request, tokens.access_token, "tools/list")).status).toBe(200);
      // ライブラリはトークンの期限を Date.now で判定する
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + (3600 + 1) * 1000);
      const res = await postMcp(request, tokens.access_token, "tools/list");
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe(
        `Bearer realm="OAuth", resource_metadata="${RESOURCE_METADATA_URL}"`,
      );
    });
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
    const { token, id } = await insertApiToken({ name: "laptop", scopes: "read write" });
    const created = await callTool(request, token, "create_page", { title: "By Token", body: "" });
    expect(created.isError).toBe(false);
    const row = await env.DB.prepare("SELECT actor FROM revisions WHERE page_id = ?")
      .bind(created.json.id)
      .first<{ actor: string }>();
    expect(row?.actor).toBe(`token:${id}:laptop`);
  });
});

describe("許可した接続の一覧と取り消し", () => {
  async function openGrants(request: Request) {
    const res = await request("/_auth/oauth/grants", {
      headers: { Cookie: await ownerCookie(T0) },
    });
    expect(res.status).toBe(200);
    return { res, html: await res.text() };
  }

  function grantIdsOf(html: string): string[] {
    return [...html.matchAll(/name="grant" value="([^"]+)"/g)].map((m) => m[1] ?? "");
  }

  async function revoke(request: Request, grant: string, headers = SAME_ORIGIN) {
    return request("/_auth/oauth/grants/revoke", {
      method: "POST",
      headers: { Cookie: await ownerCookie(T0), "Content-Type": FORM, ...headers },
      body: new URLSearchParams({ grant }).toString(),
    });
  }

  it("一覧の続きの位置が読めなければ、一覧を開けない見出しの誤りにする", async () => {
    const { request } = setup();
    const res = await request("/_auth/oauth/grants?cursor=%00%00", {
      headers: { Cookie: await ownerCookie(T0) },
    });
    expect(res.status).toBe(400);
    expectErrorPage(
      await res.text(),
      "許可した接続の一覧を開けません",
      "一覧の続きを開けませんでした。",
    );
  });

  it("owner でなければ、一覧を return に入れて /_auth/login へ送る", async () => {
    const { request } = setup();
    const res = await request("/_auth/oauth/grants");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "", ORIGIN);
    expect(location.pathname).toBe("/_auth/login");
    expect(location.searchParams.get("return")).toBe("/_auth/oauth/grants");
    expect(safeReturnUrl("/_auth/oauth/grants", ORIGIN)).toBe(`${ORIGIN}/_auth/oauth/grants`);
  });

  it("owner には client 名、client_id、権限を見せ、フレームと保存を禁じる", async () => {
    const { request } = setup();
    const { client } = await connect(request, "read");
    const { res, html } = await openGrants(request);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(html).toContain("<strong>Claude</strong>");
    expect(html).toContain(`client_id: <code>${client.client_id}</code>`);
    expect(html).toContain("権限: read<br>");
    expect(grantIdsOf(html)).toHaveLength(1);
  });

  it("取り消すと、その接続のアクセストークンと更新トークンだけが使えなくなる", async () => {
    const { request } = setup();
    const { client, tokens } = await connect(request, "write");
    const other = await connect(request, "read");
    const bindings = ownerEnv();
    const { items } = await oauthServerFor(bindings, ORIGIN)
      .getOAuthApi(bindings)
      .listUserGrants("owner");
    const grant = items.find((item) => item.clientId === client.client_id)?.id ?? "";
    expect(grantIdsOf((await openGrants(request)).html).sort()).toEqual(
      items.map((item) => item.id).sort(),
    );

    const res = await revoke(request, grant);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/_auth/oauth/grants");
    expect((await postMcp(request, tokens.access_token, "tools/list")).status).toBe(401);
    const refreshed = await postToken(request, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    });
    expect(refreshed.status).toBe(400);
    expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });
    expect((await postMcp(request, other.tokens.access_token, "tools/list")).status).toBe(200);
    expect(grantIdsOf((await openGrants(request)).html)).not.toContain(grant);
  });

  it("別のオリジンからの送信、owner でない送信、読めない grant の id は受け付けない", async () => {
    const { request } = setup();
    const { tokens } = await connect(request, "read");
    const [grant = ""] = grantIdsOf((await openGrants(request)).html);
    const crossSite = await revoke(request, grant, {
      Origin: "https://evil.example",
      "Sec-Fetch-Site": "cross-site",
    });
    expect(crossSite.status).toBe(403);
    const anonymous = await request("/_auth/oauth/grants/revoke", {
      method: "POST",
      headers: { "Content-Type": FORM, ...SAME_ORIGIN },
      body: new URLSearchParams({ grant }).toString(),
    });
    expect(anonymous.status).toBe(401);
    for (const bad of ["", "a:b", "x".repeat(65)]) {
      const res = await revoke(request, bad);
      expect(res.status, bad).toBe(400);
      expectErrorPage(
        await res.text(),
        "取り消せません",
        "どの接続を取り消すかを読み取れませんでした。",
      );
    }
    expect((await postMcp(request, tokens.access_token, "tools/list")).status).toBe(200);
  });
});

describe("OAuth を閉じた環境", () => {
  async function expectOAuthClosed(request: Request) {
    for (const [method, path] of [
      ["GET", "/.well-known/oauth-authorization-server"],
      ["GET", "/.well-known/oauth-protected-resource/mcp"],
      ["POST", "/_auth/oauth/token"],
      ["POST", "/_auth/oauth/register"],
      ["GET", "/_auth/oauth/authorize?response_type=code"],
      ["GET", "/_auth/oauth/grants"],
    ] as const) {
      const res = await request(path, { method });
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    const mcp = await postMcp(request, undefined, "tools/list");
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("WWW-Authenticate")).toBe("Bearer");
  }

  it("OAUTH_KV が無ければ、OAuth のエンドポイントは 404、/mcp の challenge は素の Bearer になる", async () => {
    const { request } = setup({ oauthKv: false });
    await expectOAuthClosed(request);
    const cookie = await ownerCookie(T0);
    expect((await request("/_auth/oauth/authorize", { headers: { Cookie: cookie } })).status).toBe(
      404,
    );
    expect((await request("/_auth/oauth/grants", { headers: { Cookie: cookie } })).status).toBe(
      404,
    );
    const revoke = await request("/_auth/oauth/grants/revoke", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": FORM, ...SAME_ORIGIN },
      body: "grant=x",
    });
    expect(revoke.status).toBe(404);
  });

  it("owner のログインの設定が欠けていれば、OAUTH_KV があっても閉じる", async () => {
    for (const overrides of [{ SESSION_SECRET: "" }, { ACCESS_AUD: "" }, { OWNER_EMAILS: "" }]) {
      const { request } = setup({ overrides });
      await expectOAuthClosed(request);
    }
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

describe("describeRegistration", () => {
  const registeredAt = Date.UTC(2026, 9, 1, 12, 34, 56);
  const minute = 60_000;

  it("経過時間を分、時間、日で表し、UTC の日時を添える", () => {
    const utc = "（2026-10-01 12:34 UTC）";
    for (const [elapsed, label] of [
      [10_000, "1 分以内"],
      [3 * minute, "3 分前"],
      [59 * minute, "59 分前"],
      [60 * minute, "1 時間前"],
      [23 * 60 * minute, "23 時間前"],
      [24 * 60 * minute, "1 日前"],
      [40 * 24 * 60 * minute, "40 日前"],
    ] as const) {
      expect(describeRegistration(registeredAt, registeredAt + elapsed), label).toBe(
        `${label}${utc}`,
      );
    }
  });

  it("時計のずれで登録が未来になっても 1 分以内に丸める", () => {
    expect(describeRegistration(registeredAt, registeredAt - 5 * minute)).toBe(
      "1 分以内（2026-10-01 12:34 UTC）",
    );
  });
});

describe("同意画面の登録の行", () => {
  const consent = {
    clientId: "c1",
    clientName: "Claude",
    redirectUri: CALLBACK,
    redirectHost: "claude.ai",
    redirectIsLoopback: false,
    scope: ["read"],
  };
  const lookingUp = (registrationDate: unknown) => ({
    lookupClient: async () => ({ registrationDate }) as never,
  });

  it("登録の時刻を読めたときだけ返す", async () => {
    expect(await registrationTimeOf(lookingUp(1_790_000_000), consent)).toBe(1_790_000_000_000);
  });

  it("記録が無い、lookup が失敗する、値が数でない、Date で表せないときは null にする", async () => {
    const failing = {
      lookupClient: async () => {
        throw new Error("kv unavailable");
      },
    };
    const missing = { lookupClient: async () => null };
    for (const oauth of [
      failing,
      missing,
      lookingUp(undefined),
      lookingUp("1790000000"),
      lookingUp(Number.NaN),
      lookingUp(Number.POSITIVE_INFINITY),
      lookingUp(1e13),
    ]) {
      expect(await registrationTimeOf(oauth, consent)).toBeNull();
    }
  });

  it("CIMD の client（clientDomain がある）は、時刻を読めても null にする", async () => {
    const cimd = { ...consent, clientDomain: "client.example" };
    expect(await registrationTimeOf(lookingUp(1_790_000_000), cimd)).toBeNull();
  });

  it("registeredAt が null なら登録の行を出さず、あれば出す", () => {
    const without = consentPage(consent, "h", { registeredAt: null, now: T0 });
    expect(without).not.toContain("<dt>登録</dt>");
    expect(without).toContain("<dt>要求された権限</dt>");
    const withRow = consentPage(consent, "h", {
      registeredAt: T0 - 35 * 24 * 60 * 60_000,
      now: T0,
    });
    expect(withRow).toContain("<dt>登録</dt>");
    expect(withRow).toContain("35 日前");
    expect(withRow).toContain("切れた接続をつなぎ直したなら");
  });
});
