import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// エディタを含むコンポーネントのテストだけをここで動かす。CodeMirror は実 DOM の測定を使うので jsdom では
// 動かない。DOM を使わないテスト（*.test.ts）はリポジトリのルートの vitest が node で動かす。
export default defineConfig({
  plugins: [react()],
  test: {
    // 既定のサイト名を期待するテストが、シェルに残った VITE_SITE_NAME に左右されないよう空にする
    env: { VITE_SITE_NAME: "" },
    include: ["src/**/*.test.tsx"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
