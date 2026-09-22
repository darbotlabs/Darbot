import {
  type AgentIconIdentity,
  type DarbotAgentIdentity,
  resolveAgentIdentity,
} from "@/lib/agents/icons";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemHeader,
  ItemTitle,
} from "@/components/ui/item";

/**
 * "Code-bound" only for the identities a framework, the Bot, or the Computer actually runs; every
 * other match is a written perspective, never a running one. The label says which, so a reader never
 * has to guess from the artwork alone.
 */
export function bindingKindLabel(identity: DarbotAgentIdentity): string {
  switch (identity.bindingKind) {
    case "perspective":
      return "Proposed perspective";
    case "interaction":
      return "Code-bound \u2014 interaction";
    default:
      return "Code-bound \u2014 framework";
  }
}

export function cohortLabel(identity: DarbotAgentIdentity): string {
  return identity.cohort === "solid64" ? "Solid 64" : "Mint Opal 64";
}

/**
 * The finish the generator painted the artwork in, in the words a reader can act on: whether the
 * swatch shown is the material itself or only an approximation of one the renderer can't flatten
 * to a single color.
 */
export function materialSummary(identity: DarbotAgentIdentity): string {
  const { material } = identity;
  if (material.kind === "solid") {
    return "Solid";
  }
  const strengthPercent = Math.round(material.strength * 100);
  return material.fallbackColorIsApproximation
    ? `Opal splatter, ${strengthPercent}% strength \u2014 swatch color is an approximation`
    : `Opal splatter, ${strengthPercent}% strength`;
}

/**
 * The registry's own words for an identity: the cohort it belongs to, the domain and role it was
 * written for, the material its artwork was rendered in, and the framework it names if it names
 * one. Plain facts, not a form; nothing here is editable from this list.
 */
export function IdentityFacts({ identity }: { identity: DarbotAgentIdentity }) {
  const facts: [string, string][] = [
    ["Identity", `${identity.displayName} \u2014 ${identity.identityCode}`],
    ["Cohort", cohortLabel(identity)],
    ["Domain", identity.domain],
    ["Role", identity.role],
    ["Perspective", identity.perspective],
    ["Group", identity.group],
    ["Material", materialSummary(identity)],
  ];
  if (identity.frameworkReference) {
    facts.push(["Framework", identity.frameworkReference]);
  }

  return (
    <dl className="grid gap-1.5">
      {facts.map(([label, value]) => (
        <div className="grid grid-cols-[5rem_1fr] gap-2 text-sm" key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 text-pretty">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The identity registry's own description of a coworker, shown beside — never instead of — the
 * role a person gave it here. One is a fixed catalog entry; the other is what this deployment
 * decided to call the coworker. Nothing below can be edited from this list, and nothing below
 * changes what the coworker is allowed to do: it is the same static entry the identity catalog
 * shows, repeated where the coworker already has a page.
 *
 * Renders nothing for a coworker with no matching registry entry, which is most coworkers.
 */
export function PackagedIdentity({ agent }: { agent: AgentIconIdentity }) {
  const identity = resolveAgentIdentity(agent);
  if (!identity) {
    return null;
  }

  return (
    <Item variant="muted">
      <ItemContent className="gap-3">
        <ItemHeader>
          <ItemTitle>Swarm identity registry</ItemTitle>
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
            {bindingKindLabel(identity)}
          </span>
        </ItemHeader>
        <ItemDescription>
          Descriptive catalog entry, independent of the role and permissions
          above.
        </ItemDescription>
        <IdentityFacts identity={identity} />
      </ItemContent>
    </Item>
  );
}
