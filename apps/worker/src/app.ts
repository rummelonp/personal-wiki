import { Hono } from "hono";
import { registerAttachmentRoutes } from "./attachments/routes";
import { createAccessVerifier } from "./auth/access";
import {
  allowAnonymous,
  enforceDeclaredPolicy,
  rejectAmbiguousCredentials,
  rejectCrossSiteCookieWrites,
  resolvePrincipal,
} from "./auth/middleware";
import { registerOAuthRoutes } from "./auth/oauth-routes";
import { registerAuthRoutes } from "./auth/routes";
import type { AppEnv } from "./env";
import { registerLlmsTxtRoutes } from "./llms-txt";
import { registerMcpRoutes } from "./mcp/server";
import { logWriteMetric, type WriteMetric } from "./pages/operations";
import { registerAdminRoutes, registerPageRoutes } from "./pages/routes";
import { securityHeaders } from "./security-headers";
import { registerSpaRoutes } from "./spa";

export interface AppOptions {
  /** UNIX エポックのミリ秒を返す時計。テストだけが差し替える。 */
  now?: () => number;
  /** 書き込み 1 回分の計測値の出力先。既定は Workers のログに JSON の 1 行で出す。 */
  recordWrite?: (metric: WriteMetric) => void;
  /** Access の JWKS の取得に使う fetch。テストだけが差し替える。 */
  accessFetch?: (url: string) => Promise<Response>;
}

/**
 * 認可の middleware はこの順で全ルートの前に登録する（保証の範囲は auth/middleware.ts）。
 * ルートは `.get(path, requireScope("read"), handler)` のように、ハンドラと同じ path、同じ
 * 呼び出しで宣言を付けて登録する。宣言の無いハンドラにマッチしたリクエストは 404 になる。
 * 全ルートに効かせる middleware を足すときは defineBaseMiddleware で登録する。
 * SPA の catch-all は最後に登録する。`/api` などの Worker のパス（paths.ts）は catch-all を素通りするので、
 * 後から足した API のルートも動く（spa.ts）。
 */
export function createApp({
  now = Date.now,
  recordWrite = logWriteMetric,
  accessFetch,
}: AppOptions = {}) {
  const accessVerifier = createAccessVerifier(
    accessFetch === undefined ? { now } : { now, fetch: accessFetch },
  );
  const app = new Hono<AppEnv>()
    .notFound((c) => c.json({ error: "not_found" }, 404))
    .use("*", securityHeaders)
    .use("*", rejectAmbiguousCredentials)
    .use("*", rejectCrossSiteCookieWrites)
    .use("*", resolvePrincipal({ now }))
    .use("*", enforceDeclaredPolicy)
    .get("/api/healthz", allowAnonymous(), (c) => c.json({ status: "ok" }));
  registerAuthRoutes(app, { now, accessVerifier });
  registerOAuthRoutes(app, { now });
  registerPageRoutes(app, { now, recordWrite });
  registerAttachmentRoutes(app, { now });
  registerAdminRoutes(app, { recordWrite });
  registerMcpRoutes(app, { now, recordWrite });
  registerLlmsTxtRoutes(app);
  registerSpaRoutes(app);
  return app;
}
