import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// CodeMirror は描画と座標計算に実 DOM の測定を使うので、jsdom では動かない。
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
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
