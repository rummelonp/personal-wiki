import { ownerApi } from "./api";
import { connectOAuthWriters, registerOAuthClient } from "./principals";
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
    // 同意画面を開くだけのテストが共有する client。Worker の登録は 1 日 20 件までなので、worker ごとには登録しない
    const consentClientId = await timed("OAuth の client", () =>
      registerOAuthClient(stack.origin, "Claude"),
    );
    // 履歴のテストが使う接続。繰り返し実行しても Worker の登録の上限に届かないよう、実行ごとに 1 回だけ作る
    process.env.E2E_OAUTH_WRITER_TOKENS = await timed("OAuth の接続", () =>
      connectOAuthWriters(stack.origin, stack.sessionSecret),
    );
    process.env.E2E_ORIGIN = stack.origin;
    process.env.E2E_CONSENT_CLIENT_ID = consentClientId;
    process.env.E2E_SESSION_SECRET = stack.sessionSecret;
    process.env.E2E_STACK_CONFIG = stack.configPath;
    process.env.E2E_STACK_STATE = stack.persistDir;
    process.env.E2E_SEED_IDS = JSON.stringify(ids);
  } catch (error) {
    await stack.stop();
    throw error;
  }
  const steps = setupTimings.map(({ label, ms }) => `${label} ${(ms / 1000).toFixed(1)} 秒`);
  console.log(`E2E の準備: ${steps.join("、")}`);
  return stack.stop;
}
