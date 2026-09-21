import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bootstrapTheme } from "./copilot-preferences";
import "./styles.css";

// Applied before the first paint so the window never flashes the wrong theme.
bootstrapTheme();

const root = document.getElementById("root");
if (!root)
  throw new Error("index.html has no #root for the window to render into.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
