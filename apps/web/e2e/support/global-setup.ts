import { ownerApi } from "./api";
import { seed } from "./seed";
import { setupTimings, startStack, timed } from "./stack";

/**
 * スタックを起動してデータを入れ、テストに要る値を環境変数で渡す（Playwright は global setup で
 * 足した環境変数を worker に引き継ぐ）。返す関数が teardown になる。
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const stack = await startStack();
  try {
    const ids = await timed("seed", () => seed(ownerApi(stack.origin, stack.sessionSecret)));
    process.env.E2E_ORIGIN = stack.origin;
    process.env.E2E_SESSION_SECRET = stack.sessionSecret;
    process.env.E2E_SEED_IDS = JSON.stringify(ids);
  } catch (error) {
    await stack.stop();
    throw error;
  }
  const steps = setupTimings.map(({ label, ms }) => `${label} ${(ms / 1000).toFixed(1)} 秒`);
  console.log(`E2E の準備: ${steps.join("、")}`);
  return stack.stop;
}
