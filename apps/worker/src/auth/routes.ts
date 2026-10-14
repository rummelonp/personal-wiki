import type { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import type { AccessVerifier } from "./access";
import { allowAnonymous, clearStaleSession } from "./middleware";
import { OAUTH_AUTHORIZE_PATH, OAUTH_GRANTS_PATH } from "./oauth-server";
import { isOwnerEmail, readOwnerAuthConfig } from "./owner-config";
import {
  createSessionValue,
  SESSION_COOKIE_ATTRIBUTES,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
} from "./session";

export interface AuthRoutesOptions {
  now: () => number;
  accessVerifier: AccessVerifier;
}

const MAX_RETURN_LENGTH = 2048;

const RETURNABLE_AUTH_PATHS: ReadonlySet<string> = new Set([
  OAUTH_AUTHORIZE_PATH,
  OAUTH_GRANTS_PATH,
]);

/**
 * ログイン後に戻る先を、リクエストと同じオリジンの絶対 URL にして返す。同じオリジンの
 * パスと言えない値は `/` にする（open redirect を作らない）。
 * - `/` で始まり、2 文字目が `/` でも `\` でもないこと（`//evil` と `/\evil` はブラウザが別ホストと読む）
 * - `\` と制御文字を含まないこと（URL の解析で `/` に読み替えられたり、捨てられたりする）
 * - 解析後のオリジンが一致すること。Location には解析後の絶対 URL を返すので、`/.//evil` のように
 *   正規化で `//` から始まるパスになっても別ホストへは飛ばない
 * - `/_auth/` 以下に戻さない（ログインを繰り返さないため）。`/%5Fauth/login` のような符号化で
 *   すり抜けないよう、パスを復号してから判定し、復号できない値は拒む。例外は、owner のセッションを
 *   要る画面として /_auth/login を経由させる OAuth の同意画面と接続の一覧だけ
 */
export function safeReturnUrl(raw: string | undefined, origin: string): string {
  const fallback = `${origin}/`;
  if (raw === undefined || raw.length > MAX_RETURN_LENGTH) return fallback;
  if (!raw.startsWith("/") || raw[1] === "/" || raw[1] === "\\") return fallback;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を拒むための正規表現
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return fallback;
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return fallback;
  }
  if (url.origin !== origin) return fallback;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return fallback;
  }
  if (RETURNABLE_AUTH_PATHS.has(pathname)) return url.href;
  if (pathname === "/_auth" || pathname.startsWith("/_auth/")) return fallback;
  return url.href;
}

/**
 * `/_auth/login` と `/_auth/logout` と `/api/me` を登録する。
 *
 * `/_auth/login` だけが Cloudflare Access の対象で、Access を通ったリクエストには
 * `Cf-Access-Jwt-Assertion` が付く。Worker はこの JWT を自分で検証してから cookie を発行する
 * （Access の設定漏れや、Access を経由しない経路があっても cookie を出さないため）。
 */
export function registerAuthRoutes(app: Hono<AppEnv>, { now, accessVerifier }: AuthRoutesOptions) {
  return app
    .get("/_auth/login", allowAnonymous(), async (c) => {
      c.header("Cache-Control", "no-store");
      const config = readOwnerAuthConfig(c.env);
      if (config === null) {
        console.error(JSON.stringify({ event: "auth.login_unconfigured" }));
        return c.json({ error: "login_unavailable" }, 500);
      }
      const token = c.req.header("Cf-Access-Jwt-Assertion");
      if (token === undefined) return c.json({ error: "forbidden" }, 403);
      const result = await accessVerifier.verify({
        token,
        teamDomain: config.teamDomain,
        audience: config.audience,
      });
      if (!result.ok) {
        console.error(JSON.stringify({ event: "auth.login_rejected", reason: result.reason }));
        return c.json({ error: "forbidden" }, 403);
      }
      if (!isOwnerEmail(config, result.email)) {
        console.error(JSON.stringify({ event: "auth.login_rejected", reason: "not_owner" }));
        return c.json({ error: "forbidden" }, 403);
      }
      setCookie(c, SESSION_COOKIE_NAME, await createSessionValue(config, result.email, now()), {
        ...SESSION_COOKIE_ATTRIBUTES,
        maxAge: SESSION_TTL_SECONDS,
      });
      return c.redirect(safeReturnUrl(c.req.query("return"), new URL(c.req.url).origin), 302);
    })
    .post("/_auth/logout", allowAnonymous(), (c) => {
      // allowAnonymous はセッションを要らないという宣言で、CSRF の検査は外れない。cookie 付きの POST は
      // rejectCrossSiteCookieWrites が同一オリジンの JSON に限る（owner.test.ts に他 origin からの 403 の
      // 検査がある）。cookie が無い呼び出しは消すものが無く、副作用も無い
      deleteCookie(c, SESSION_COOKIE_NAME, SESSION_COOKIE_ATTRIBUTES);
      c.header("Cache-Control", "no-store");
      return c.body(null, 204);
    })
    .get("/api/me", allowAnonymous(), (c) => {
      c.header("Cache-Control", "no-store");
      // SPA は起動時にここで owner か匿名かを決める。検証できない cookie を消しておき、匿名の画面から
      // 続けて呼ぶページの読み取りが 401 にならないようにする
      clearStaleSession(c);
      const principal = c.get("principal");
      // 画面が、使えない機能（R2 の無い構成での画像の貼り付け）の導線を出さずに済むよう返す。
      // linkRewrites は step（POST /api/link-rewrites/step）がある版で常に true。画面は、項目が無い
      // 前の版の Worker では step を呼ばない
      const features = { attachments: c.env.BUCKET !== undefined, linkRewrites: true };
      switch (principal.kind) {
        case "owner":
          return c.json({ kind: "owner", features });
        case "token":
          return c.json({
            kind: "token",
            name: principal.name,
            scopes: principal.scopes,
            features,
          });
        case "anonymous":
          return c.json({ kind: "anonymous", features });
      }
    });
}
