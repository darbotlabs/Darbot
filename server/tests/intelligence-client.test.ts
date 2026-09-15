import { describe, expect, test } from "bun:test";
import { CopilotKitIntelligence } from "@darbotlm/runtime/v2";
import { createIntelligenceClient } from "../src/intelligence-client";

/**
 * The local `darbotlmIntelligence` binding, against the real package export.
 *
 * `intelligence-client.ts` (and `index.ts`, `copilot.ts`) import `@darbotlm/runtime/v2`'s
 * Intelligence class as `darbotlmIntelligence` — a local alias, not the package's own export name,
 * which remains `CopilotKitIntelligence` (the SDK's genuine, unrenamed identifier; see
 * `packages/runtime/src/v2/runtime/intelligence-platform/client.ts`). A prior mechanical rename
 * pass assumed the export itself had been renamed and left a bare `darbotlmIntelligence` import
 * that the real package has never had. Tested here against the real class and the real consumer
 * factory, not a hand-rolled fake: `routine-run-turn.test.ts` covers the surrounding turn logic
 * entirely through `as any` fakes and would not catch a binding drift like this one.
 */
describe("createIntelligenceClient against the real @darbotlm/runtime export", () => {
  test("the darbotlmIntelligence binding is the real CopilotKitIntelligence class", () => {
    const client = createIntelligenceClient({
      apiUrl: "https://intelligence.example.com",
      gatewayWsUrl: "wss://intelligence.example.com/runner",
      apiKey: "test-api-key",
    });

    expect(client).toBeInstanceOf(CopilotKitIntelligence);

    // The runner/lock surface `index.ts` and `routines/run-turn.ts` depend on must still be
    // present on the real class, not silently dropped by a stub or a mismatched export.
    expect(typeof client.ɵgetRunnerWsUrl).toBe("function");
    expect(typeof client.ɵgetRunnerAuthToken).toBe("function");
    expect(typeof client.ɵacquireThreadLock).toBe("function");
    expect(typeof client.ɵrenewThreadLock).toBe("function");
    expect(typeof client.ɵcleanupThreadLock).toBe("function");
    expect(typeof client.getOrCreateThread).toBe("function");
    expect(typeof client.getThreadMessages).toBe("function");
  });

  test("the runner URL and auth token are derived from configuration alone, with no network call", () => {
    const client = createIntelligenceClient({
      apiUrl: "https://intelligence.example.com",
      gatewayWsUrl: "wss://intelligence.example.com/runner",
      apiKey: "test-api-key",
    });

    // `IntelligenceAgentRunner` is constructed from exactly these two values (see index.ts and
    // copilot.ts's `runnerConnection()`); both are pure derivations from configuration, so they
    // can be asserted synchronously against the real class, with no live gateway involved.
    expect(client.ɵgetRunnerWsUrl()).toBe(
      "wss://intelligence.example.com/runner",
    );
    expect(client.ɵgetRunnerAuthToken()).toBe("test-api-key");
  });
});
