# GitHub Copilot CLI runtime

## Status

This document defines first-class GitHub Copilot support for the Darbot desktop
application. It is an implementation specification, not a statement that every
phase below is already complete.

The integration targets:

- GitHub Copilot CLI `1.0.86-0` or newer;
- Agent Client Protocol (ACP) v1 as the stable interactive contract;
- GitHub Copilot SDK protocol v3 as an optional extended capability surface;
- the user's existing Copilot home, normally `~/.copilot`;
- the authentication state already managed by Copilot CLI.

ACP v2 is currently a draft and is not a release baseline.

### Durable local drafts and opening recovery

Darbot conversation IDs are independent of live CLI session IDs. **New chat**
creates a local draft and does not start a CLI session. The first **Send** opens
Copilot and associates the returned runtime session with the same conversation.
Unsent text is saved per conversation, survives switching and application
restarts, and is restored without sending or automatically reconnecting.

Workspace storage has an explicit schema version. Existing session references
migrate without changing agent ownership or copying transcripts, definitions or
authentication material. The original preference blob and its distinction
between an undecided import and **Import none** remain unchanged. Invalid,
unsupported or duplicate stored records block workspace loading visibly rather
than being replaced with empty data. Storage failures retain the in-window
draft and warn the user to keep it open and copy the text.

Local drafts appear in the sidebar, canvas and History, including drafts with no
CLI session. A migrated reference remains a reference, not proof that the CLI
persisted an empty session. Loading an unavailable legacy session reports the
real error; it never silently opens a different conversation.

The complete native opening transaction includes protocol response validation
and negotiated configuration. Any failure retires Darbot's owned connection
before returning, including configuration failures after a successful load.
Late messages from a retired connection are discarded. Reopening is explicit
and never resubmits the saved draft. This fixes the source-level orphan and
empty-new-chat lifecycle; installed timeout injection is a separate acceptance
requirement, not something established by contract or unit tests alone.

### Canvas bounds in desktop 0.0.20

Chat preview grids use a zero-minimum, bounded column so ellipsized titles do not
stretch the canvas's internal scroll area. Native acceptance measures each
surface's scroll width as well as the document width at compact and normal
window sizes; document-only overflow checks are insufficient.

Tool activity IDs are allocated before the React state updater, keeping updates
repeatable if React retries an updater.

### Native review refinements in desktop 0.0.19

Partial tool updates retain the action's original title and requested input
alongside its latest output. A completion-only update changes status rather than
relabeling the action as an anonymous tool call. These details remain in the
live conversation view; persisted chat references still contain metadata only.

Canvas chat previews truncate long titles to one line and expose the complete
title on hover. This complements the five-chat preview limit when an entire
agent catalog is imported.

### Conversation opening in desktop 0.0.18

Starting or loading a conversation can initialize the CLI's configured MCP
servers. Slow or unavailable servers can exceed the previous two-minute
deadline. These operations now have a bounded five-minute budget, separate from
normal ACP requests and prompt execution. Darbot does not change MCP endpoints,
disable integrations, or bypass their authentication.

The first message remains visible in the disabled composer while opening. If
the deadline expires, Darbot stops only its owned CLI runtime before returning
an actionable error. A late session response cannot be reused accidentally or
leave an already-loaded session in that connection. Retrying starts a fresh
connection; there is no automatic retry or duplicate prompt submission.

A failed replay clears its incomplete display and reports that the conversation
did not open. The durable local draft and complete-opening recovery changes
above supersede this version's runtime-ID-only draft handling.

### Agent conversation links and incremental history in desktop 0.0.18

Importing agents now links existing conversations for those workspace agents and
the built-in Copilot CLI. The same path is available as **Link existing
conversations** in Settings and Profile. Import none still performs no history
linking. Agents without recorded history remain empty rather than receiving
invented sessions.

Links contain only session IDs, recorded initial-agent attribution, titles,
folders and timestamps. Existing references and the active conversation are
preserved, duplicate session IDs are merged, and unavailable agent metadata is
not guessed. No agent definitions, credentials, or transcript bodies are copied.

History is indexed one ACP page at a time. Request-correlated batches of at most
100 records reach the History dialog and the imported-agent sidebar before the
complete index finishes. Results from an older request cannot overwrite the
current view. Bounded metadata reads and the existing file-change-aware cache
remain in use. Timings separately report connection, listing, metadata indexing,
first batch and total duration without recording conversation content.

Each sidebar group and canvas card previews up to five chats, retaining the
active chat even when it falls outside that slice. **View all** opens History
filtered to the corresponding agent; the underlying conversation references are
not truncated. This bounds rendering when importing an entire agent catalog.

