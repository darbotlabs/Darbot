import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  CopilotKitProvider as DarbotProvider,
  useCopilotKit,
} from "@darbotlm/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { settleReactWork } from "./settle-react-work";

/**
 * A DEDICATED REGRESSION FOR THE PROVIDER/HOOK WIRING ITSELF, isolated from the larger channel
 * scenarios that also happen to exercise it.
 *
 * The mechanical CopilotKit->darbotlm rename left a lowercase `<darbotlmProvider>` JSX tag app-wide
 * (provider.tsx) and in two test harnesses, plus a `usedarbotlm` import that did not match any real
 * export. JSX always reads a lowercase-leading tag as a literal DOM element string, never the
 * imported component, so every child calling the hook — including the app's own `ChannelChat` —
 * threw "must be used within CopilotKitProvider" the instant any of those trees rendered. The other
 * suites that mount a provider tree (`channel-history-refresh.test.tsx`,
 * `failed-send-attachments.test.tsx`) would have failed on this too, but only as a side effect of
 * much bigger scenarios. This pins the wiring on its own: the real export mounts under a properly
 * cased local alias, the real hook reads its context, and the real hook still refuses to run
 * without it.
 */

const NativeResponse = globalThis.Response;

beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: {},
          mode: "sse",
          telemetryDisabled: true,
        });
      throw new Error(`Unexpected fixture request: ${url.pathname}`);
    },
    { preconnect() {} },
  );
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

let captured: ReturnType<typeof useCopilotKit>["copilotkit"] | undefined;

function CoreProbe() {
  captured = useCopilotKit().copilotkit;
  return null;
}

test("the real SDK provider mounts under its aliased JSX tag and the real hook reads its context", () => {
  // No reset-to-`undefined` here: this is the only test touching `captured`, it already
  // starts `undefined` from the declaration above, and explicitly assigning the literal
  // `undefined` immediately before `render()` would make TS narrow `captured` to that literal
  // for the rest of this flow — `render` is opaque to the checker, so it has no way to see
  // that mounting `CoreProbe` reassigns it, and `captured?.runAgent` below would then resolve
  // against `never` instead of `CopilotKitCoreReact | undefined`.
  render(
    <DarbotProvider runtimeUrl="http://localhost/api/darbotlm">
      <CoreProbe />
    </DarbotProvider>,
  );

  expect(captured).toBeDefined();
  // Same object every downstream consumer in this app calls `.runAgent`/`.stopAgent`/
  // `.connectAgent`/`.getAgent` on (channel-chat.tsx) — proves it is the real
  // `CopilotKitCoreReact` instance, not an accidental stand-in.
  expect(typeof captured?.runAgent).toBe("function");
  expect(typeof captured?.stopAgent).toBe("function");
  expect(typeof captured?.connectAgent).toBe("function");
  expect(typeof captured?.getAgent).toBe("function");
});

test("the real hook still refuses to run outside the real provider", () => {
  function UnwrappedProbe() {
    useCopilotKit();
    return null;
  }

  // The SDK logs this via console.error before the throw reaches React's boundary;
  // silence it the same way composer-insecure-context.test.tsx does for its own
  // expected SDK error log, so the failure signal stays the assertion below.
  const realError = console.error;
  console.error = () => {};
  try {
    expect(() => render(<UnwrappedProbe />)).toThrow(
      "useCopilotKit must be used within CopilotKitProvider",
    );
  } finally {
    console.error = realError;
  }
});
