import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts", "apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    // apps/worker のテストは workerd の中で、packages/editor のテストはブラウザの中で動かすので、
    // それぞれ自身の vitest.config.ts で実行する
    exclude: [...configDefaults.exclude, "apps/worker/**", "packages/editor/**"],
    // apps / packages にテストがまだない段階でも CI を通す
    passWithNoTests: true,
  },
});
