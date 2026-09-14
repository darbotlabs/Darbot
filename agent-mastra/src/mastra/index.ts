/**
 * Mastra as a Bot.
 *
 * Mastra brings its own HTTP server, so unlike the Python harnesses this one is not a FastAPI app
 * with a route bolted on: it is a plain Mastra server, and that is the whole point. Mastra already
 * serves its agents over its own API, and darbot dials that API through `@ag-ui/mastra`, the bridge
 * Mastra and AG-UI maintain between them. See `remoteTransport` in server/src/copilot.ts.
 *
 * SO THERE IS NO AG-UI ROUTE HERE, deliberately. An earlier version mounted `registerdarbotlm`
 * from `@ag-ui/mastra/darbotlm`, which serves the darbotlm Runtime protocol rather than AG-UI:
 * a different wire format that answers a run with a complaint about a missing `method` field. The
 * translation belongs on darbot's side, in one place, where every remote Bot is governed the same
 * way — not in each harness.
 */
import { openai } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { registerApiRoute } from "@mastra/core/server";
import { listenPort } from "../../../shared/listen-port";

const model = process.env.BOT_MODEL?.trim() || "gpt-4o-mini";
const port = listenPort(process.env.PORT, 4213);
if (!port.ok) throw new Error(port.reason);

export const darbotBaseInstructions =
  "Answer the question you are asked, briefly and correctly.";

const darbot_CONTEXT_DESCRIPTIONS = [
  "darbot standing role",
  "darbot granted tools guidance",
] as const;

type darbotInstructionArgs = {
  requestContext?: {
    get(key: string): unknown;
  };
};

function agUiContextEntries(
  requestContext?: darbotInstructionArgs["requestContext"],
) {
  const agUi = requestContext?.get("ag-ui");
  if (
    typeof agUi !== "object" ||
    agUi === null ||
    !("context" in agUi) ||
    !Array.isArray(agUi.context)
  ) {
    return [];
  }
  return agUi.context;
}

export function builddarbotInstructions({
  requestContext,
}: darbotInstructionArgs = {}) {
  const contextEntries = agUiContextEntries(requestContext);
  const darbotInstructions = darbot_CONTEXT_DESCRIPTIONS.flatMap(
    (description) =>
      contextEntries
        .filter(
          (entry): entry is { description: string; value: string } =>
            typeof entry === "object" &&
            entry !== null &&
            "description" in entry &&
            entry.description === description &&
            "value" in entry &&
            typeof entry.value === "string" &&
            entry.value.trim().length > 0,
        )
        .map((entry) => entry.value.trim()),
  );

  if (darbotInstructions.length === 0) return darbotBaseInstructions;
  return [darbotBaseInstructions, ...darbotInstructions].join("\n\n");
}

const darbot = new Agent({
  id: "darbot",
  name: "darbot",
  instructions: builddarbotInstructions,
  model: openai(model),
});

/** The one header darbot's server sends, compared without leaking length through timing. */
function carriesTheServerToken(request: Request): boolean {
  const expected = (process.env.MANAGED_AGENT_TOKEN ?? "").trim();
  const offered = (request.headers.get("x-darbot-agent-token") ?? "").trim();
  // Unset means unconfigured, not open.
  if (!expected || offered.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < offered.length; index += 1) {
    difference |= offered.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

export const mastra = new Mastra({
  agents: { darbot },
  server: {
    port: port.port,
    host: "0.0.0.0",
    middleware: [
      // Everything but `/health`, which Compose polls before any token exists.
      async (context, next) => {
        if (new URL(context.req.url).pathname === "/health") return next();
        if (!carriesTheServerToken(context.req.raw)) {
          return context.json({ error: "unauthorised" }, 401);
        }
        return next();
      },
    ],
    apiRoutes: [
      registerApiRoute("/health", {
        method: "GET",
        handler: async (context) =>
          context.json({ ok: true, harness: "mastra" }),
      }),
    ],
  },
});
