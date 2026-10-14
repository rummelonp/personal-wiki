import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url)));

export default defineConfig({
  test: {
    projects: [
      {
        // src のテストは workerd の中で動かし、D1 も miniflare の実装を使う
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: migrations,
                // wrangler の設定を読むと手元の .dev.vars も入り、owner のログインの有無で結果が
                // 変わる。空で上書きして owner の経路を閉じた状態に揃え、要るテストは自分で渡す。
                ACCESS_TEAM_DOMAIN: "",
                ACCESS_AUD: "",
                OWNER_EMAILS: "",
                SESSION_SECRET: "",
              },
            },
          }),
        ],
        test: {
          name: "worker",
          include: ["src/**/*.test.ts"],
          setupFiles: ["./src/test/setup.ts"],
          // workerd 内のモジュールの読み込みが vitest 5 の fs module cache を読めず、キャッシュが
          // あると全ファイルが失敗する（@cloudflare/vitest-plugin 1.4.0 で確認）。
          fsModuleCache: false,
        },
      },
      {
        test: {
          name: "scripts",
          include: ["scripts/**/*.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});
