import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { readInitialPage } from "./initial-page";
import { preloadPageViewFor } from "./page-view-loader";
import { parseRoute } from "./route";
import { installScrollRestore } from "./scroll-restore";
import "./theme.css";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("#root がない");
installScrollRestore();
readInitialPage();
// /api/me のレスポンスを待つ間に、ページの画面（エディタ）も読み込んでおく。ページの URL では Worker が HTML の
// modulepreload で先に取り始めていて、ここの import はその module を使う。新規作成の画面や 404 のように
// modulepreload の無い HTML では、ここから取り始める
preloadPageViewFor(parseRoute(window.location.pathname, window.location.search));
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
