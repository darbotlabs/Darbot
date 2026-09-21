import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { CopilotAgentCatalog } from "./copilot-types";
import { asProblem, InlineFailure, type Problem } from "./Problem";

export function CopilotAgentImport({
  existingIds = [],
  firstRun = false,
  onComplete,
  onBack,
}: {
  existingIds?: string[];
  firstRun?: boolean;
  onComplete: (ids: string[]) => void;
  onBack: () => void;
}) {
  const [catalog, setCatalog] = useState<CopilotAgentCatalog | null>(null);
  const [failure, setFailure] = useState<Problem | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const existing = new Set(existingIds);

  useEffect(() => {
    let active = true;
    setFailure(null);
    invoke<CopilotAgentCatalog>("copilot_agents")
      .then((result) => {
        if (active) setCatalog(result);
      })
      .catch((error) => {
        if (active) setFailure(asProblem(error));
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  const search = query.trim().toLowerCase();
  const visible = (catalog?.agents ?? []).filter(
    (agent) =>
      !search ||
      `${agent.name} ${agent.description ?? ""}`.toLowerCase().includes(search),
  );
  const Heading = firstRun ? "h1" : "h2";

  return (
    <section className="copilot-import" aria-labelledby="copilot-import-title">
      <header>
        {firstRun && <p className="steps-of">Step 3 of 3</p>}
        <Heading id="copilot-import-title">Import agents (optional)</Heading>
        <p className="hint">
          Choose personal Copilot agents for this workspace, or start with none.
          Selected agents and the built-in Copilot CLI will have their recorded
          conversations linked. Definitions and message bodies stay with
          Copilot; nothing is moved or deleted.
        </p>
      </header>
      <label htmlFor="copilot-import-search">Search agents</label>
      <input
        id="copilot-import-search"
        type="search"
        placeholder="Find an agent by name or description"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="copilot-import-summary">
        <span role="status">
          {catalog
            ? `${catalog.agents.length} available. ${selected.length} selected.`
            : failure
              ? "Agent discovery failed."
              : "Reading personal agents..."}
        </span>
        <button
          type="button"
          className="quiet"
          disabled={
            !catalog || visible.every((agent) => existing.has(agent.id))
          }
          onClick={() =>
            setSelected((current) => [
              ...new Set([
                ...current,
                ...visible
                  .filter((agent) => !existing.has(agent.id))
                  .map((agent) => agent.id),
              ]),
            ])
          }
        >
          Select shown
        </button>
        <button
          type="button"
          className="quiet"
          disabled={selected.length === 0}
          onClick={() => setSelected([])}
        >
          Clear
        </button>
      </div>
      {failure && (
        <div>
          <InlineFailure problem={failure} />
          <button
            type="button"
            className="quiet"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      )}
      <ul className="copilot-import-options" aria-label="Available agents">
        {visible.map((agent) => (
          <li key={agent.id}>
            <label>
              <input
                type="checkbox"
                checked={existing.has(agent.id) || selected.includes(agent.id)}
                disabled={existing.has(agent.id)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, agent.id]
                      : current.filter((id) => id !== agent.id),
                  )
                }
              />
              <span>
                <strong>{agent.name}</strong>
                <span>
                  {existing.has(agent.id)
                    ? "Already in this workspace"
                    : agent.description || "Personal Copilot agent"}
                </span>
              </span>
            </label>
          </li>
        ))}
        {catalog && visible.length === 0 && (
          <li className="copilot-resource-empty">
            No matching personal agents. You can create one on your canvas.
          </li>
        )}
      </ul>
      {!!catalog?.warnings.length && (
        <details className="copilot-runtime-warnings">
          <summary>Agent discovery warnings</summary>
          <ul>
            {catalog.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
      <footer className="copilot-import-actions">
        <button type="button" className="quiet" onClick={onBack}>
          {firstRun ? "Back" : "Cancel"}
        </button>
        <button
          type="button"
          className={selected.length ? "quiet" : undefined}
          onClick={() => onComplete([])}
        >
          {firstRun ? "Import none" : "Done without importing"}
        </button>
        <button
          type="button"
          disabled={!selected.length}
          onClick={() => onComplete(selected)}
        >
          Import selected ({selected.length})
        </button>
      </footer>
    </section>
  );
}
