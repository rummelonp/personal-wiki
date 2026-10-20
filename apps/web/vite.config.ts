import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";
import { pageViewPreload } from "./src/page-view-preload";
import { siteNameTitle } from "./src/site-name-title";

// 開発中は Worker（wrangler dev の既定のポート）へ API とログインを中継する。
// 本番は同じホストで Worker が配信するので、中継は要らない。
// 別のポートで wrangler dev を動かすとき（ポートの競合など）は WORKER_ORIGIN で指す。
const WORKER_ORIGIN = new URL(process.env.WORKER_ORIGIN ?? "http://localhost:8787").origin;

// Worker は cookie 付きの変更系に、Origin がリクエストの URL のオリジンと一致することを求める
// （apps/worker/src/auth/middleware.ts）。wrangler dev は URL のオリジンを Host から作る。
// target だけを書く短い形式は Host を Worker のものに書き換える（changeOrigin）が、Origin は
// ブラウザが付けた vite のオリジンのままなので、両者が食い違い書き込みが 403 で拒まれる。
// Worker の検査は緩めず、Host に合わせて Origin も Worker のオリジンに書き換える。
// 書き換えるのは vite 自身のオリジンから来たリクエストだけで、他のオリジンから来たものは Worker に拒ませる。
// Sec-Fetch-Site はブラウザが vite に対して付けた same-origin のまま通り、これも検査を満たす。
const toWorker: ProxyOptions = {
  target: WORKER_ORIGIN,
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on("proxyReq", (proxyReq, req) => {
      if (req.headers.origin === `http://${req.headers.host}`) {
        proxyReq.setHeader("origin", WORKER_ORIGIN);
      }
    });
  },
};

// サイト名は、bundle に埋める値（src/site-name.ts）と `<title>` を同じ環境変数から決める。
// Vite は apps/web/.env* の VITE_SITE_NAME も bundle に読み込むので、define で上書きして、
// `<title>` と Worker の SITE_NAME（deploy.mjs が同じ値を渡す）と値が分かれないようにする。
const SITE_NAME = process.env.VITE_SITE_NAME?.trim() ?? "";

export default defineConfig({
  plugins: [react(), siteNameTitle(SITE_NAME), pageViewPreload("src/PageView.tsx")],
  define: { "import.meta.env.VITE_SITE_NAME": JSON.stringify(SITE_NAME) },
  server: {
    proxy: {
      "/api": toWorker,
      "/_auth": toWorker,
    },
  },
});
