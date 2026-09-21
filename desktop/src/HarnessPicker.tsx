import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import {
  identityImageSource,
  resolveAgentIdentity,
} from "../../shared/swarm-identity";
import { isHttpEndpointUrl } from "./http-endpoint-url";
import { Mark } from "./Mark";
import { asProblem, Failure, type Problem } from "./Problem";

export type Harness = {
  id: string;
  name: string;
  summary: string;
  image: string | null;
  health_path: string | null;
  credential: "any-provider" | "anthropic" | "their-endpoint";
  maintainer: "first-party" | "partnership" | "community";
  mark: string | null;
  port: number | null;
};

export type HarnessChoice = {
  id: string;
  agentUrl?: string;
};

/**
 * The known-framework rows show their actual Swarm identity artwork in place of the vendor mark, so
 * the same face that answers elsewhere in darbot is the one offered here. `row.image` is the
 * adapter directory darbot already ships (an exact identity key, e.g. "agent-langgraph-agui" for
 * the LangGraph row), so it is tried first; the row's display name is the fallback, matched against
 * the same framework aliases the rest of darbot uses. A row that resolves to nothing — an
 * unrecognised framework, or "address your own" — keeps the vendor Mark exactly as before.
 *
 * This only changes which picture is shown. It does not read, start, or configure anything: the
 * row's id, radio state, and onChoose behavior are untouched.
 */
function HarnessMark({ row }: { row: Harness }) {
  const identity = resolveAgentIdentity({
    id: row.id,
    name: row.name,
    avatarSeed: row.image ?? row.id,
    endpoint: null,
  });
  if (!identity) return <Mark id={row.mark} name={row.name} />;
  return (
    <div className="mark-tile">
      <img
        src={identityImageSource(identity, 32, "token")}
        alt=""
        aria-hidden="true"
      />
    </div>
  );
}

/** What darbot sets up unless somebody says otherwise. David's call. */
export const DEFAULT_HARNESS = "langgraph";

/**
 * Which Bot, answered for them.
 *
 * ONE CHOICE IS MADE FOR THE PERSON, and that is the point of this screen rather than a limitation
 * of it. The twelve rows are agent frameworks, and to anybody who is not a developer the difference
 * between them is nil: they all take any model and they all answer the same questions. Asking a
 * non-technical person to pick one is asking them to make a decision they cannot inform, at the
 * start, which is where people leave.
 *
 * So the default is stated in one line and the list moves behind a disclosure. A developer who
 * wants CrewAI opens it and picks CrewAI; everybody else presses Continue and never learns the word
 * "harness". The address-your-own row lives in there too, because pasting a URL is the most
 * developer thing on this screen.
 */
export function HarnessPicker({
  chosen,
  onChoose,
  onContinue,
  onBack,
}: {
  chosen: HarnessChoice | null;
  onChoose: (choice: HarnessChoice) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const [rows, setRows] = useState<Harness[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Problem | null>(null);
  // Open when the person has already chosen something other than the default, so coming back does
  // not hide the choice they made.
  const [open, setOpen] = useState(
    chosen !== null && chosen.id !== DEFAULT_HARNESS,
  );

  useEffect(() => {
    let active = true;
    invoke<Harness[]>("harnesses")
      .then((nextRows) => {
        if (nextRows.length === 0) {
          throw new Error("The harness catalog was empty.");
        }
        if (active) setRows(nextRows);
      })
      .catch((error) => {
        if (!active) return;
        const problem = asProblem(error);
        setFailure({
          said: "The list of Bots could not be read.",
          detail: problem.detail ?? problem.said,
        });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const chosenId = chosen?.id ?? DEFAULT_HARNESS;
  const picked = rows.find((row) => row.id === chosenId);
  const byoAgentUrl = chosenId === "byo-url" ? (chosen?.agentUrl ?? "") : "";
  const byoReady =
    (byoAgentUrl.trim().startsWith("http://") ||
      byoAgentUrl.trim().startsWith("https://")) &&
    isHttpEndpointUrl(byoAgentUrl);

  return (
    <div className="sheet">
      <p className="steps-of">Step 1 of 2</p>
      <h1>Your first Bot</h1>
      {/*
        Written to the person who has to act, not about the situation.

        An earlier version said the default "makes no difference unless you write code", which
        describes a state and leaves a non-technical reader wondering what they were told. This
        gives them the one thing to do — nothing — and puts the conditional where the only person it
        applies to will read it.
      */}
      <p className="lede">
        darbot sets this up for you. If you write code, you can choose the agent
        framework below.
      </p>

      {loading && (
        <p className="picker-status" role="status">
          Loading agent frameworks…
        </p>
      )}
      {failure && <Failure problem={failure} />}
      {!loading && !failure && (
        <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary>
            {picked && picked.id !== DEFAULT_HARNESS
              ? `Using ${picked.name}`
              : "Choose the agent framework"}
          </summary>
          <p className="footnote" style={{ margin: "0.6rem 0 0" }}>
            Any of these works with any AI provider. Only the last one asks you
            for an address.
          </p>
          <fieldset className="picker">
            <legend className="sr-only">Bot</legend>
            {rows.map((row) => (
              <label
                key={row.id}
                className={`tile${chosenId === row.id ? " chosen" : ""}`}
              >
                <input
                  type="radio"
                  name="harness"
                  className="tile-input"
                  value={row.id}
                  checked={chosenId === row.id}
                  onChange={() =>
                    onChoose(
                      row.id === "byo-url"
                        ? { id: row.id, agentUrl: byoAgentUrl }
                        : { id: row.id },
                    )
                  }
                />
                <HarnessMark row={row} />
                <span className="tile-name">{row.name}</span>
                <span className="tile-summary">{row.summary}</span>
                {row.credential === "anthropic" && (
                  <span className="tile-note">No API key needed</span>
                )}
                {row.credential === "their-endpoint" && (
                  <span className="tile-note">Nothing is installed</span>
                )}
              </label>
            ))}
          </fieldset>
          {chosenId === "byo-url" && (
            <div className="field" style={{ marginTop: "0.75rem" }}>
              <label htmlFor="agent-url">AG-UI endpoint</label>
              <input
                id="agent-url"
                value={byoAgentUrl}
                onChange={(event) =>
                  onChoose({
                    id: "byo-url",
                    agentUrl: event.target.value,
                  })
                }
                placeholder="https://your-agent.example/ag-ui"
                spellCheck={false}
              />
            </div>
          )}
        </details>
      )}

      <div className="row">
        <button type="button" className="quiet" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          disabled={
            loading ||
            failure !== null ||
            !picked ||
            (chosenId === "byo-url" && !byoReady)
          }
          onClick={onContinue}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
