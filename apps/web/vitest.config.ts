import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// エディタを含む部品のテストだけをここで動かす。CodeMirror は実 DOM の測定を使うので jsdom では
// 動かない。DOM を使わないテスト（*.test.ts）はリポジトリのルートの vitest が node で動かす。
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/**/*.test.tsx"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
