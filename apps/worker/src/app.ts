import { Hono } from "hono";
import {
  allowAnonymous,
  enforceDeclaredPolicy,
  rejectAmbiguousCredentials,
  resolvePrincipal,
} from "./auth/middleware";
import type { AppEnv } from "./env";
import { registerAdminRoutes, registerPageRoutes, type WriteMetric } from "./pages/routes";

export interface AppOptions {
  /** UNIX エポックのミリ秒を返す時計。テストだけが差し替える。 */
  now?: () => number;
  /** 書き込み 1 回分の計測値の出力先。既定は Workers のログに JSON の 1 行で出す。 */
  recordWrite?: (metric: WriteMetric) => void;
}

function logWriteMetric(metric: WriteMetric): void {
  console.log(JSON.stringify({ event: "pages.write", ...metric }));
}

/**
 * 認可の middleware はこの順で全ルートの前に登録する（保証の範囲は auth/middleware.ts）。
 * ルートは `.get(path, requireToken("read"), handler)` のように、ハンドラと同じ path・同じ
 * 呼び出しで宣言を付けて登録する。宣言の無いハンドラにマッチしたリクエストは 404 になる。
 * 全ルートに効かせる middleware を足すときは defineBaseMiddleware で登録する。
 */
export function createApp({ now = Date.now, recordWrite = logWriteMetric }: AppOptions = {}) {
  const app = new Hono<AppEnv>()
    .notFound((c) => c.json({ error: "not_found" }, 404))
    .use("*", rejectAmbiguousCredentials)
    .use("*", resolvePrincipal({ now }))
    .use("*", enforceDeclaredPolicy)
    .get("/api/healthz", allowAnonymous(), (c) => c.json({ status: "ok" }));
  registerPageRoutes(app, { now, recordWrite });
  registerAdminRoutes(app, { recordWrite });
  return app;
}
