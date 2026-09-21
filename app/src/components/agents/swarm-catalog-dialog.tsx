import {
  IconChevronLeft,
  IconChevronRight,
  IconSearch,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import {
  bindingKindLabel,
  cohortLabel,
  IdentityFacts,
} from "@/components/agents/packaged-identity";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type DarbotAgentIdentity,
  identityImageSource,
  swarmIdentities,
} from "@/lib/agents/icons";

export type CohortFilter = "all" | "solid64" | "mint-opal64";
export type BindingFilter = "all" | "code-bound" | "perspective";

const CODE_BOUND_COUNT = swarmIdentities.filter(
  (identity) => identity.bindingKind !== "perspective",
).length;
const PERSPECTIVE_COUNT = swarmIdentities.length - CODE_BOUND_COUNT;

export function matchesSearch(
  identity: DarbotAgentIdentity,
  query: string,
): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  return [
    identity.displayName,
    identity.agentId,
    identity.identityCode,
    identity.domain,
    identity.perspective,
    identity.role,
    identity.group,
    cohortLabel(identity),
  ]
    .join(" \u0000 ")
    .toLowerCase()
    .includes(trimmed);
}

export function matchesCohort(
  identity: DarbotAgentIdentity,
  filter: CohortFilter,
): boolean {
  return filter === "all" || identity.cohort === filter;
}

export function matchesBinding(
  identity: DarbotAgentIdentity,
  filter: BindingFilter,
): boolean {
  if (filter === "all") return true;
  const codeBound = identity.bindingKind !== "perspective";
  return filter === "code-bound" ? codeBound : !codeBound;
}

/**
 * The full Swarm identity registry, opened from `/agents`.
 *
 * All state lives in `SwarmCatalogBrowser`, below `DialogContent`, whose portal unmounts on
 * close: reopening the registry always starts from a cleared search and no selection, never the
 * last visit's filters.
 */
export function SwarmCatalogDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open={open}>
      <DialogContent className="md:max-w-[640px]">
        <SwarmCatalogBrowser />
      </DialogContent>
    </Dialog>
  );
}

/**
 * A list view and a detail view sharing one dialog body, never both a running roster and this
 * registry at once. Selecting a row swaps to its detail; nothing selectable here can create,
 * rename, or wire up a coworker, and browsing it does not touch the role a coworker was given
 * above.
 */
function SwarmCatalogBrowser() {
  const [search, setSearch] = useState("");
  const [cohortFilter, setCohortFilter] = useState<CohortFilter>("all");
  const [bindingFilter, setBindingFilter] = useState<BindingFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = useMemo(
    () =>
      selectedId
        ? (swarmIdentities.find((identity) => identity.agentId === selectedId) ??
          null)
        : null,
    [selectedId],
  );

  const results = useMemo(
    () =>
      swarmIdentities.filter(
        (identity) =>
          matchesSearch(identity, search) &&
          matchesCohort(identity, cohortFilter) &&
          matchesBinding(identity, bindingFilter),
      ),
    [search, cohortFilter, bindingFilter],
  );

  if (selected) {
    return (
      <IdentityDetail
        identity={selected}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Swarm identity registry</DialogTitle>
        <DialogDescription>
          {swarmIdentities.length} packaged identities across both cohorts:{" "}
          {CODE_BOUND_COUNT} are code-bound (a framework adapter or a built-in
          interaction) and {PERSPECTIVE_COUNT} are proposed perspectives with
          no binding at all. This list is descriptive only, independent of
          runtime configuration — browsing or opening an entry changes
          nothing about any coworker, and nothing here is added as a
          coworker on its own.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="gap-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <InputGroup className="text-sm">
            <InputGroupInput
              aria-label="Search identities"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, ID, domain, perspective..."
              value={search}
            />
            <InputGroupAddon>
              <IconSearch />
            </InputGroupAddon>
          </InputGroup>
          <div className="flex gap-2">
            <Select
              items={{
                all: "Both cohorts",
                solid64: "Solid 64",
                "mint-opal64": "Mint Opal 64",
              }}
              onValueChange={(next) => setCohortFilter(next as CohortFilter)}
              value={cohortFilter}
            >
              <SelectTrigger className="w-32 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Both cohorts</SelectItem>
                <SelectItem value="solid64">Solid 64</SelectItem>
                <SelectItem value="mint-opal64">Mint Opal 64</SelectItem>
              </SelectContent>
            </Select>
            <Select
              items={{
                all: "All bindings",
                "code-bound": `Code-bound (${CODE_BOUND_COUNT})`,
                perspective: `Perspectives (${PERSPECTIVE_COUNT})`,
              }}
              onValueChange={(next) =>
                setBindingFilter(next as BindingFilter)
              }
              value={bindingFilter}
            >
              <SelectTrigger className="w-40 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All bindings</SelectItem>
                <SelectItem value="code-bound">
                  Code-bound ({CODE_BOUND_COUNT})
                </SelectItem>
                <SelectItem value="perspective">
                  Perspectives ({PERSPECTIVE_COUNT})
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {results.length === 0 ? (
          <Empty className="min-h-[30dvh] border border-dashed">
            <EmptyHeader>
              <EmptyTitle>No identities match</EmptyTitle>
              <EmptyDescription className="text-pretty">
                Nothing in the registry matches “{search.trim()}” with the
                filters selected above.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="max-h-[45dvh] overflow-y-auto pr-1">
            {results.map((identity) => (
              <Item
                className="w-full text-left hover:bg-muted/50"
                data-testid={`swarm-identity-${identity.agentId}`}
                key={identity.agentId}
                render={
                  <button
                    onClick={() => setSelectedId(identity.agentId)}
                    type="button"
                  />
                }
                size="sm"
                variant="muted"
              >
                <ItemMedia>
                  <img
                    alt=""
                    className="size-8 rounded-sm object-cover"
                    src={identityImageSource(identity, 32, "token")}
                  />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{identity.displayName}</ItemTitle>
                  <ItemDescription>
                    {identity.domain} — {identity.perspective}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                    {bindingKindLabel(identity)}
                  </span>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
      </DialogBody>
    </>
  );
}

function IdentityDetail({
  identity,
  onBack,
}: {
  identity: DarbotAgentIdentity;
  onBack: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <Button
          className="-ml-2 mb-1 w-fit"
          onClick={onBack}
          size="sm"
          variant="ghost"
        >
          <IconChevronLeft />
          Back to registry
        </Button>
        <DialogTitle>{identity.displayName}</DialogTitle>
        <DialogDescription>
          {bindingKindLabel(identity)} — descriptive catalog entry,
          independent of runtime configuration.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="gap-4">
        <div className="flex items-center gap-4">
          <img
            alt=""
            className="size-28 rounded-lg bg-muted object-contain"
            src={identityImageSource(identity, 256, "avatar")}
          />
          <img
            alt=""
            className="size-12 rounded-md bg-muted object-contain"
            src={identityImageSource(identity, 48, "token")}
          />
        </div>
        <IdentityFacts identity={identity} />
      </DialogBody>
    </>
  );
}
