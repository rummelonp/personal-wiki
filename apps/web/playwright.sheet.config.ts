import { defineConfig, devices } from "@playwright/test";
import { E2E_ORIGIN } from "./e2e/support/stack";

/*
 * 画面の一覧（e2e/sheet/run.mjs から起動する）。画面と状態ごとに、明暗 × 幅 375、768、1280 の
 * スクリーンショットを撮る。比べる基準の画像は持たず、人が見て崩れを探すためのもの。
 */

const WIDTHS = [
  { width: 375, height: 812, mobile: true },
  { width: 768, height: 1024, mobile: false },
  { width: 1280, height: 800, mobile: false },
];
const SCHEMES = ["light", "dark"] as const;

export default defineConfig({
  testDir: "./e2e/sheet",
  testMatch: "**/*.sheet.ts",
  outputDir: "./e2e-output/sheet-results",
  globalSetup: "./e2e/support/global-setup.ts",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: 4,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { baseURL: E2E_ORIGIN },
  projects: SCHEMES.flatMap((colorScheme) =>
    WIDTHS.map(({ width, height, mobile }) => ({
      name: `${colorScheme}-${width}`,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width, height },
        deviceScaleFactor: 1,
        isMobile: mobile,
        hasTouch: mobile,
        colorScheme,
      },
    })),
  ),
});
