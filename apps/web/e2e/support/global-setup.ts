import { ownerApi } from "./api";
import { seed } from "./seed";
import { startStack } from "./stack";

/**
 * スタックを起動してデータを入れ、テストに要る値を環境変数で渡す（Playwright は global setup で
 * 足した環境変数を worker に引き継ぐ）。返す関数が teardown になる。
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const stack = await startStack();
  try {
    const ids = await seed(ownerApi(stack.origin, stack.sessionSecret));
    process.env.E2E_ORIGIN = stack.origin;
    process.env.E2E_SESSION_SECRET = stack.sessionSecret;
    process.env.E2E_SEED_IDS = JSON.stringify(ids);
  } catch (error) {
    await stack.stop();
    throw error;
  }
  return stack.stop;
}
