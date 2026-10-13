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
 * 認可の middleware はこの順で全ルートの前に登録する（理由は auth/middleware.ts）。
 * ルートは必ず `requireToken` などの宣言を 1 つ以上付けて登録する。
 */
export function createApp({ now = Date.now }: AppOptions = {}) {
  return new Hono<AppEnv>()
    .use("*", rejectAmbiguousCredentials)
    .use("*", resolvePrincipal({ now }))
    .use("*", enforceDeclaredPolicy)
    .get("/api/healthz", allowAnonymous(), (c) => c.json({ status: "ok" }));
}
