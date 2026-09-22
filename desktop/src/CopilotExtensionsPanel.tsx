import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { InlineFailure, asProblem, type Problem } from "./Problem";
import type { CopilotAgentSummary } from "./copilot-types";

type Feature<T> =
  | { state: "available"; data: T }
  | { state: "unavailable"; problem: Problem };

type ExtensionPlugin = {
  id: string;
  name: string;
  enabled: boolean;
  version?: string | null;
  canToggle: boolean;
};

type ExtensionTask = {
  id: string;
  kind: string;
  status: string;
  title: string;
  output?: string | null;
  outputTruncated: boolean;
};

type RemoteSession = {
  id: string;
  title: string;
  modifiedAt: string;
  state?: string | null;
};

type ExtensionSnapshot = {
  schemaVersion: number;
  sdkVersion: string;
  runtimeVersion: string;
  protocolVersion: number;
  connectionId: string;
  sessionId: string;
  cwd: string;
  memoryEnabled: boolean;
  agents: Feature<CopilotAgentSummary[]>;
  tasks: Feature<ExtensionTask[]>;
  plugins: Feature<ExtensionPlugin[]>;
  remoteSessions?: Feature<RemoteSession[]> | null;
};

type ExtensionAction = Record<string, unknown>;

const unavailable = (feature: Feature<unknown>): string | null =>
  feature.state === "unavailable" ? feature.problem.said : null;