### Workspace surfaces in desktop 0.0.17

**New agent** and **New chat** sit beside the Darbot mark at the top of the left
sidebar. Copilot CLI remains available as the built-in agent even when no custom
agents are imported. The sidebar groups each agent's chats and keeps
**Resources**, **History**, **Settings**, and **Profile** at the bottom.

The keyboard-accessible main tabs are **Your workspace** for conversation text,
**Your canvas** for the actual agents and saved chat references, and **Your CLI**
for live tool activity and its output. Switching surfaces does not close the
runtime, clear a draft, or interrupt a pending approval. The CLI surface is an
activity viewer, not a terminal or arbitrary command execution interface.

The composer stays available on all three surfaces. Enter submits the message;
Shift+Enter inserts a newline. With no active session, sending first opens a real
Copilot session. Adding a skill or command only inserts text and does not start
or run a session.

**Import agents** is available from Settings and Profile, not the sidebar.
Profile's **Model providers** section describes the actual Copilot connection;
model and reasoning settings remain runtime-negotiated in Settings. Other
providers still require the separate container deployment setup. Profile-scoped
multi-provider routing, lavamem, OneDrive/MSAL, and an independent terminal are
not implemented by these UI tabs.

The official GitHub Copilot mark is vendored from Primer Octicons under MIT;
Profile includes its attribution and license. No private reference assets or
implementation are included.

