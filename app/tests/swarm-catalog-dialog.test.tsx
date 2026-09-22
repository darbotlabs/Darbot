import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { bindingKindLabel } from "@/components/agents/packaged-identity";
import {
  matchesBinding,
  matchesCohort,
  matchesSearch,
  SwarmCatalogDialog,
} from "@/components/agents/swarm-catalog-dialog";
import { swarmIdentities } from "@/lib/agents/icons";

/**
 * The registry dialog opened from `/agents`: a read-only catalog of all 128 packaged Swarm
 * identities, never a roster of running coworkers.
 *
 * These tests exercise the plain-text search box, the Item list, and the list/detail split with
 * real component renders, but stop short of driving either cohort/binding `Select` open — nothing
 * in this codebase has previously rendered a Base UI `Select` popover under happy-dom, and the
 * three filter predicates below already give full, faster coverage of what those selects narrow
 * down to. The predicates are exported from the component module specifically so this file tests
 * the exact logic wired into the two selects, not a re-implementation of it.
 *
 * Fixtures are read out of `swarmIdentities` itself — the parent-owned generated registry — rather
 * than hand-copied, so a regeneration cannot silently desync this file's expectations from the data
 * shown.
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

const CODE_BOUND_COUNT = swarmIdentities.filter(
  (identity) => identity.bindingKind !== "perspective",
).length;
const PERSPECTIVE_COUNT = swarmIdentities.length - CODE_BOUND_COUNT;

test("matchesSearch matches on name, id, domain, perspective, role, group and cohort, case-insensitively", () => {
  expect(matchesSearch(architect, "")).toBe(true);
  expect(matchesSearch(architect, "   ")).toBe(true);
  expect(matchesSearch(architect, "cloud architect")).toBe(true);
  expect(matchesSearch(architect, "AZURE_ARCHITECT")).toBe(true);
  expect(matchesSearch(architect, architect.identityCode.toLowerCase())).toBe(
    true,
  );
  expect(matchesSearch(architect, "azure")).toBe(true);
  expect(matchesSearch(architect, "landing zones")).toBe(true);
  expect(matchesSearch(architect, "platform_foundation")).toBe(true);
  expect(matchesSearch(architect, "solid 64")).toBe(true);
  expect(matchesSearch(architect, "nothing matches this")).toBe(false);

  // A framework identity's own domain and perspective copy also match.
  expect(matchesSearch(adk, "adk")).toBe(true);
  expect(matchesSearch(adk, "agent construction")).toBe(true);
});

test('matchesCohort filters to exactly one cohort or passes everything through for "all"', () => {
  expect(matchesCohort(architect, "all")).toBe(true);
  expect(matchesCohort(architect, "solid64")).toBe(true);
  expect(matchesCohort(architect, "mint-opal64")).toBe(false);

  expect(matchesCohort(adk, "all")).toBe(true);
  expect(matchesCohort(adk, "mint-opal64")).toBe(true);
  expect(matchesCohort(adk, "solid64")).toBe(false);
});

test("matchesBinding distinguishes code-bound identities (framework or interaction) from proposed perspectives", () => {
  expect(matchesBinding(architect, "all")).toBe(true);
  expect(architect.bindingKind).toBe("perspective");
  expect(matchesBinding(architect, "perspective")).toBe(true);
  expect(matchesBinding(architect, "code-bound")).toBe(false);

  expect(adk.bindingKind).toBe("framework");
  expect(matchesBinding(adk, "code-bound")).toBe(true);
  expect(matchesBinding(adk, "perspective")).toBe(false);

  expect(bot.bindingKind).toBe("interaction");
  expect(matchesBinding(bot, "code-bound")).toBe(true);
  expect(matchesBinding(bot, "perspective")).toBe(false);
});

test("every identity in the registry is exactly one of code-bound or perspective, and the counts match the header copy", () => {
  for (const identity of swarmIdentities) {
    const codeBound = matchesBinding(identity, "code-bound");
    const perspective = matchesBinding(identity, "perspective");
    expect(codeBound).toBe(!perspective);
  }
  expect(swarmIdentities.length).toBe(128);
  expect(CODE_BOUND_COUNT).toBe(15);
  expect(PERSPECTIVE_COUNT).toBe(113);
});

test("the registry list states the total, code-bound and perspective counts and that browsing changes nothing at runtime", () => {
  const view = render(<SwarmCatalogDialog onClose={() => {}} open />);

  expect(view.getByText("Swarm identity registry")).toBeTruthy();
  const description = view.getByText(/packaged identities across both cohorts/);
  expect(description.textContent).toContain(`${swarmIdentities.length}`);
  expect(description.textContent).toContain(
    `${CODE_BOUND_COUNT} are code-bound`,
  );
  expect(description.textContent).toContain(
    `${PERSPECTIVE_COUNT} are proposed perspectives`,
  );
  expect(description.textContent).toContain("descriptive only, independent of");
  expect(description.textContent).toContain(
    "nothing here is added as a coworker on its own",
  );
});

test("every identity is rendered as a real, accessible button naming its own identity", () => {
  const view = render(<SwarmCatalogDialog onClose={() => {}} open />);

  const architectRow = view.getByTestId(`swarm-identity-${architect.agentId}`);
  expect(architectRow.tagName).toBe("BUTTON");
  expect(architectRow.getAttribute("type")).toBe("button");
  expect(architectRow.textContent).toContain(architect.displayName);
  expect(architectRow.textContent).toContain(architect.domain);
  expect(architectRow.textContent).toContain(bindingKindLabel(architect));

  // Spot-check a second, differently-cohorted row rather than asserting on all 128 at once.
  const adkRow = view.getByTestId(`swarm-identity-${adk.agentId}`);
  expect(adkRow.tagName).toBe("BUTTON");
  expect(adkRow.textContent).toContain(adk.displayName);
  expect(adkRow.textContent).toContain(bindingKindLabel(adk));
});

test("typing in the search box narrows the list, and clearing it restores every identity", async () => {
  const user = userEvent.setup();
  const view = render(<SwarmCatalogDialog onClose={() => {}} open />);

  const search = view.getByLabelText("Search identities");
  await user.type(search, architect.displayName);

  expect(view.getByTestId(`swarm-identity-${architect.agentId}`)).toBeTruthy();
  expect(view.queryByTestId(`swarm-identity-${adk.agentId}`)).toBeNull();

  await user.clear(search);
  expect(view.getByTestId(`swarm-identity-${architect.agentId}`)).toBeTruthy();
  expect(view.getByTestId(`swarm-identity-${adk.agentId}`)).toBeTruthy();
});

test("a search that matches nothing shows the empty state instead of an empty list", async () => {
  const user = userEvent.setup();
  const view = render(<SwarmCatalogDialog onClose={() => {}} open />);

  const search = view.getByLabelText("Search identities");
  await user.type(search, "no such identity in the registry");

  expect(view.getByText("No identities match")).toBeTruthy();
  expect(view.getByText(/no such identity in the registry/)).toBeTruthy();
  expect(view.queryByTestId(`swarm-identity-${architect.agentId}`)).toBeNull();
});

test("selecting an identity opens its detail view with its own artwork and facts, and back returns to the list", async () => {
  const user = userEvent.setup();
  const view = render(<SwarmCatalogDialog onClose={() => {}} open />);

  await user.click(view.getByTestId(`swarm-identity-${architect.agentId}`));

  // `DialogContent` renders through a Base UI Portal, so it lives outside `view.container` —
  // `view.baseElement` (document.body, where the portal actually mounts) is used for raw queries.
  //
  // `azure_architect`'s displayName and role are both literally "Cloud Architect", so the title
  // is checked structurally by its data-slot rather than by text (which would now match twice).
  const title = view.baseElement.querySelector('[data-slot="dialog-title"]');
  expect(title?.textContent).toBe(architect.displayName);
  expect(
    view.getByText(
      /descriptive catalog entry, independent of runtime configuration/,
    ),
  ).toBeTruthy();

  const images = Array.from(view.baseElement.querySelectorAll("img"));
  expect(images.length).toBeGreaterThanOrEqual(2);
  expect(
    images.some((image) => image.src.includes(architect.avatar.png512)),
  ).toBe(true);
  expect(
    images.some((image) => image.src.includes(architect.token.png256)),
  ).toBe(true);
  // The registry's own words for the identity, surfaced through IdentityFacts.
  expect(view.baseElement.textContent).toContain(architect.domain);
  expect(view.baseElement.textContent).toContain(architect.role);
  expect(view.baseElement.textContent).toContain(architect.perspective);
  expect(view.baseElement.textContent).toContain(architect.group);

  await user.click(view.getByText("Back to registry"));

  expect(view.getByLabelText("Search identities")).toBeTruthy();
  expect(view.queryByText("Back to registry")).toBeNull();
});

test("a focused identity row opens its detail view on Enter, the same as a click", async () => {
  const user = userEvent.setup();
  const view = render(<SwarmCatalogDialog onClose={() => {}} open />);

  const row = view.getByTestId(`swarm-identity-${adk.agentId}`);
  row.focus();
  await user.keyboard("{Enter}");

  expect(view.getByText(adk.displayName)).toBeTruthy();
  expect(view.queryByLabelText("Search identities")).toBeNull();
});
