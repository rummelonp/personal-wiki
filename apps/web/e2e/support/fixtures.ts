import { test as base, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { type OwnerApi, ownerApi } from "./api";
import { addSessionCookie, mintSessionValue } from "./session";
import { OWNER_EMAIL } from "./stack";

export { expect };

function stackEnv(): { origin: string; sessionSecret: string; seedIds: Record<string, string> } {
  const { E2E_ORIGIN, E2E_SESSION_SECRET, E2E_SEED_IDS } = process.env;
  if (E2E_ORIGIN === undefined || E2E_SESSION_SECRET === undefined || E2E_SEED_IDS === undefined) {
    throw new Error("global setup が動いていない（playwright.config.ts から実行する）");
  }
  return {
    origin: E2E_ORIGIN,
    sessionSecret: E2E_SESSION_SECRET,
    seedIds: JSON.parse(E2E_SEED_IDS) as Record<string, string>,
  };
}

interface Fixtures {
  /** owner なら context に owner のセッション cookie を置く。 */
  role: "owner" | "anonymous";
  api: OwnerApi;
  /** seed.ts の title から id。 */
  seedIds: Record<string, string>;
}

export const test = base.extend<Fixtures>({
  role: ["owner", { option: true }],
  context: async ({ context, role, browserName }, use) => {
    if (role === "owner") {
      const { origin, sessionSecret } = stackEnv();
      await addSessionCookie(
        context,
        browserName,
        origin,
        mintSessionValue(sessionSecret, OWNER_EMAIL),
      );
    }
    await use(context);
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright の fixture は第 1 引数を分割代入で受ける
  api: async ({}, use) => {
    const { origin, sessionSecret } = stackEnv();
    await use(ownerApi(origin, sessionSecret));
  },
  // biome-ignore lint/correctness/noEmptyPattern: 同上
  seedIds: async ({}, use) => {
    await use(stackEnv().seedIds);
  },
});

/** 同じサーバーを projects と worker で共有するので、テストが作る title は実行ごとにずらす。 */
export function uniqueTitle(testInfo: TestInfo, label: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${label} ${testInfo.project.name}-${suffix}`;
}

export const bodyEditor = (page: Page): Locator => page.locator('.cm-content[aria-label="本文"]');
export const saveState = (page: Page): Locator => page.locator(".save-state");

/**
 * 本文の最後の行の末尾に caret を置いて打つ。最後の行は装飾の無い文字だけにしておく。
 * 文書の末尾へ飛ぶ組み合わせ（Ctrl/Cmd+End）は、アプリが UA で Mac かを決め、Desktop Chrome の
 * descriptor の UA が Windows なので、ブラウザによって効く修飾キーがずれる。行の末尾（End）で済ませる。
 */
export async function typeAtBodyEnd(page: Page, text: string): Promise<void> {
  await bodyEditor(page).locator(".cm-line").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

/** 横スクロールが出ていないこと。ずれた量が分かるよう、2 つの値をそのまま比べる。 */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  // 幅を変えた直後でも、変えた後の配置で測る
  const { scrollWidth, clientWidth } = await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
  expect(scrollWidth, "document の横幅が画面の幅を超えている").toBeLessThanOrEqual(clientWidth);
}
