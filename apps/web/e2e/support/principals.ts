import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { generateToken, hashToken, issueSql } from "../../../worker/scripts/api-token.mjs";
import { mintSessionValue, SESSION_COOKIE_NAME } from "./session";
import { OWNER_EMAIL, WORKER_DIR } from "./stack";

/*
 * owner 以外の書き手（API token と OAuth の接続）として書くための部品。履歴の作成者の表示を、
 * それぞれの経路で保存した版で確かめるのに使う。Worker の認証には手を入れず、本番と同じ入口を通す。
 * token は D1 に行を足して発行し、OAuth は登録、同意、コードの交換を /_auth/oauth/* に対して行う。
 */

const run = promisify(execFile);

function stackEnv(): { origin: string; sessionSecret: string; config: string; state: string } {
  const { E2E_ORIGIN, E2E_SESSION_SECRET, E2E_STACK_CONFIG, E2E_STACK_STATE } = process.env;
  if (
    E2E_ORIGIN === undefined ||
    E2E_SESSION_SECRET === undefined ||
    E2E_STACK_CONFIG === undefined ||
    E2E_STACK_STATE === undefined
  ) {
    throw new Error("global setup が動いていない（playwright.config.ts から実行する）");
  }
  return {
    origin: E2E_ORIGIN,
    sessionSecret: E2E_SESSION_SECRET,
    config: E2E_STACK_CONFIG,
    state: E2E_STACK_STATE,
  };
}

/**
 * 起動中の wrangler dev の D1 に api_tokens の行を足し、平文の token を返す。
 * 平文は発行時にしか得られないので、api-token.mjs の発行と同じ生成と hash を使う。
 */
export async function issueApiToken(name: string, scopes: "read" | "read write"): Promise<string> {
  const { config, state } = stackEnv();
  const token = generateToken();
  const sql = issueSql({ name, tokenHash: hashToken(token), scopes, now: Date.now() });
  // 動いている workerd と同じ SQLite に別のプロセスから書くので、ほかのテストの保存と重なると
  // SQLITE_BUSY で断られる。断られた INSERT は何も書いていないので、間を空けて同じ文を流し直す
  for (let attempt = 1; ; attempt++) {
    try {
      await run(
        join(WORKER_DIR, "node_modules/.bin/wrangler"),
        ["d1", "execute", "DB", "--local", "--persist-to", state, "-c", config, "--command", sql],
        { cwd: dirname(config), env: { ...process.env, CI: "1" } },
      );
      return token;
    } catch (error) {
      if (attempt >= 5 || !String(error).includes("SQLITE_BUSY")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

/** token で REST の更新を呼ぶ。Bearer の呼び出しには Origin の検査が掛からない */
export async function updatePageWithToken(
  token: string,
  page: { id: string; title: string; version: number },
  body: string,
): Promise<void> {
  const { origin } = stackEnv();
  const res = await fetch(`${origin}/api/pages/${page.id}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "If-Match": `"${page.version}"`,
    },
    body: JSON.stringify({ title: page.title, body }),
  });
  if (res.status !== 200) throw new Error(`PUT /api/pages/${page.id}: ${res.status}`);
}

// 登録できるリダイレクト先の既定（auth/oauth-registration.ts）。コードは受け取るだけで、アクセスしない
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function expectStatus(res: Response, status: number, what: string): Promise<Response> {
  if (res.status !== status) throw new Error(`${what}: ${res.status} ${await res.text()}`);
  return res;
}

/**
 * 接続の名前を名乗って登録し、owner として同意して、/mcp に使えるアクセストークンを返す。
 * 同意画面の POST は、画面を開いたときに付く binding の cookie と owner のセッションを両方求める。
 */
export async function connectOAuthClient(clientName: string): Promise<string> {
  const { origin, sessionSecret } = stackEnv();
  const registration = JSON.stringify({
    redirect_uris: [REDIRECT_URI],
    client_name: clientName,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
  const registered = await expectStatus(
    await fetch(`${origin}/_auth/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: registration,
    }),
    201,
    "OAuth の登録",
  );
  const { client_id: clientId } = (await registered.json()) as { client_id: string };

  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const authorizePath = `/_auth/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    state: "e2e",
    code_challenge: base64Url(new Uint8Array(digest)),
    code_challenge_method: "S256",
    scope: "read write",
    resource: `${origin}/mcp`,
  })}`;

  const session = `${SESSION_COOKIE_NAME}=${mintSessionValue(sessionSecret, OWNER_EMAIL)}`;
  const consent = await expectStatus(
    await fetch(`${origin}${authorizePath}`, { headers: { Cookie: session } }),
    200,
    "OAuth の同意画面",
  );
  const binding = consent.headers.getSetCookie()[0]?.split(";")[0];
  const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())?.[1];
  if (binding === undefined || handle === undefined) {
    throw new Error("同意画面に handle か binding の cookie が無い");
  }

  const approved = await fetch(`${origin}${authorizePath}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      Cookie: `${session}; ${binding}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
    },
    body: new URLSearchParams({ handle, decision: "approve", access: "write" }).toString(),
  });
  await expectStatus(approved, 302, "OAuth の同意");
  const code = new URL(approved.headers.get("Location") ?? "").searchParams.get("code");
  if (code === null) throw new Error("同意の応答にコードが無い");

  const exchanged = await expectStatus(
    await fetch(`${origin}/_auth/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    }),
    200,
    "OAuth のコードの交換",
  );
  return ((await exchanged.json()) as { access_token: string }).access_token;
}

/** OAuth のアクセストークンは /mcp だけで使える。update_page を 1 回呼ぶ */
export async function updatePageWithOAuth(
  accessToken: string,
  page: { id: string; title: string; version: number },
  body: string,
): Promise<void> {
  const { origin } = stackEnv();
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "update_page",
        arguments: { id: page.id, version: page.version, title: page.title, body },
      },
    }),
  });
  await expectStatus(res, 200, "MCP の update_page");
  const text = await res.text();
  // 応答は JSON か、1 件の SSE のどちらか
  const payload = text.startsWith("{")
    ? text
    : (text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length) ?? "null");
  const rpc = JSON.parse(payload) as { result?: { isError?: boolean } } | null;
  if (rpc?.result === undefined || rpc.result.isError === true) {
    throw new Error(`MCP の update_page が失敗した: ${text}`);
  }
}
