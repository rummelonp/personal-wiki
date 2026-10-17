import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// CodeMirror は描画と座標計算に実 DOM の測定を使うので、jsdom では動かない。
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // 全ファイルを並べて流し、ほかの処理で CPU が詰まると、1 回の userEvent（Playwright の click や
    // keyboard）が数秒かかり、数百ミリ秒で済む test が既定の 15 秒を越える。待つ対象は正しいので、
    // 時間だけ広げる
    testTimeout: 30_000,
    // Editor は色と書体を CSS 変数で受け取るので、ホストが置く token を test にも置く
    setupFiles: ["./src/test-tokens.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
