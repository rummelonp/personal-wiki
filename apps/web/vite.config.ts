import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 開発中は Worker（wrangler dev の既定のポート）へ API とログインを中継する。
// 本番は同じホストで Worker が配信するので、中継は要らない。
const WORKER_ORIGIN = "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": WORKER_ORIGIN,
      "/_auth": WORKER_ORIGIN,
    },
  },
});