export function CopilotExtensionsPanel({ cwd }: { cwd: string }) {
  const [snapshot, setSnapshot] = useState<ExtensionSnapshot | null>(null);
  const [memoryEnabled, setMemoryEnabled] = useState(false);
  const [taskAgent, setTaskAgent] = useState("");
  const [taskName, setTaskName] = useState("");
  const [taskPrompt, setTaskPrompt] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void invoke<ExtensionSnapshot | null>("copilot_extensions_status")
      .then((value) => {
        if (active && value) {
          setSnapshot(value);
          setMemoryEnabled(value.memoryEnabled);
        }
      })
      .catch((error) => {
        if (active) setProblem(asProblem(error));
      });
    return () => {
      active = false;
    };
  }, []);

  async function run(action: ExtensionAction, keepOpen = true) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const value = await invoke<ExtensionSnapshot | null>(
        "copilot_extensions_action",
        { request: { schemaVersion: 1, action } },
      );
      if (!keepOpen) {
        setSnapshot(null);
        return;
      }
      if (!value) {
        setSnapshot(null);
        setProblem({ said: "The SDK workspace is no longer connected." });
        return;
      }
      setSnapshot(value);
      setMemoryEnabled(value.memoryEnabled);
      const agents =
        value.agents.state === "available" ? value.agents.data : [];
      if (!taskAgent && agents[0]) setTaskAgent(agents[0].id);
    } catch (error) {
      setProblem(asProblem(error));
    } finally {
      setBusy(false);
    }
  }

  function connect() {
    void run({ kind: "connect", cwd, memoryEnabled });
  }

  const agents =
    snapshot?.agents.state === "available" ? snapshot.agents.data : [];
  const tasks =
    snapshot?.tasks.state === "available" ? snapshot.tasks.data : [];
  const plugins =
    snapshot?.plugins.state === "available" ? snapshot.plugins.data : [];
  const remoteSessions =
    snapshot?.remoteSessions?.state === "available"
      ? snapshot.remoteSessions.data
      : [];
  const connected = snapshot !== null;

  return (
    <section
      className="copilot-extensions"
      aria-labelledby="copilot-extensions-title"
    >
      <div className="copilot-extensions-header">
        <div>
          <h2 id="copilot-extensions-title">Background Copilot workspace</h2>
          <p className="hint">
            Optional SDK features run separately from this conversation and use
            the signed-in Copilot CLI.
          </p>
        </div>
        <span className="copilot-runtime-state">
          {connected ? "Connected" : "Not connected"}
        </span>
      </div>
      {!connected ? (
        <div className="copilot-extensions-connect">
          <label className="copilot-checkbox-row">
            <input
              type="checkbox"
              checked={memoryEnabled}
              onChange={(event) => setMemoryEnabled(event.target.checked)}
              disabled={busy}
            />
            <span>
              Enable Copilot runtime memory for this background workspace
              <small>Off by default. This is not Darbot lavamem.</small>
            </span>
          </label>
          <button type="button" onClick={connect} disabled={busy}>
            {busy ? "Connecting..." : "Connect SDK workspace"}
          </button>
        </div>
      ) : (
        <>
          <div className="copilot-extensions-toolbar">
            <span title={snapshot.cwd}>
              {snapshot.runtimeVersion} / protocol {snapshot.protocolVersion}
            </span>
            <button
              type="button"
              className="quiet"
              onClick={() =>
                void run({
                  kind: "refresh",
                  connectionId: snapshot.connectionId,
                })
              }
              disabled={busy}
            >
              Refresh
            </button>
            <button
              type="button"
              className="quiet"
              onClick={() =>
                void run({
                  kind: "list-remote",
                  connectionId: snapshot.connectionId,
                })
              }
              disabled={busy}
            >
              Discover remote sessions
            </button>
            <button
              type="button"
              className="quiet"
              onClick={() =>
                void run(
                  { kind: "disconnect", connectionId: snapshot.connectionId },
                  false,
                )
              }
              disabled={busy}
            >
              Disconnect
            </button>
          </div>
          <div className="copilot-extension-grid">
            <div>
              <h3>Agents and tasks</h3>
              {unavailable(snapshot.agents) ? (
                <p className="caution">{unavailable(snapshot.agents)}</p>
              ) : (
                <>
                  <div className="copilot-extension-form">
                    <select
                      value={taskAgent}
                      onChange={(event) => setTaskAgent(event.target.value)}
                      disabled={busy || agents.length === 0}
                      aria-label="Background agent"
                    >
                      <option value="">Choose an agent</option>
                      {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                    </select>
                    <input
                      value={taskName}
                      onChange={(event) => setTaskName(event.target.value)}
                      placeholder="Task name"
                      maxLength={128}
                    />
                    <textarea
                      value={taskPrompt}
                      onChange={(event) => setTaskPrompt(event.target.value)}
                      placeholder="Task prompt"
                      maxLength={16000}
                      rows={2}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        void run({
                          kind: "start-task",
                          connectionId: snapshot.connectionId,
                          agentId: taskAgent,
                          name: taskName,
                          prompt: taskPrompt,
                        });
                        setTaskName("");
                        setTaskPrompt("");
                      }}
                      disabled={
                        busy ||
                        !taskAgent ||
                        !taskName.trim() ||
                        !taskPrompt.trim()
                      }
                    >
                      Start background task
                    </button>
                  </div>
                  {tasks.length === 0 ? (
                    <p className="hint">No background tasks.</p>
                  ) : (
                    <ul className="copilot-extension-list">
                      {tasks.map((task) => (
                        <li key={task.id}>
                          <span>
                            <strong>{task.title}</strong>
                            <small>{task.status}</small>
                          </span>
                          <button
                            type="button"
                            className="quiet"
                            onClick={() =>
                              void run({
                                kind: "cancel-task",
                                connectionId: snapshot.connectionId,
                                taskId: task.id,
                              })
                            }
                            disabled={
                              busy ||
                              ["completed", "failed", "cancelled"].includes(
                                task.status,
                              )
                            }
                          >
                            Cancel
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
            <div>
              <h3>Plugins</h3>
              {unavailable(snapshot.plugins) ? (
                <p className="caution">{unavailable(snapshot.plugins)}</p>
              ) : plugins.length === 0 ? (
                <p className="hint">
                  No toggleable marketplace plugins were reported.
                </p>
              ) : (
                <ul className="copilot-extension-list">
                  {plugins.map((plugin) => (
                    <li key={plugin.id}>
                      <span>
                        <strong>{plugin.name}</strong>
                        <small>{plugin.version ?? "Installed"}</small>
                      </span>
                      <button
                        type="button"
                        className="quiet"
                        onClick={() =>
                          void run({
                            kind: "set-plugin-enabled",
                            connectionId: snapshot.connectionId,
                            pluginId: plugin.id,
                            enabled: !plugin.enabled,
                          })
                        }
                        disabled={busy || !plugin.canToggle}
                      >
                        {plugin.enabled ? "Disable" : "Enable"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {remoteSessions.length > 0 && (
            <details className="copilot-runtime-warnings" open>
              <summary>Remote sessions discovered</summary>
              <ul>
                {remoteSessions.map((remote) => (
                  <li key={remote.id}>
                    {remote.title} · {remote.state ?? "unknown"}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {problem && <InlineFailure problem={problem} />}
    </section>
  );
}
