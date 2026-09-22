import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import type {
  AgentIconIdentity,
  DarbotAgentIdentity,
} from "@/lib/agents/icons";
import { swarmIdentities } from "@/lib/agents/icons";
import {
  bindingKindLabel,
  cohortLabel,
  IdentityFacts,
  materialSummary,
  PackagedIdentity,
} from "@/components/agents/packaged-identity";

/**
 * The read-only registry facts shown beside a coworker's user-controlled role: `PackagedIdentity`
 * (used on the agent card/dialog/profile) and the small label helpers it and the catalog dialog
 * share. None of this renders through a Portal, so plain container-scoped queries are safe here
 * (unlike the catalog dialog's detail view).
 *
 * Fixtures are read out of `swarmIdentities` \u2014 the parent-owned generated registry \u2014
 * rather than hand-copied, except for one synthetic `material` override used only to exercise the
 * "opal splatter, not an approximation" branch, which no real generated identity currently has.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const architect = swarmIdentities.find(
  (identity) => identity.agentId === "azure_architect",
);
const adk = swarmIdentities.find(
  (identity) => identity.agentId === "agent-adk",
);
const bot = swarmIdentities.find(
  (identity) => identity.agentId === "agent-bot",
);
if (!architect || !adk || !bot) {
  throw new Error(
    "Fixture identities missing from the generated registry \u2014 update this test's fixtures.",
  );
}

test("bindingKindLabel names a perspective as proposed, never as running", () => {
  expect(bindingKindLabel(architect)).toBe("Proposed perspective");
});

test("bindingKindLabel marks interaction and framework identities as code-bound", () => {
  expect(bindingKindLabel(bot)).toBe("Code-bound \u2014 interaction");
  expect(bindingKindLabel(adk)).toBe("Code-bound \u2014 framework");
});

test("cohortLabel names each cohort in full", () => {
  expect(cohortLabel(architect)).toBe("Solid 64");
  expect(cohortLabel(adk)).toBe("Mint Opal 64");
});

test("materialSummary reports a flat solid finish without a strength or approximation caveat", () => {
  expect(materialSummary(architect)).toBe("Solid");
});

test("materialSummary reports opal-splatter strength as a rounded percent, with an approximation caveat when the swatch isn't exact", () => {
  // 0.55555556 -> 56%, 0.22222222 -> 22%; both real fixtures happen to be approximations.
  expect(materialSummary(adk)).toBe(
    "Opal splatter, 56% strength \u2014 swatch color is an approximation",
  );
  expect(materialSummary(bot)).toBe(
    "Opal splatter, 22% strength \u2014 swatch color is an approximation",
  );
});

test("materialSummary omits the approximation caveat when the swatch is exact", () => {
  // No generated identity currently has kind "opal-splatter" with fallbackColorIsApproximation
  // false, so this one case is exercised on a derived fixture rather than a registry lookup.
  const exactOpal: DarbotAgentIdentity = {
    ...adk,
    material: {
      kind: "opal-splatter",
      materialId: adk.material.materialId,
      strength: 0.3,
      fallbackColorIsApproximation: false,
    },
  };
  expect(materialSummary(exactOpal)).toBe("Opal splatter, 30% strength");
});

test("IdentityFacts lists the registry's own words for a perspective identity, with no Framework row", () => {
  const view = render(<IdentityFacts identity={architect} />);

  expect(view.getByText("Identity")).toBeTruthy();
  expect(
    view.container.textContent?.includes(
      `${architect.displayName} \u2014 ${architect.identityCode}`,
    ),
  ).toBe(true);
  expect(view.getByText("Cohort")).toBeTruthy();
  expect(view.container.textContent).toContain("Solid 64");
  expect(view.getByText("Domain")).toBeTruthy();
  expect(view.container.textContent).toContain(architect.domain);
  expect(view.getByText("Role")).toBeTruthy();
  expect(view.container.textContent).toContain(architect.role);
  expect(view.getByText("Perspective")).toBeTruthy();
  expect(view.container.textContent).toContain(architect.perspective);
  expect(view.getByText("Group")).toBeTruthy();
  expect(view.container.textContent).toContain(architect.group);
  expect(view.getByText("Material")).toBeTruthy();
  expect(view.container.textContent).toContain("Solid");

  // A perspective identity names no framework, so the conditional row must not render at all.
  expect(view.queryByText("Framework")).toBeNull();
});

test("IdentityFacts adds a Framework row only for identities that name one", () => {
  const view = render(<IdentityFacts identity={adk} />);

  expect(view.getByText("Framework")).toBeTruthy();
  expect(view.container.textContent).toContain(adk.frameworkReference);
});

test("PackagedIdentity renders the registry entry beside the user-controlled role, resolved by avatarSeed rather than by name", () => {
  // The saved coworker's own name is deliberately unrelated to the registry identity: resolution
  // must go through avatarSeed, not through matching this literal display name.
  const agent: AgentIconIdentity = {
    id: "user-assigned-coworker-id",
    name: "Whatever This Deployment Named It",
    avatarSeed: "azure_architect",
  };

  const view = render(<PackagedIdentity agent={agent} />);

  expect(view.getByText("Swarm identity registry")).toBeTruthy();
  expect(view.getByText(bindingKindLabel(architect))).toBeTruthy();
  expect(
    view.container.textContent?.includes(
      "Descriptive catalog entry, independent of the role and permissions above.",
    ),
  ).toBe(true);
  // The packaged facts for the resolved identity are present, not just the wrapper chrome.
  expect(view.container.textContent).toContain(architect.domain);
});

test("PackagedIdentity renders nothing for a coworker with no matching registry entry", () => {
  const agent: AgentIconIdentity = {
    id: "totally-unrelated-coworker-id",
    name: "Totally Unrelated Coworker",
    avatarSeed: "totally-unrelated-coworker-id",
  };

  const view = render(<PackagedIdentity agent={agent} />);

  expect(view.container.firstChild).toBeNull();
});
