import { Hono } from "hono";
import {
  allowAnonymous,
  enforceDeclaredPolicy,
  rejectAmbiguousCredentials,
  resolvePrincipal,
} from "./auth/middleware";
import type { AppEnv } from "./env";

export interface AppOptions {
  /** UNIX エポックのミリ秒を返す時計。テストだけが差し替える。 */
  now?: () => number;
}

/**
 * 認可の middleware はこの順で全ルートの前に登録する（保証の範囲は auth/middleware.ts）。
 * ルートは `.get(path, requireToken("read"), handler)` のように、ハンドラと同じ path・同じ
 * 呼び出しで宣言を付けて登録する。宣言の無いハンドラにマッチしたリクエストは 404 になる。
 * 全ルートに効かせる middleware を足すときは defineBaseMiddleware で登録する。
 */
export function createApp({ now = Date.now }: AppOptions = {}) {
  return new Hono<AppEnv>()
    .notFound((c) => c.json({ error: "not_found" }, 404))
    .use("*", rejectAmbiguousCredentials)
    .use("*", resolvePrincipal({ now }))
    .use("*", enforceDeclaredPolicy)
    .get("/api/healthz", allowAnonymous(), (c) => c.json({ status: "ok" }));
}
