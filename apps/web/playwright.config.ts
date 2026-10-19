import { defineConfig, devices } from "@playwright/test";
import { E2E_ORIGIN } from "./e2e/support/stack";

/*
 * 主の環境（デスクトップの Chromium、iPhone 幅の WebKit）ではすべてのテストを、従の環境では
 * @smoke を付けたテストだけを走らせる。速さの計測（@perf）は、他のテストと CPU を取り合わないよう
 * 機能のテストがすべて終わった後に走らせる。
 * Tab の移動先をエンジンごとに確かめるテスト（@keyboard）は、WebKit のデスクトップでも走らせる。
 * 幅を変えて調べるテスト（@widths）は、幅を自分で切り替えるのでデスクトップの Chromium だけで走らせる。
 */

const PRIMARY = ["chromium-desktop", "webkit-iphone"];
const SECONDARY = ["firefox-desktop", "chromium-android", "webkit-desktop"];

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  testIgnore: "sheet/**",
  outputDir: "./e2e-output/test-results",
  globalSetup: "./e2e/support/global-setup.ts",
  fullyParallel: true,
  forbidOnly: true,
  // 不安定なテストを再試行で隠さない
  retries: 0,
  // 1 つの wrangler dev を全 worker で共有するので、並列の数を抑える
  workers: 4,
  timeout: 60_000,
  // 自動保存は入力が止まって 2 秒後に走るので、保存の完了を待つ expect には余裕を持たせる
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { outputFolder: "./e2e-output/report", open: "never" }]],
  use: {
    baseURL: E2E_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
      grepInvert: /@perf/,
    },
    {
      name: "webkit-iphone",
      use: { ...devices["iPhone 15"] },
      grepInvert: /@perf|@widths/,
    },
    {
      name: "firefox-desktop",
      use: { ...devices["Desktop Firefox"], viewport: { width: 1280, height: 800 } },
      grep: /@smoke/,
    },
    {
      name: "chromium-android",
      use: { ...devices["Pixel 7"] },
      grep: /@smoke/,
    },
    {
      name: "webkit-desktop",
      use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } },
      grep: /@smoke|@keyboard/,
    },
    {
      name: "perf-chromium-desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
      grep: /@perf/,
      dependencies: [...PRIMARY, ...SECONDARY],
    },
    {
      name: "perf-webkit-iphone",
      use: { ...devices["iPhone 15"] },
      grep: /@perf/,
      // 計測どうしも重ねない
      dependencies: ["perf-chromium-desktop"],
    },
  ],
});