Remaining conversation-lifecycle acceptance is tracked in
[issue #6](https://github.com/darbotlabs/Darbot/issues/6). Moving between tabs
avoids runtime reloads. New local drafts no longer depend on empty CLI sessions.

### Optional agent import in desktop 0.0.16

The first-run GitHub path is provider readiness, optional personal-agent
selection, then the chat canvas. Nothing is preselected. **Import none** completes
setup with no imported agents or automatically loaded conversations. Copilot CLI
itself remains available through the built-in **Copilot CLI** sidebar row and
composer.

The left sidebar groups workspace chats under their agents. **Import agents**
adds references to existing personal definitions; it does not move or copy them,
and does not copy conversation transcripts. Starting with 0.0.18, recorded
conversation references are linked for imported agents; complete CLI history
also remains available through **History**.

**New agent** writes a new `<name>.agent.md` under the effective Copilot home's
`agents` directory, using standard name/description YAML frontmatter and Markdown
instructions (up to 30,000 characters). The filename is restricted to safe agent
names and reserved Windows names are rejected. Creation is exclusive: existing
files are never overwritten. Model and tools inherit Copilot defaults and Darbot
keeps its explicit-approval policy. The UI then requests a real ACP conversation
for that agent and adds the returned session to the sidebar.

Darbot preferences persist imported agent IDs and workspace chat metadata
(session IDs, names, titles, folders and timestamps), not message bodies.
Conversation loading uses ACP replay. Unsent drafts remain in window memory
while switching chats. Old preferences with no import decision enter the optional
selection step rather than silently importing every discovered agent.

ACP replay does not itself restore custom-agent selection in the verified CLI.
Loading a known-agent chat therefore passes its recorded agent back through
the negotiated configuration contract before another prompt is enabled.

Container engine/Windows prerequisite probes run only on the container install
path, off the native UI thread. Selecting GitHub does not run or configure WSL,
Docker or Podman.

### Agent-linked history in desktop 0.0.15

The history card places Agents above Conversations, lists per-agent counts and
searches titles/folders without restricting the initial view to the current
folder. It follows every ACP history cursor; only the displayed rows are paged.

ACP `session/list` supplies session IDs, titles, working folders and timestamps,
but does not supply custom-agent attribution in CLI 1.0.86-0. Darbot reads the
documented SDK `subagent.selected` event from the initial portion of the matching
local `session-state/<sessionId>/events.jsonl`. Child-task events are ignored.
Reading stops at the initial agent selection or first assistant answer, with a
2 MiB ceiling per header. Unchanged files are cached in memory. Transcript text
is not returned, copied or indexed, and reading history never resumes a session.

Sessions with no initial custom-agent selection are labeled **Copilot CLI**.
Unreadable or oversized metadata is explicitly marked **Agent unavailable**
rather than guessed. Session-scoped `agency-rendered-<hex>:<agent>` prefixes are
normalized to the recorded agent suffix so histories such as `dayour-swe` and
`dayour-notes` remain grouped across plugin instances.

### Implemented in desktop 0.0.14

- Separate, validated Copilot working folders with a native picker. The initial
  folder is the existing user home, not the container deployment directory.
- Agent-first chat, secondary conversation history, load/replay, streaming,
  cancellation, and explicit tool permissions.
- ACP session configuration for agents (including plugin agents), models and
  reasoning. The runtime's returned choices and current values are authoritative.
- Searchable skill/plugin/MCP inventory, CLI profile status, and persistent
  dark/light/system and scrolling preferences.
- `COPILOT_HOME` support, non-blocking per-source inventory failures, and graceful
  runtime cleanup.

Filesystem/terminal callbacks, elicitation, SDK-only fleet/memory management and
remote-session extensions remain future work. Darbot does not advertise these
client capabilities. Copilot's own tools, skills and configured MCP servers run
inside the CLI, subject to its permissions; they do not require Darbot to claim
filesystem or terminal callback support.

## Product model

GitHub Copilot is an agent runtime, not an OpenAI-compatible model endpoint.
Darbot must not translate a Copilot subscription into an API key for the
containerized Bot stack.

The desktop provider picker may offer **GitHub Copilot**, but selecting it
switches the runtime path:

```text
Darbot desktop
  -> Copilot ACP client
  -> copilot --acp
  -> existing ~/.copilot configuration and credential store
  -> Copilot models, agents, skills, plugins, MCP servers, tools and sessions
```

The existing OpenAI, Anthropic and compatible-endpoint choices continue through
the Darbot container and AG-UI setup path.

## Security boundary

Darbot does not read, copy, display, log or persist GitHub OAuth tokens.

Authentication is owned by Copilot CLI:

- the SDK and CLI use the logged-in user by default;
- Copilot uses the system credential store when available;
- `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN` remain supported by
  Copilot itself;
- ACP advertises terminal authentication metadata;
- Darbot launches the advertised `copilot login` flow and reconnects after it
  exits successfully.

Darbot may inspect resource metadata returned by supported CLI or protocol
methods. It must not parse private authentication files under `~/.copilot`.

Darbot may read user-authored resource definitions under `~/.copilot/agents`
and `~/.copilot/skills`. Only bounded frontmatter metadata needed by the UI is
returned to React. Prompt bodies, absolute paths and unrelated files in the
Copilot home remain in the native process.

Creating an agent is an explicit UI action. Only the newly entered definition
is written; import/discovery is read-only. See the
[GitHub custom-agent configuration reference](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
for the shared profile format.

Any command output containing paths, endpoints or environment metadata is
developer detail. The default UI shows names, status and counts. Authorization
headers and secret values must remain redacted.

## Protocol layers

### ACP v1 baseline

Darbot launches:

```text
copilot --acp --stdio --no-auto-update
```

Communication is bidirectional JSON-RPC 2.0, one JSON object per line over
stdin/stdout. Diagnostics are read from stderr and must never be parsed as
protocol messages.

Darbot initializes with its supported capabilities and implementation metadata:

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {
      "auth": { "terminal": true }
    },
    "clientInfo": {
      "name": "darbot",
      "title": "Darbot",
      "version": "<desktop version>"
    }
  }
}
```

The implementation must negotiate capabilities from the response. It must not
call optional methods unless the corresponding capability is advertised.

The installed Copilot CLI currently advertises:

- session creation and prompts;
- `loadSession`;
- `sessionCapabilities.list`;
- `sessionCapabilities.close`;
- HTTP and SSE MCP transports;
- image and embedded-context prompts;
- terminal authentication using `copilot login`.

Session creation additionally returns select-style `configOptions` for `agent`,
`model`, `reasoning_effort`, `mode`, and `allow_all` in the verified CLI. Selectors
come from these options; the client never assumes a particular list of models
or requires a paid tier. Access and billing remain controlled by Copilot.

Use `session/set_config_option` with `sessionId`, `configId` and `value`, then
replace the full config state with the response's `configOptions`. Also apply
`config_option_update` notifications. Agent selection through `--agent` was
observed to leave `currentValue` empty in ACP mode; it is not the selection
contract. This uses standard ACP and needs no SDK bridge.

Darbot keeps `allow_all` off, offers Agent/Plan modes, and refuses an Autopilot
change that would silently enable allow-all. Resumed sessions are brought back
to the explicit-approval policy before accepting another prompt.

### Copilot SDK protocol v3 extensions

ACP is the portable baseline. Some Copilot-specific features are available only
through the Copilot SDK JSON-RPC namespace, including typed access to:

- model discovery and selection;
- custom agent discovery;
- tasks, fleet and factories;
- plugin listing and reload;
- detailed MCP management;
- workspaces and plan operations;
- usage, context attribution and richer lifecycle events;
- remote sessions and Copilot-specific session metadata;
- experimental fusion APIs.

Darbot should negotiate and isolate this layer behind a `CopilotExtendedClient`
interface. The UI must continue to work when only ACP is available.

The Rust Copilot SDK currently requires Rust 1.94 and edition 2024, while the
Darbot desktop crate declares Rust 1.77. Directly adding that crate would be an
unrelated toolchain migration. Until Darbot intentionally raises its Rust
minimum, the extended client should use one of these approaches:

1. a small versioned bridge built from the Node SDK and packaged as a sidecar;
2. a generated protocol-v3 client maintained from the upstream schema;
3. a future Rust SDK release compatible with Darbot's supported toolchain.

Raw, hand-maintained method strings spread through Tauri commands are not an
acceptable implementation.

## Resource discovery

Use supported commands for resources that already have stable JSON output:

| Resource | Command | Notes |
| --- | --- | --- |
| Plugins | `copilot plugin list --json` | Name, marketplace, version, enabled state and source |
| Skills | `copilot skill list --json` | Name, description, source, path and enabled state |
| MCP servers | `copilot mcp list --json` | Source, transport, tools and enabled state; secrets are redacted |
| Initial personal agents | Top-level `COPILOT_HOME/agents/*.md` frontmatter | Bounded name, description and optional model; prompt bodies stay native |
| Session agents | ACP `configOptions` with `id: "agent"` | Authoritative default, personal and plugin choices, including CLI-validated names |

Capture stdout and stderr separately. Copilot can emit skill validation warnings
while producing valid JSON. Stderr becomes a non-blocking warning list; it must
not corrupt stdout parsing.

Use ACP or the extended client for:

| Resource | Protocol |
| --- | --- |
| Sessions | ACP `session/list`, `session/load`, `session/resume`, `session/close`, `session/delete` when advertised |
| Messages | ACP `session/prompt` and streamed `session/update` |
| Tool activity | ACP `tool_call` and `tool_call_update` session updates |
| Permissions | ACP `session/request_permission` |
| Plans | ACP plan updates; extended plan RPCs when available |
| Models | ACP session config options or extended `models.list` |
| Agents | ACP session configuration; personal frontmatter is only a pre-session convenience |
| Memory | Copilot session configuration and events; never private-file parsing |
| Tasks and subagents | Extended tasks, fleet and factory RPCs |

## Tauri backend

The backend owns all child processes and protocol state.

```rust
struct CopilotRuntime {
    process: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr: StderrCollector,
    next_request_id: u64,
    negotiated: CopilotCapabilities,
    sessions: HashMap<String, CopilotSessionState>,
}
```

The runtime belongs in managed Tauri state and is serialized behind a mutex or
an actor channel. React must never hold process handles or protocol cursors.

Required commands:

| Tauri command | Purpose |
| --- | --- |
| `copilot_status` | Locate the CLI, initialize ACP, return version, negotiated capabilities and authentication requirement |
| `copilot_inventory` | Return personal-agent, plugin, skill and MCP summaries plus warnings |
| `copilot_agents` | Read personal-agent metadata for optional import without starting a session |
| `copilot_agent_create` | Create a validated, non-overwriting personal agent definition |
| `copilot_workspace` | Validate a supplied folder or return the existing user-home default, plus the effective Copilot home |
| `copilot_pick_directory` | Native folder selection; cancellation leaves the current workspace unchanged |
| `copilot_sessions` | Return cursor-paginated ACP session metadata |
| `copilot_history` | Read every history page and associate sessions with bounded, read-only initial-agent metadata |
| `copilot_login` | Run the ACP-advertised terminal authentication command, then reconnect |
| `copilot_session_new` | Create a session for an absolute working directory |
| `copilot_session_load` | Load a selected session and replay updates |
| `copilot_session_configure` | Set an advertised session option and return the complete configuration |
| `copilot_session_prompt` | Send text (image/embedded context controls are not yet exposed) |
| `copilot_session_cancel` | Cancel the active turn and pending permission requests |
| `copilot_session_close` | Close active resources without deleting history |
| `copilot_session_delete` (future) | Delete history only when advertised and explicitly confirmed |
| `copilot_permission_respond` | Return the user's selected ACP permission outcome |

Long-running reads belong on background threads or the async runtime. Closing
Darbot must terminate the ACP child after active requests are cancelled.

## Client callbacks

Darbot advertises only capabilities it fully implements.

The filesystem, terminal and elicitation designs below are not enabled in
0.0.14. Unknown callbacks receive a method-not-found response rather than being
silently approved.

### Filesystem

`fs/read_text_file` and `fs/write_text_file` are restricted to the session's
effective roots: the primary working directory plus negotiated additional
directories. Paths are canonicalized before access. Writes use the existing
Darbot confirmation and audit model.

### Terminal

ACP terminal processes use the existing no-console process wrapper and are
tracked by terminal ID. Darbot enforces:

- absolute or session-relative working directories inside allowed roots;
- separate stdout and stderr capture;
- output byte limits at UTF-8 character boundaries;
- specific-process kill and release;
- explicit permission before execution unless a stored policy allows it.

### Permissions and elicitation

Permission requests are shown in the Tauri UI with the exact options provided
by Copilot. Darbot does not silently upgrade `allow_once` to `allow_always`.

Pending requests are correlated by JSON-RPC request ID and session ID. Cancelling
a turn returns the ACP `cancelled` outcome for every pending permission request.

Structured elicitation maps to the existing form/dialog primitives. URL
elicitation opens only after URL validation and user confirmation.

## Frontend

The provider row reads:

```text
GitHub Copilot
Use your Copilot Free, Pro, Pro+, Business or Enterprise access.
```

The selected panel shows:

- CLI version and authentication state;
- available model count when model discovery is supported;
- agent, plugin, skill and MCP counts (session history stays secondary);
- non-blocking resource warnings;
- **Sign in with GitHub Copilot** when ACP requires authentication;
- **Continue with GitHub Copilot** only after the runtime is ready.

The Copilot route is a workspace, not the existing two-field Ask proof screen.
It is agent-first: the person selects a coworker, and session IDs remain
transport state rather than the primary navigation. It needs:

- personal-agent selection and new conversations;
- session load, resume, close and delete as secondary history controls where supported;
- streamed assistant content and tool calls;
- model, mode and agent selectors when advertised;
- permission and elicitation dialogs;
- stop/cancel controls;
- plugin, skill and MCP inventory;
- memory, usage and context indicators when available.

Unsupported capabilities are hidden or disabled with an explanation. They are
not represented by controls that fail after being clicked.

## Error handling

User-facing failures carry a short action and technical detail:

- CLI missing: install GitHub Copilot CLI, then retry;
- protocol mismatch: update Darbot or Copilot CLI;
- authentication required: run the advertised login flow;
- invalid inventory JSON: keep the previous inventory and show stderr/details;
- ACP child exit: preserve session IDs, reconnect, and offer load/resume;
- permission timeout or cancellation: return `cancelled`, not an error-shaped
  success;
- unsupported method: disable the feature from negotiated capabilities.

No broad catch may turn a failed protocol request into an empty list or a ready
status.

## Delivery phases

1. **Probe and inventory**
   - detect CLI and ACP capabilities;
   - list sessions, plugins, skills and MCP servers;
   - show authentication and validation warnings.
2. **Agent workspace**
   - initial personal-agent discovery and authoritative ACP agent selection;
   - new, list, load, prompt, stream, cancel and close;
   - model/reasoning configuration and permission UI;
   - future elicitation, filesystem and terminal callbacks.
3. **Copilot-specific extensions**
   - tasks, fleet, factories, memory management and remote-session extensions;
   - plugin reload and detailed MCP management;
   - usage, context attribution and fusion features.
4. **Packaging and compatibility**
   - version matrix and protocol fixtures;
   - sidecar or generated-client update automation;
   - Windows, macOS and Linux installer validation.

The GitHub Copilot provider requires a ready ACP runtime. Optional client
callbacks and SDK-only features are not prerequisites for CLI-owned tools.

## Validation

Release verification against the actual installed CLI must include:

- ACP initialization and capability negotiation;
- stdout/stderr separation for JSON inventory commands;
- authentication-required and authenticated session-list responses;
- cursor pagination;
- malformed protocol lines and child exit;
- permission approve, reject and cancellation paths;
- first-run GitHub connection, optional selection, and Import none landing on an empty canvas;
- new personal-agent creation and persistent left-sidebar chat navigation;
- successful prompts with multiple selected agents and real enabled skills;
- profile, negotiated model/reasoning settings and persisted UI preferences;
- React loading, warning, login, ready and unsupported-capability states;
- process cleanup when the app quits or the runtime is switched;
- content-only screenshots of the installed release, with credentials and
  account identifiers excluded.

This release is verified through production code and real runtime calls, not
mocked IPC or fabricated conversation fixtures. A compile/build alone does not
establish UI functionality. Record any skipped or blocked live check explicitly.
