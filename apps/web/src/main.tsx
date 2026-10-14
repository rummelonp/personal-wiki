import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installScrollRestore } from "./scroll-restore";
import "./theme.css";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("#root がない");
installScrollRestore();
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
