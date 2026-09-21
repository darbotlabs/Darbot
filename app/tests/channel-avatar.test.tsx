import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ChannelAvatar } from "@/components/channels/avatar";
import { swarmIdentities } from "@/lib/agents/icons";

/**
 * `ChannelAvatar` backs the sidebar channel rows, the recipient field, `channel/new`, the channel
 * header, and the computer view. It used to draw every participant as a `boring-avatars` shape
 * keyed on the raw id string; it now resolves each participant's real profile (when the caller's
 * roster carries one) through the same `AgentAvatar` the agent card/dialog/profile already use, and
 * only falls back to a generated shape for a participant no roster entry names.
 *
 * `AgentAvatar` and `identityImageSource` are parent-owned and already covered elsewhere; these
 * tests only prove `ChannelAvatar` wires a resolved profile through to real artwork, and still
 * falls back cleanly (never a broken image) for anyone the roster doesn't recognize.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const architect = swarmIdentities.find(
  (identity) => identity.agentId === "azure_architect",
);
if (!architect) {
  throw new Error(
    "Fixture identity missing from the generated registry \u2014 update this test's fixtures.",
  );
}

test("a participant with a known profile draws that profile's real artwork, not a generated shape", () => {
  const view = render(
    <ChannelAvatar
      agents={[
        {
          id: "participant-123",
          name: "Doretta",
          avatarSeed: "azure_architect",
        },
      ]}
      participantIds={["participant-123"]}
      size={32}
    />,
  );

  // 32px is <= the auto/token threshold, so the resolved identity's token artwork is expected.
  const image = view.getByAltText("Doretta") as HTMLImageElement;
  expect(image.src).toContain(architect.token.png256);
  expect(view.container.querySelector('span[role="img"]')).toBeNull();
});

test("a participant absent from the roster still gets a stable generated avatar, seeded on its own id", () => {
  const view = render(
    <ChannelAvatar participantIds={["totally-unknown-id-1"]} size={32} />,
  );

  expect(
    view.getByRole("img", { name: "totally-unknown-id-1" }),
  ).toBeTruthy();
  expect(view.container.querySelector("img")).toBeNull();
});

test("a participant id missing from a non-empty roster still falls back, rather than erroring", () => {
  const view = render(
    <ChannelAvatar
      agents={[
        { id: "someone-else", name: "Someone Else", avatarSeed: "someone-else" },
      ]}
      participantIds={["not-in-the-roster"]}
      size={32}
    />,
  );

  expect(view.getByRole("img", { name: "not-in-the-roster" })).toBeTruthy();
});

test("the typing badge overlays the drawn identity without replacing it", () => {
  const typing = render(
    <ChannelAvatar
      participantIds={["totally-unknown-id-1"]}
      size={32}
      typing
    />,
  );
  expect(typing.getByText(/Working/)).toBeTruthy();
  // The identity is still drawn underneath the badge, not swapped out for it.
  expect(typing.getByRole("img", { name: "totally-unknown-id-1" })).toBeTruthy();

  const notTyping = render(
    <ChannelAvatar participantIds={["totally-unknown-id-1"]} size={32} />,
  );
  expect(notTyping.queryByText(/Working/)).toBeNull();
});

test("more than one participant draws each participant's own artwork, capped at three", () => {
  const view = render(
    <ChannelAvatar
      participantIds={["unknown-a", "unknown-b", "unknown-c", "unknown-d"]}
      size={32}
    />,
  );

  expect(view.container.querySelectorAll('span[role="img"]').length).toBe(3);
});
