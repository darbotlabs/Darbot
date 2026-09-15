"use client";

import "./index.css";

// Re-export core (still a separate package)
export * from "@darbotlm/core";

// Re-export AG-UI client types (was done by V2 react's index.ts)
export * from "@ag-ui/client";

// Local V2 react code (absorbed into @darbotlm/react-core)
export * from "./components";
export * from "./hooks";
export * from "./providers";
export * from "./types";
export * from "./lib/react-core";
export { createA2UIMessageRenderer } from "./a2ui/A2UIMessageRenderer";
export type {
  A2UIMessageRendererOptions,
  A2UIUserAction,
  A2UIActionInterceptor,
} from "./a2ui/A2UIMessageRenderer";
export type { A2UIRecoveryRendererOptions } from "./a2ui/A2UIRecoveryStates";
export type { Theme as A2UITheme } from "@darbotlm/a2ui-renderer";
export { defaultTheme as a2uiDefaultTheme } from "@darbotlm/a2ui-renderer";

// V1 backward-compat re-exports
export { CopilotKit } from "../v1-deprecated/components/copilot-provider/copilotkit";
export type { CopilotKitProps } from "../v1-deprecated/components/copilot-provider/copilotkit-props";
