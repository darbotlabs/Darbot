//! Supported GitHub Copilot CLI discovery for the desktop shell.
//!
//! Local authentication belongs to Copilot CLI. ACP supplies session
//! configuration, including authoritative agent/model choices. CLI JSON supplies resource inventory.
//! Only public agent frontmatter is read locally, for the picker before a session exists.
//! Opt-in Studio discovery uses subscription-scoped Azure CLI tokens only in memory, never for ACP.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::copilot_client::{terminals, ClientConsent, ConsentDecision};
use crate::copilot_extensions::elicitation;
use crate::copilot_files::{self, ReadTextFile, WriteTextFile};
use crate::history_sources::ledger::{record_protocol_audit, AuditOutcome, ProtocolOperation};
use crate::problem::Problem;
use crate::quiet;

const ACP_TIMEOUT: Duration = Duration::from_secs(15);
const ACP_SESSION_TIMEOUT: Duration = Duration::from_secs(120);
const ACP_SESSION_OPEN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const ACP_PROMPT_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const STDERR_TIMEOUT: Duration = Duration::from_secs(1);
const DIAGNOSTIC_LIMIT: usize = 16 * 1024;
const AGENT_METADATA_LIMIT: usize = 2 * 1024 * 1024;
const HISTORY_BATCH_SIZE: usize = 100;

// Diagnostics deliberately has no fields for URLs, identities, paths, errors or tool content.
mod diagnostics {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{collections::VecDeque, sync::LazyLock, time::UNIX_EPOCH};

    #[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
    #[serde(rename_all = "kebab-case")]
    pub(crate) enum Operation {
        Identity,
        VerifyAccount,
        Bots,
        Workflows,
        CanvasApps,
        ModelDrivenApps,
        AcpInitialize,
        AcpListSessions,
        ListPlugins,
        ListSkills,
        ListMcp,
        SdkStart,
        SdkStatus,
        SdkVerifyAuth,
        SdkPlugins,
        SdkAgents,
        SdkTasks,
        SdkRemote,
        FallbackPlugins,
    }

    #[derive(Debug, Copy, Clone, Eq, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub(super) struct Call {
        pub at_unix_ms: u64,
        pub latency_ms: u64,
        pub succeeded: bool,
        pub http_status: Option<u16>,
    }

    #[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub(super) struct History {
        pub last_call: Call,
        pub last_success: Option<Call>,
        pub last_failure: Option<Call>,
    }
    pub(super) type Observations = BTreeMap<Operation, History>;

    pub(super) fn record(rows: &mut Observations, op: Operation, call: Call) {
        let history = rows.entry(op).or_insert(History {
            last_call: call,
            last_success: None,
            last_failure: None,
        });
        history.last_call = call;
        if call.succeeded {
            history.last_success = Some(call);
        } else {
            history.last_failure = Some(call);
        }
    }

    pub(super) fn finished(
        start: Instant,
        succeeded: bool,
        http_status: Option<u16>,
    ) -> Option<Call> {
        Some(Call {
            at_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_millis()
                .try_into()
                .ok()?,
            latency_ms: start.elapsed().as_millis().try_into().ok()?,
            succeeded,
            http_status,
        })
    }

    // Transport observations outside Studio live only for this process. Keep a bounded set
    // of workspace buckets, without storing the path in the registry or returning it to UI.
    type Scope = Option<[u8; 32]>;
    type Buckets = VecDeque<(Scope, Observations)>;
    static LOCAL: LazyLock<Mutex<Buckets>> = LazyLock::new(Default::default);

    fn scope(cwd: Option<&str>) -> Scope {
        cwd.map(|path| Sha256::digest(path.as_bytes()).into())
    }

    pub(crate) fn local(cwd: Option<&str>, op: Operation, start: Instant, succeeded: bool) {
        let Some(call) = finished(start, succeeded, None) else {
            return;
        };
        let key = scope(cwd);
        let Ok(mut buckets) = LOCAL.lock() else {
            return;
        };
        let mut rows = buckets
            .iter()
            .position(|(k, _)| *k == key)
            .and_then(|i| buckets.remove(i))
            .map(|(_, rows)| rows)
            .unwrap_or_default();
        record(&mut rows, op, call);
        buckets.push_front((key, rows));
        buckets.truncate(64);
    }

    pub(super) fn snapshot(cwd: Option<&str>) -> Observations {
        let key = scope(cwd);
        LOCAL
            .lock()
            .ok()
            .and_then(|b| b.iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone()))
            .unwrap_or_default()
    }

    pub(super) fn reading<T>(
        cwd: Option<&str>,
        op: Operation,
        read: impl FnOnce() -> Result<T, Problem>,
    ) -> Result<T, Problem> {
        let started = Instant::now();
        let result = read();
        local(cwd, op, started, result.is_ok());
        result
    }
}
use diagnostics::Observations;
pub(crate) use diagnostics::{local as record_transport, Operation};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CopilotAuthentication {
    Ready,
    Required,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotCapabilities {
    pub load_session: bool,
    pub resume_session: bool,
    pub list_sessions: bool,
    pub close_session: bool,
    pub delete_session: bool,
    pub prompt_image: bool,
    pub prompt_embedded_context: bool,
    pub mcp_http: bool,
    pub mcp_sse: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotAuthMethod {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotStatus {
    pub version: String,
    pub protocol_version: u64,
    pub authentication: CopilotAuthentication,
    pub capabilities: CopilotCapabilities,
    pub auth_methods: Vec<CopilotAuthMethod>,
    pub session_count: usize,
    pub has_more_sessions: bool,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    observations: Observations,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotPlugin {
    pub name: String,
    pub marketplace: Option<String>,
    pub version: Option<String>,
    pub enabled: bool,
    pub source: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotAgent {
    pub id: String,
    pub name: String,
    pub description: String,
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition: Option<LocalDefinition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<StudioAgentSource>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDefinition {
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified_at_unix: Option<u64>,
    pub declared_id: Option<String>,
    pub tools: Vec<DeclaredTool>,
    pub omitted_entries: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct DeclaredTool {
    pub name: String,
    pub field: String,
    pub server: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioAgentSource {
    #[serde(deserialize_with = "deserialize_studio_provider")]
    pub provider: String,
    pub tenant_id: String,
    pub environment_id: String,
    pub environment_name: String,
    pub environment_url: String,
    pub bot_id: String,
    pub schema_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_description: Option<String>,
    pub modified_at: String,
    pub state_code: i64,
    pub last_synced_at: u64,
}

fn deserialize_studio_provider<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    let provider = String::deserialize(deserializer)?;
    if provider != "copilot-studio" {
        return Err(serde::de::Error::custom(
            "Unsupported Studio source provider",
        ));
    }
    Ok(provider)
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioSourceStatus {
    pub tenant_id: String,
    pub environment_id: String,
    pub environment_name: String,
    pub environment_url: String,
    pub state: String,
    pub agent_count: usize,
    pub last_synced_at: Option<u64>,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assets: Option<Vec<StudioAsset>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asset_warnings: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    observations: Observations,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StudioAsset {
    pub kind: String,
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotAgentCatalog {
    pub agents: Vec<CopilotAgent>,
    pub sources: Vec<StudioSourceStatus>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotSkill {
    pub name: String,
    pub description: Option<String>,
    pub enabled: bool,
    pub source: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotMcpServer {
    pub name: String,
    pub enabled: bool,
    pub source: Option<String>,
    pub transport: Option<String>,
    pub tool_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotInventory {
    pub agents: Vec<CopilotAgent>,
    pub sources: Vec<StudioSourceStatus>,
    pub plugins: Vec<CopilotPlugin>,
    pub skills: Vec<CopilotSkill>,
    pub mcp_servers: Vec<CopilotMcpServer>,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    observations: Observations,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotWorkspace {
    pub cwd: String,
    pub home: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotSessionInfo {
    pub session_id: String,
    pub cwd: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotSessionPage {
    pub sessions: Vec<CopilotSessionInfo>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotHistorySession {
    #[serde(flatten)]
    pub session: CopilotSessionInfo,
    pub agent_id: String,
    pub agent_name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotHistoryAgent {
    pub id: String,
    pub name: String,
    pub conversation_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotHistory {
    pub sessions: Vec<CopilotHistorySession>,
    pub agents: Vec<CopilotHistoryAgent>,
    pub warnings: Vec<String>,
    pub timings: CopilotHistoryTimings,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotHistoryTimings {
    pub connection_ms: u128,
    pub listing_ms: u128,
    pub indexing_ms: u128,
    pub first_page_ms: Option<u128>,
    pub total_ms: u128,
}

#[derive(Clone)]
struct CachedHistoryAgent {
    size: u64,
    modified: Option<SystemTime>,
    agent: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotSession {
    pub session_id: String,
    pub cwd: String,
    pub modes: Option<Value>,
    pub config_options: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotSessionConfig {
    pub config_options: Value,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotPromptResult {
    pub stop_reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotPermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotPermissionRequest {
    pub request_id: String,
    pub session_id: String,
    pub origin: CopilotPermissionOrigin,
    pub tool_call: Value,
    pub options: Vec<CopilotPermissionOption>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CopilotPermissionOrigin {
    Conversation,
    Background,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginRecord {
    name: String,
    marketplace: Option<String>,
    version: Option<String>,
    enabled: bool,
    source: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillRecord {
    name: String,
    description: Option<String>,
    enabled: bool,
    source: Option<String>,
}

#[derive(Default)]
pub struct CopilotRuntimeState {
    runtime: Mutex<Option<Arc<CopilotRuntime>>>,
    connecting: Mutex<()>,
    connection_generation: AtomicU64,
    history_agents: Mutex<HashMap<PathBuf, CachedHistoryAgent>>,
    pub consent: Arc<ClientConsent>,
}

impl CopilotRuntimeState {
    fn connected<R: Runtime>(&self, app: &AppHandle<R>) -> Result<Arc<CopilotRuntime>, Problem> {
        let _connecting = self.connecting.lock().unwrap();
        let generation = self.connection_generation.load(Ordering::SeqCst);
        let mut runtime = self.runtime.lock().unwrap();
        if runtime
            .as_ref()
            .is_some_and(|connection| connection.is_alive())
        {
            return Ok(Arc::clone(runtime.as_ref().unwrap()));
        }

        let previous = runtime.take();
        drop(runtime);
        if let Some(previous) = previous {
            previous.stop();
        }
        let connection = Arc::new(CopilotRuntime::start(app, Arc::clone(&self.consent))?);
        let mut runtime = self.runtime.lock().unwrap();
        if self.connection_generation.load(Ordering::SeqCst) != generation {
            drop(runtime);
            connection.stop();
            return Err(Problem::plain(
                "The connection was stopped while it was opening.",
            ));
        }
        *runtime = Some(Arc::clone(&connection));
        Ok(connection)
    }

    fn current(&self) -> Result<Arc<CopilotRuntime>, Problem> {
        self.runtime
            .lock()
            .unwrap()
            .as_ref()
            .filter(|runtime| runtime.is_alive())
            .cloned()
            .ok_or_else(|| {
                Problem::plain(
                    "GitHub Copilot is no longer connected. Start or reopen a conversation.",
                )
            })
    }

    pub fn shutdown(&self) {
        let runtime = {
            let mut runtime = self.runtime.lock().unwrap();
            self.connection_generation.fetch_add(1, Ordering::SeqCst);
            runtime.take()
        };
        if let Some(runtime) = runtime {
            runtime.stop();
        }
    }

    pub fn sessions<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        _agent: Option<String>,
        cursor: Option<String>,
        cwd: Option<String>,
    ) -> Result<CopilotSessionPage, Problem> {
        self.connected(app)?.sessions(cursor, cwd)
    }

    pub fn history<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        cwd: Option<String>,
        request_id: Option<String>,
    ) -> Result<CopilotHistory, Problem> {
        let started = Instant::now();
        let runtime = self.connected(app)?;
        let connection_ms = started.elapsed().as_millis();
        let mut listing_time = Duration::ZERO;
        let mut indexing_time = Duration::ZERO;
        let mut first_page_ms = None;
        let mut cursor = None;
        let mut cursors = HashSet::new();
        let mut seen = HashSet::new();
        let mut root = None;
        let mut agents = BTreeMap::<String, CopilotHistoryAgent>::new();
        let mut history = Vec::new();
        let mut unavailable = 0;
        let mut warnings = Vec::new();
        loop {
            let listing_started = Instant::now();
            let page = runtime.sessions(cursor, cwd.clone())?;
            listing_time += listing_started.elapsed();
            let _ = app.emit(
                "copilot:history-progress",
                json!({
                    "requestId": request_id,
                    "phase": "listing",
                    "loaded": history.len(),
                }),
            );
            let indexing_started = Instant::now();
            if !page.sessions.is_empty() && root.is_none() {
                root = Some(
                    copilot_home()?
                        .join("session-state")
                        .canonicalize()
                        .map_err(|error| {
                            Problem::with(
                                "Copilot session metadata could not be located.",
                                error.to_string(),
                            )
                        })?,
                );
            }
            let mut batch = Vec::new();
            for session in page.sessions {
                if !seen.insert(session.session_id.clone()) {
                    continue;
                }
                let root = root.as_ref().ok_or_else(|| {
                    Problem::plain("Copilot session metadata could not be located.")
                })?;
                let agent_id = match self.history_agent(root, &session.session_id) {
                    Ok(agent) => agent.unwrap_or_default(),
                    Err(problem) => {
                        unavailable += 1;
                        if warnings.len() < 3 && !warnings.contains(&problem.said) {
                            warnings.push(problem.said);
                        }
                        "__unavailable__".into()
                    }
                };
                let agent_name = match agent_id.as_str() {
                    "" => "Copilot CLI".to_string(),
                    "__unavailable__" => "Agent unavailable".to_string(),
                    name => name.to_string(),
                };
                agents
                    .entry(agent_id.clone())
                    .or_insert_with(|| CopilotHistoryAgent {
                        id: agent_id.clone(),
                        name: agent_name.clone(),
                        conversation_count: 0,
                    })
                    .conversation_count += 1;
                let entry = CopilotHistorySession {
                    session,
                    agent_id,
                    agent_name,
                };
                batch.push(entry.clone());
                history.push(entry);
                if batch.len() == HISTORY_BATCH_SIZE {
                    first_page_ms.get_or_insert_with(|| started.elapsed().as_millis());
                    let _ = app.emit(
                        "copilot:history-progress",
                        json!({
                            "requestId": request_id,
                            "phase": "indexing",
                            "loaded": history.len(),
                            "sessions": batch,
                        }),
                    );
                    batch.clear();
                }
            }
            if !batch.is_empty() {
                first_page_ms.get_or_insert_with(|| started.elapsed().as_millis());
                let _ = app.emit(
                    "copilot:history-progress",
                    json!({
                        "requestId": request_id,
                        "phase": "indexing",
                        "loaded": history.len(),
                        "sessions": batch,
                    }),
                );
            }
            indexing_time += indexing_started.elapsed();
            cursor = nonempty(page.next_cursor);
            let Some(next) = cursor.as_ref() else {
                break;
            };
            if !cursors.insert(next.clone()) {
                return Err(Problem::plain(
                    "Copilot repeated a history cursor. Reopen Conversations to retry.",
                ));
            }
        }
        if unavailable > 0 {
            warnings.insert(0, format!(
                "Agent metadata was unavailable for {unavailable} conversations. They are marked Agent unavailable rather than assigned to the wrong agent."
            ));
        }
        let mut agents: Vec<_> = agents.into_values().collect();
        agents.sort_by_key(|agent| (!agent.id.is_empty(), agent.name.to_ascii_lowercase()));
        let timings = CopilotHistoryTimings {
            connection_ms,
            listing_ms: listing_time.as_millis(),
            indexing_ms: indexing_time.as_millis(),
            first_page_ms,
            total_ms: started.elapsed().as_millis(),
        };
        eprintln!(
            "Darbot Copilot history: {} conversations; connection {} ms, listing {} ms, metadata {} ms, first page {:?} ms, total {} ms.",
            history.len(), timings.connection_ms, timings.listing_ms, timings.indexing_ms,
            timings.first_page_ms, timings.total_ms
        );
        Ok(CopilotHistory {
            sessions: history,
            agents,
            warnings,
            timings,
        })
    }

    fn history_agent(&self, root: &Path, session_id: &str) -> Result<Option<String>, Problem> {
        if session_id.is_empty()
            || session_id.len() > 128
            || !session_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(Problem::plain(
                "A conversation has no local metadata identifier.",
            ));
        }
        let path = root
            .join(session_id)
            .join("events.jsonl")
            .canonicalize()
            .map_err(|_| {
                Problem::plain("Some conversations have no readable local event metadata.")
            })?;
        if !path.starts_with(root) {
            return Err(Problem::plain(
                "Conversation metadata points outside the Copilot session folder.",
            ));
        }
        let metadata = path
            .metadata()
            .map_err(|_| Problem::plain("Some conversation metadata could not be inspected."))?;
        let modified = metadata.modified().ok();
        if let Some(cached) = self.history_agents.lock().unwrap().get(&path) {
            if modified.is_some() && cached.size == metadata.len() && cached.modified == modified {
                return Ok(cached.agent.clone());
            }
        }
        let agent = initial_history_agent(&path)?;
        self.history_agents.lock().unwrap().insert(
            path,
            CachedHistoryAgent {
                size: metadata.len(),
                modified,
                agent: agent.clone(),
            },
        );
        Ok(agent)
    }

    pub fn new_session<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        agent: Option<String>,
        cwd: String,
    ) -> Result<CopilotSession, Problem> {
        require_local_agent(agent.as_deref())?;
        let cwd = session_root(&cwd)?;
        self.connected(app)?.new_session(cwd, nonempty(agent))
    }

    pub fn load_session<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        agent: Option<String>,
        session_id: String,
        cwd: String,
    ) -> Result<CopilotSession, Problem> {
        require_local_agent(agent.as_deref())?;
        let cwd = session_root(&cwd)?;
        self.connected(app)?.load_session(session_id, cwd, agent)
    }

    pub fn resume_session<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        agent: Option<String>,
        session_id: String,
        cwd: String,
    ) -> Result<CopilotSession, Problem> {
        require_local_agent(agent.as_deref())?;
        let cwd = session_root(&cwd)?;
        self.connected(app)?.resume_session(session_id, cwd, agent)
    }

    pub fn prompt<R: Runtime>(
        &self,
        _app: &AppHandle<R>,
        agent: Option<String>,
        session_id: String,
        prompt: String,
    ) -> Result<CopilotPromptResult, Problem> {
        require_local_agent(agent.as_deref())?;
        self.current()?.prompt(session_id, prompt)
    }

    pub fn cancel<R: Runtime>(
        &self,
        _app: &AppHandle<R>,
        _agent: Option<String>,
        session_id: String,
    ) -> Result<(), Problem> {
        self.current()?.cancel(session_id)
    }

    pub fn close_session<R: Runtime>(
        &self,
        _app: &AppHandle<R>,
        _agent: Option<String>,
        session_id: String,
    ) -> Result<(), Problem> {
        let runtime = self.runtime.lock().unwrap().clone();
        if let Some(runtime) = runtime {
            if runtime.is_alive() {
                return runtime.close_session(session_id);
            }
            runtime.core.sessions.lock().unwrap().remove(&session_id);
        }
        Ok(())
    }

    pub fn respond_permission<R: Runtime>(
        &self,
        _app: &AppHandle<R>,
        _agent: Option<String>,
        request_id: String,
        option_id: Option<String>,
    ) -> Result<(), Problem> {
        if request_id.starts_with("client:") {
            return self.consent.respond(&request_id, option_id.as_deref());
        }
        self.current()?.respond_permission(request_id, option_id)
    }

    pub fn configure(
        &self,
        session_id: String,
        config_id: String,
        value: String,
    ) -> Result<CopilotSessionConfig, Problem> {
        require_local_agent(Some(&value))?;
        self.current()?.configure(session_id, config_id, value)
    }

    pub fn delete_session(&self, session_id: String) -> Result<(), Problem> {
        self.current()?.delete_session(session_id)
    }

    pub fn set_mode(&self, session_id: String, mode_id: String) -> Result<Value, Problem> {
        self.current()?.set_mode(session_id, mode_id)
    }

    pub fn respond_elicitation(
        &self,
        request_id: String,
        response: elicitation::Response,
    ) -> Result<(), Problem> {
        let runtime = self.current()?;
        let controller =
            runtime.core.elicitation.as_ref().ok_or_else(|| {
                Problem::plain("The runtime has no active elicitation controller.")
            })?;
        let params = controller
            .scope_for_response(&request_id, &runtime.core.identity)
            .map_err(|error| Problem::plain(error.message))?;
        let scope = runtime.core.elicitation_scope(&params)?;
        let outcome = match response.action {
            elicitation::Action::Accept => AuditOutcome::Approved,
            elicitation::Action::Decline => AuditOutcome::Rejected,
            elicitation::Action::Cancel => AuditOutcome::Cancelled,
        };
        runtime.core.audit(
            scope.current_session_id.as_deref(),
            ProtocolOperation::Elicitation,
            outcome,
        )?;
        controller
            .respond(&request_id, response, &scope)
            .map_err(|error| Problem::plain(error.message))
    }
}

fn require_local_agent(agent: Option<&str>) -> Result<(), Problem> {
    if agent.is_some_and(|id| id.trim().to_ascii_lowercase().starts_with("studio:")) {
        return Err(Problem::plain(
            "Copilot Studio agents are catalog-only here and cannot run through the local Copilot CLI ACP runtime. Open the agent in Copilot Studio instead.",
        ));
    }
    Ok(())
}

/// Read-only, positive evidence only. Never return log text, tool arguments, git errors or paths.
pub mod evidence {
    use super::*;
    use std::collections::BTreeSet;

    type Check<T> = Result<T, &'static str>;
    const LIMIT: usize = 8 * 1024 * 1024;
    const LOG: &str =
        "Local session evidence is missing, incomplete or exceeds the inspection limit.";
    const OWNER: &str = "No unambiguous successful commit for this selected agent and workspace.";
    const GIT: &str =
        "Local Git objects or origin/main could not be verified within the inspection limit.";
    const AUTHOR: &str =
        "Changed application source could not be matched to a successful edit by this agent.";
    const SNAPSHOT: &str = "Local origin/main snapshot only; not fetched or checked for freshness.";

    #[derive(Serialize)]
    pub struct Evidence {
        status: &'static str,
        commits: Vec<String>,
        points: usize,
        reason: String,
    }

    fn local_path(s: &str) -> bool {
        !s.is_empty()
            && s.len() <= 4096
            && !s.chars().any(char::is_control)
            && !s.replace('\\', "/").starts_with("//")
            && Path::new(s).is_absolute()
            && !Path::new(s)
                .components()
                .any(|c| c == std::path::Component::ParentDir)
    }

    // Shell syntax is *recognized*, never evaluated. Only a literal absolute repo and
    // one ordinary commit with literal message(s); no pipelines, substitutions or scripts.
    fn commit_command(cmd: &str, cwd: &Path) -> bool {
        fn literal(s: &str) -> Option<(&str, &str)> {
            let q = s.chars().next()?;
            let (v, tail) = if matches!(q, '\'' | '"') {
                s[1..].split_once(q)?
            } else {
                s.split_once(' ').unwrap_or((s, ""))
            };
            if v.is_empty()
                || v.contains([
                    '$', '`', '&', ';', '|', '>', '<', '\r', '\n', '!', '"', '\'',
                ])
                || !matches!(q, '\'' | '"')
                    && !v
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"/\\.:_-".contains(&b))
                || !tail.is_empty() && !tail.starts_with(' ') && matches!(q, '\'' | '"')
            {
                return None;
            }
            Some((v, tail.trim_start_matches(' ')))
        }
        let pair = cmd.strip_prefix("git -C ").and_then(literal).or_else(|| {
            cmd.strip_prefix("Set-Location ")
                .or_else(|| cmd.strip_prefix("cd "))
                .and_then(literal)
                .and_then(|(p, tail)| Some((p, tail.strip_prefix("&& git ")?)))
        });
        let Some((p, tail)) = pair else { return false };
        if Path::new(p) != cwd || !local_path(p) {
            return false;
        }
        let Some(mut tail) = tail.strip_prefix("commit ") else {
            return false;
        };
        loop {
            let Some((_, rest)) = tail.strip_prefix("-m ").and_then(literal) else {
                return false;
            };
            if rest.is_empty() {
                return true;
            }
            tail = rest;
        }
    }

    fn result_oid(data: &Value) -> Option<String> {
        if data["success"] != true || data.pointer("/shellExecution/exitCode")?.as_i64()? != 0 {
            return None;
        }
        let line = data.pointer("/result/content")?.as_str()?.lines().next()?;
        let (header, _) = line.strip_prefix('[')?.split_once("] ")?;
        let (branch, oid) = header.split_once(' ')?;
        if branch.is_empty()
            || !(7..=64).contains(&oid.len())
            || !oid.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return None;
        }
        Some(oid.to_ascii_lowercase())
    }

    #[derive(Clone)]
    struct Edit {
        path: String,
        old: String,
        new: String,
    }
    struct Candidate {
        id: String,
        edits: Vec<Edit>,
    }
    enum Call {
        Edit(Edit),
        Commit(Vec<Edit>),
        UnsupportedCommit,
    }

    // Narrow subset of the native patch tool: one file, one contiguous hunk, no moves.
    // As with `edit`, the completion must attest the path, and both blobs are checked.
    fn patch_edit(patch: &str, cwd: &Path) -> Option<Edit> {
        let body = patch
            .strip_prefix("*** Begin Patch\n")?
            .trim_end_matches('\n')
            .strip_suffix("\n*** End Patch")?;
        let (header, body) = body.split_once('\n')?;
        let (p, body, add) = if let Some(p) = header.strip_prefix("*** Add File: ") {
            (p, body, true)
        } else {
            (
                header.strip_prefix("*** Update File: ")?,
                body.strip_prefix("@@\n")?,
                false,
            )
        };
        let p = Path::new(p);
        let rel = if p.is_absolute() {
            p.strip_prefix(cwd).ok()?
        } else {
            p
        };
        let path = rel.to_str()?.replace('\\', "/");
        if !source(&path) {
            return None;
        }
        let (mut old, mut new) = (String::new(), String::new());
        for line in body.lines() {
            let (sign, text) = line.split_at_checked(1)?;
            match sign {
                " " if !add => {
                    old.push_str(text);
                    old.push('\n');
                    new.push_str(text);
                    new.push('\n');
                }
                "-" if !add => {
                    old.push_str(text);
                    old.push('\n');
                }
                "+" => {
                    new.push_str(text);
                    new.push('\n');
                }
                _ => return None,
            }
        }
        if old.trim() == new.trim() || new.trim().is_empty() || !add && old.is_empty() {
            return None;
        }
        Some(Edit { path, old, new })
    }

    fn scan(bytes: &[u8], session: &str, cwd: &Path, agent: &str) -> Check<Vec<Candidate>> {
        let mut selected = false;
        let mut seen = HashSet::new();
        let mut pending = HashMap::new();
        let mut edits = Vec::new();
        let mut found = Vec::new();
        let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
        for (i, line) in bytes
            .strip_suffix(b"\n")
            .unwrap_or(bytes)
            .split(|b| *b == b'\n')
            .enumerate()
        {
            if i >= 32_768 || line.len() > AGENT_METADATA_LIMIT {
                return Err(LOG);
            }
            let e: Value = serde_json::from_slice(line).map_err(|_| LOG)?;
            let data = &e["data"];
            let kind = e["type"].as_str().ok_or(LOG)?;
            let top = e["agentId"].is_null() && data["parentToolCallId"].is_null();
            if i == 0 {
                if kind != "session.start"
                    || data["sessionId"].as_str() != Some(session)
                    || data["context"]["cwd"].as_str().map(Path::new) != Some(cwd)
                    || !data["context"]["gitRoot"].is_null()
                        && data["context"]["gitRoot"].as_str().map(Path::new) != Some(cwd)
                {
                    return Err(OWNER);
                }
                continue;
            }
            match kind {
                "session.start" | "session.resume" | "session.workspace_changed" => {
                    return Err(OWNER)
                }
                "subagent.selected" | "subagent.deselected" if top => {
                    pending.clear();
                    edits.clear();
                    selected = kind == "subagent.selected"
                        && data["agentName"].as_str().map(selected_agent_name) == Some(agent);
                }
                "tool.execution_start" => {
                    let id = data["toolCallId"].as_str().ok_or(LOG)?;
                    if !seen.insert(id.to_owned()) {
                        return Err(LOG);
                    }
                    if !top
                        || !selected
                        || data.get("mcpServerName").is_some()
                        || data.get("mcpToolName").is_some()
                    {
                        continue;
                    }
                    let args = &data["arguments"];
                    let call = match data["toolName"].as_str() {
                        Some("bash" | "powershell")
                            if args["command"]
                                .as_str()
                                .is_some_and(|s| commit_command(s, cwd))
                                && args["mode"].as_str().unwrap_or("sync") == "sync" =>
                        {
                            Call::Commit(std::mem::take(&mut edits))
                        }
                        Some("bash" | "powershell")
                            if args["command"]
                                .as_str()
                                .is_some_and(|s| s.contains("commit")) =>
                        {
                            Call::UnsupportedCommit
                        }
                        Some("apply_patch") => {
                            let Some(edit) = args.as_str().and_then(|s| patch_edit(s, cwd)) else {
                                continue;
                            };
                            Call::Edit(edit)
                        }
                        Some(tool @ ("edit" | "create")) => {
                            let change = if tool == "create" {
                                args["file_text"].as_str().map(|new| ("", new))
                            } else {
                                args["old_str"]
                                    .as_str()
                                    .filter(|s| !s.is_empty())
                                    .zip(args["new_str"].as_str())
                            };
                            let Some((p, (old, new))) = args["path"].as_str().zip(change) else {
                                continue;
                            };
                            let Some(rel) =
                                Path::new(p).strip_prefix(cwd).ok().and_then(Path::to_str)
                            else {
                                continue;
                            };
                            let path = rel.replace('\\', "/");
                            if !source(&path) || new.trim().is_empty() || old.trim() == new.trim() {
                                continue;
                            }
                            Call::Edit(Edit {
                                path,
                                old: old.into(),
                                new: new.into(),
                            })
                        }
                        _ => continue,
                    };
                    pending.insert(id.to_owned(), call);
                }
                "tool.execution_complete" => {
                    let Some(call) = data["toolCallId"]
                        .as_str()
                        .and_then(|id| pending.remove(id))
                    else {
                        continue;
                    };
                    if !top || !selected || data["success"] != true {
                        continue;
                    }
                    match call {
                        Call::Edit(edit) => {
                            let exact = data["fileEdits"].as_array().is_some_and(|items| {
                                items.len() == 1
                                    && items[0]["kind"]
                                        == if edit.old.is_empty() {
                                            "create"
                                        } else {
                                            "edit"
                                        }
                                    && items[0]["path"].as_str().map(Path::new)
                                        == Some(cwd.join(&edit.path).as_path())
                            });
                            if exact {
                                edits.push(edit)
                            }
                        }
                        Call::Commit(edits) => {
                            if let Some(id) = result_oid(data) {
                                if found.len() >= 16 {
                                    return Err(LOG);
                                }
                                found.push(Candidate { id, edits });
                            } else {
                                return Err(OWNER);
                            }
                        }
                        Call::UnsupportedCommit if result_oid(data).is_some() => return Err(OWNER),
                        Call::UnsupportedCommit => {}
                    }
                }
                _ => {}
            }
        }
        if found.is_empty() {
            Err(OWNER)
        } else {
            Ok(found)
        }
    }

    fn source(path: &str) -> bool {
        let lower = path.to_ascii_lowercase();
        let mut parts: Vec<_> = lower.split('/').collect();
        let file = parts.pop().unwrap_or("");
        let excluded = |s: &str| {
            [
                "test",
                "tests",
                "testing",
                "spec",
                "specs",
                "mock",
                "mocks",
                "fixture",
                "fixtures",
                "doc",
                "docs",
                "documentation",
                "vendor",
                "vendored",
                "generated",
                "gen",
                "build",
                "dist",
                "target",
                "node_modules",
                "third_party",
                "third-party",
                "examples",
                "samples",
                "snapshots",
                "coverage",
                "e2e",
                "stories",
                "bench",
                "benches",
                "bundle",
                "min",
                "designer",
                "pb",
                "g",
                "config",
            ]
            .contains(&s)
        };
        let stem = file.split('.').next().unwrap_or("");
        !parts.iter().any(|s| {
            s.is_empty()
                || s.starts_with('.')
                || excluded(s)
                || s.split(['.', '-', '_']).any(excluded)
        }) && parts.iter().any(|s| matches!(*s, "src" | "app" | "lib"))
            && !file.starts_with('.')
            && !file.split(['.', '-', '_']).any(excluded)
            && !file.ends_with(".d.ts")
            && !file.contains("generated")
            && !["test", "spec", "fixture", "mock", "vendor", "generated"]
                .iter()
                .any(|s| {
                    stem.starts_with(s)
                        || stem.ends_with(s)
                        || stem.trim_end_matches('s').ends_with(s)
                })
            && matches!(
                file.rsplit('.').next(),
                Some(
                    "rs" | "ts"
                        | "tsx"
                        | "js"
                        | "jsx"
                        | "py"
                        | "go"
                        | "cpp"
                        | "c"
                        | "cs"
                        | "java"
                        | "swift"
                        | "kt"
                )
            )
    }

    struct Repo {
        root: PathBuf,
        deadline: Instant,
    }
    trait Objects {
        fn git(&self, args: &[&str]) -> Check<Vec<u8>>;
        fn text(&self, args: &[&str]) -> Check<String> {
            String::from_utf8(self.git(args)?).map_err(|_| GIT)
        }
    }
    impl Objects for Repo {
        fn git(&self, args: &[&str]) -> Check<Vec<u8>> {
            if Instant::now() >= self.deadline {
                return Err(GIT);
            }
            let mut cmd = quiet::command("git");
            for (key, _) in std::env::vars_os() {
                if key
                    .to_string_lossy()
                    .to_ascii_uppercase()
                    .starts_with("GIT_")
                {
                    cmd.env_remove(key);
                }
            }
            let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
            let mut child = cmd
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", null)
                .env("GIT_ALLOW_PROTOCOL", "")
                .env("GIT_NO_LAZY_FETCH", "1")
                .env("GIT_TERMINAL_PROMPT", "0")
                .args([
                    "--no-pager",
                    "--no-replace-objects",
                    "--no-optional-locks",
                    "--literal-pathspecs",
                    "-C",
                ])
                .arg(&self.root)
                .args([
                    "-c",
                    "core.fsmonitor=false",
                    "-c",
                    "core.hooksPath=",
                    "-c",
                    "core.commitGraph=false",
                    "-c",
                    "gc.auto=0",
                ])
                .args(args)
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .stdout(Stdio::piped())
                .spawn()
                .map_err(|_| GIT)?;
            let pipe = child.stdout.take().ok_or(GIT)?;
            let reader = std::thread::spawn(move || {
                let mut out = Vec::new();
                pipe.take(512 * 1024 + 1)
                    .read_to_end(&mut out)
                    .map_err(|_| GIT)?;
                if out.len() > 512 * 1024 {
                    Err(GIT)
                } else {
                    Ok(out)
                }
            });
            let ok = loop {
                match child.try_wait() {
                    Ok(Some(s)) => break s.success(),
                    Ok(None) if Instant::now() < self.deadline => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    _ => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break false;
                    }
                }
            };
            let out = reader.join().map_err(|_| GIT)??;
            if ok {
                Ok(out)
            } else {
                Err(GIT)
            }
        }
    }

    fn full_oid(id: &str) -> bool {
        matches!(id.len(), 40 | 64) && id.bytes().all(|b| b.is_ascii_hexdigit())
    }

    fn authored(old: &str, new: &str, edit: &Edit) -> bool {
        if edit.old.is_empty() {
            if !old.is_empty() || new != edit.new {
                return false;
            }
        } else {
            let Some((before, after)) = old.split_once(&edit.old) else {
                return false;
            };
            if after.contains(&edit.old) || new != format!("{before}{}{after}", edit.new) {
                return false;
            }
        }
        // Prefer undercounting to awarding inline tests or generated code.
        let lower = new.to_ascii_lowercase();
        let previous = old.to_ascii_lowercase();
        let prior_lines: HashSet<_> = edit.old.lines().map(str::trim).collect();
        ![
            "generated",
            "#[cfg(test)]",
            "#[test",
            "mod tests",
            "describe(",
            " it(",
            "test(",
            "unittest",
            "@test",
            "#if debug",
            "codegen",
            "do not edit",
        ]
        .iter()
        .any(|m| lower.contains(m) || previous.contains(m))
            && edit.new.lines().any(|line| {
                let t = line.trim();
                !t.is_empty()
                    && !["//", "/*", "*", "#", "<!--", "///"]
                        .iter()
                        .any(|p| t.starts_with(p))
                    && !prior_lines.contains(t)
            })
    }

    fn qualifies(repo: &impl Objects, id: &str, edits: &[Edit]) -> Check<bool> {
        let parents = repo.text(&["rev-list", "--parents", "-n", "1", id, "--"])?;
        match parents.split_whitespace().count() {
            2 => {}
            3.. => return Ok(false),
            _ => return Err(AUTHOR),
        }
        let diff = repo.git(&[
            "diff-tree",
            "--no-commit-id",
            "-r",
            "--raw",
            "--no-abbrev",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "-z",
            id,
            "--",
        ])?;
        let mut records = diff.strip_suffix(b"\0").unwrap_or(&diff).split(|b| *b == 0);
        let mut app = false;
        while let Some(header) = records.next() {
            if header.is_empty() {
                break;
            }
            let path = std::str::from_utf8(records.next().ok_or(GIT)?).map_err(|_| GIT)?;
            if !source(path) {
                continue;
            }
            let fields: Vec<_> = std::str::from_utf8(header)
                .map_err(|_| GIT)?
                .split(' ')
                .collect();
            let [old_mode, new_mode, old_id, new_id, change] = fields.as_slice() else {
                return Err(GIT);
            };
            if !matches!(*new_mode, "100644" | "100755") || old_id == new_id {
                continue;
            }
            app = true;
            let added = *change == "A" && *old_mode == ":000000";
            if !(added || *change == "M" && matches!(*old_mode, ":100644" | ":100755"))
                || !full_oid(old_id)
                || !full_oid(new_id)
            {
                continue;
            }
            if edits.iter().any(|e| e.path == path) {
                let old = if added {
                    String::new()
                } else {
                    repo.text(&["cat-file", "blob", old_id])?
                };
                let new = repo.text(&["cat-file", "blob", new_id])?;
                if edits
                    .iter()
                    .filter(|e| e.path == path && e.old.is_empty() == added)
                    .any(|e| authored(&old, &new, e))
                {
                    return Ok(true);
                }
            }
        }
        if app {
            Err(AUTHOR)
        } else {
            Ok(false)
        }
    }

    fn inspect(session: &str, cwd: &str, agent: &str) -> Check<BTreeSet<String>> {
        if session.is_empty()
            || session.len() > 128
            || !session
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || !local_path(cwd)
            || agent.is_empty()
            || !public_symbol(agent)
            || agent == "*"
            || agent == "__unavailable__"
        {
            return Err(OWNER);
        }
        let home = copilot_home()
            .map_err(|_| LOG)?
            .join("session-state")
            .canonicalize()
            .map_err(|_| LOG)?;
        let path = home.join(session).join("events.jsonl");
        if path.canonicalize().map_err(|_| LOG)? != path {
            return Err(LOG);
        }
        let file = fs::File::open(path).map_err(|_| LOG)?;
        let meta = file.metadata().map_err(|_| LOG)?;
        if !meta.is_file() || meta.len() > LIMIT as u64 {
            return Err(LOG);
        }
        let mut bytes = Vec::new();
        file.take(LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| LOG)?;
        if bytes.len() as u64 != meta.len() {
            return Err(LOG);
        }
        let found = scan(&bytes, session, Path::new(cwd), agent)?;
        let root = Path::new(cwd).canonicalize().map_err(|_| GIT)?;
        if Path::new(&display_path(&root)) != Path::new(cwd) {
            return Err(GIT);
        }
        let dot = root.join(".git");
        if !dot.is_dir()
            || dot.canonicalize().map_err(|_| GIT)? != dot
            || [
                "info/grafts",
                "shallow",
                "commondir",
                "objects/info/alternates",
                "objects/info/http-alternates",
            ]
            .iter()
            .any(|s| !matches!(dot.join(s).try_exists(), Ok(false)))
        {
            return Err(GIT);
        }
        let repo = Repo {
            root,
            deadline: Instant::now() + Duration::from_secs(5),
        };
        verify(&repo, found)
    }

    fn verify(repo: &impl Objects, found: Vec<Candidate>) -> Check<BTreeSet<String>> {
        if repo
            .text(&[
                "config",
                "--local",
                "--no-includes",
                "--get",
                "remote.origin.url",
            ])?
            .trim()
            .is_empty()
            || !repo
                .text(&[
                    "config",
                    "--local",
                    "--no-includes",
                    "--get-all",
                    "remote.origin.fetch",
                ])?
                .lines()
                .any(|l| {
                    matches!(
                        l.trim_start_matches('+'),
                        "refs/heads/*:refs/remotes/origin/*"
                            | "refs/heads/main:refs/remotes/origin/main"
                    )
                })
        {
            return Err(GIT);
        }
        let main = repo.text(&["rev-parse", "--verify", "refs/remotes/origin/main"])?;
        if !full_oid(main.trim()) {
            return Err(GIT);
        }
        let history = repo.text(&["rev-list", "--max-count=4097", main.trim(), "--"])?;
        let reachable: HashSet<_> = history.lines().collect();
        let mut verified = BTreeSet::new();
        for candidate in found {
            let resolved =
                repo.text(&["rev-parse", &format!("--disambiguate={}", candidate.id)])?;
            let id = resolved.trim();
            if !full_oid(id)
                || !id.starts_with(&candidate.id)
                || repo.text(&["cat-file", "-t", id])?.trim() != "commit"
            {
                return Err(GIT);
            }
            if !reachable.contains(id) {
                if reachable.len() >= 4097 {
                    return Err(GIT);
                }
                continue;
            }
            if !verified.contains(id) && qualifies(repo, id, &candidate.edits)? {
                verified.insert(id.to_string());
            }
        }
        Ok(verified)
    }

    pub fn read(session: &str, cwd: &str, agent: &str) -> Evidence {
        match inspect(session, cwd, agent) {
            Ok(ids) => Evidence {
                status: if ids.is_empty() { "none" } else { "verified" },
                points: ids.len(),
                commits: ids.into_iter().collect(),
                reason: SNAPSHOT.into(),
            },
            Err(reason) => Evidence {
                status: "unknown",
                commits: vec![],
                points: 0,
                reason: reason.into(),
            },
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        fn root() -> &'static Path {
            Path::new(if cfg!(windows) {
                r"E:\example"
            } else {
                "/example"
            })
        }
        fn events() -> Vec<Value> {
            vec![
                json!({"type":"session.start","data":{"sessionId":"abc","context":{"cwd":root(),"gitRoot":root()}}}),
                json!({"type":"subagent.selected","data":{"agentName":"worker"}}),
                json!({"type":"tool.execution_start","data":{"toolCallId":"a","toolName":"edit","arguments":{"path":root().join("src/core.rs"),"old_str":"1","new_str":"2"}}}),
                json!({"type":"tool.execution_complete","data":{"toolCallId":"a","success":true,"fileEdits":[{"path":root().join("src/core.rs"),"kind":"edit"}]}}),
                json!({"type":"tool.execution_start","data":{"toolCallId":"b","toolName":"powershell","arguments":{"command":format!("git -C '{}' commit -m 'update'",root().display())}}}),
                json!({"type":"tool.execution_complete","data":{"toolCallId":"b","success":true,"shellExecution":{"exitCode":0},"result":{"content":"[main 1234567] update"}}}),
            ]
        }
        fn parse(events: &[Value]) -> Check<Vec<Candidate>> {
            let bytes = events
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n");
            scan(bytes.as_bytes(), "abc", root(), "worker")
        }
        #[test]
        fn joins_observed_start_result_and_edit_by_owner() {
            let mut events = events();
            let found = parse(&events).unwrap();
            assert_eq!(found.len(), 1);
            assert_eq!(found[0].id, "1234567");
            assert_eq!(found[0].edits.len(), 1);
            events[3]["agentId"] = json!("child");
            assert!(parse(&events).unwrap()[0].edits.is_empty());
        }
        #[test]
        fn no_text_or_scope_shortcuts() {
            for (i, field, v) in [
                (0, "/data/sessionId", json!("other")),
                (0, "/data/context/gitRoot", json!("elsewhere")),
                (1, "/data/agentName", json!("Worker")),
                (4, "/data/toolName", json!("custom")),
                (4, "/data/arguments/command", json!("git commit -m message")),
                (5, "/type", json!("assistant.message")),
                (5, "/data/toolCallId", json!("other")),
                (5, "/data/success", json!(false)),
                (5, "/data/shellExecution/exitCode", json!(1)),
                (5, "/data/result/content", json!("observed 1234567 in main")),
            ] {
                let mut e = events();
                *e[i].pointer_mut(field).unwrap() = v;
                assert!(parse(&e).is_err(), "{field}");
            }
            let mut e = events();
            e[4]["data"]["parentToolCallId"] = json!("nested");
            assert!(parse(&e).is_err());
            let mut e = events();
            e.insert(5, json!({"type":"subagent.deselected","data":{}}));
            assert!(parse(&e).is_err());
            let mut e = events();
            e[4]["data"]["arguments"]["command"] = json!(format!(
                "git -C '{}' commit -m ok && echo fake",
                root().display()
            ));
            assert!(parse(&e).is_err());
        }
        #[test]
        fn only_exact_application_blob_edits_count() {
            let patch = patch_edit(
                "*** Begin Patch\n*** Update File: src/core.rs\n@@\n-old\n+new\n*** End Patch",
                root(),
            )
            .unwrap();
            assert!(authored("a\nold\n", "a\nnew\n", &patch));
            assert!(patch_edit(
                "*** Begin Patch\n*** Add File: ../src/core.rs\n+new\n*** End Patch",
                root()
            )
            .is_none());
            for path in [
                "docs/src/x.ts",
                "src/vendor/x.ts",
                "src/__tests__/x.rs",
                "src/generated/x.ts",
                "src/x.spec.ts",
                "src/x_test.go",
                "src/XTests.cs",
                "src/x.fixture.js",
                "src/x.min.js",
                "src/x.pb.go",
                "src/x.generated.cs",
                "fixtures/src/x.ts",
                "src/x.d.ts",
                "src/readme.md",
            ] {
                assert!(!source(path), "{path}");
            }
            assert!(source("desktop/src/core.ts"));
            let edit = Edit {
                path: "src/core.ts".into(),
                old: "1".into(),
                new: "2".into(),
            };
            assert!(authored("return 1", "return 2", &edit));
            assert!(!authored("return 1", "return 2 + other", &edit));
            assert!(!authored(
                "#[cfg(test)] return 1",
                "#[cfg(test)] return 2",
                &edit
            ));
            assert_eq!(read("../x", "invalid", "worker").status, "unknown");
        }

        #[test]
        fn verifies_objects_ancestry_parent_count_authorship_and_dedup_without_writing_git() {
            const C: &str = "1234567890123456789012345678901234567890";
            const P: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            struct Fixture {
                kind: &'static str,
                history: &'static str,
                merge: bool,
                path: &'static str,
            }
            impl Objects for Fixture {
                fn git(&self, args: &[&str]) -> Check<Vec<u8>> {
                    let out = match args {
                        ["config", .., "remote.origin.url"] => "example".into(),
                        ["config", .., "remote.origin.fetch"] => {
                            "+refs/heads/*:refs/remotes/origin/*".into()
                        }
                        ["rev-parse", "--verify", "refs/remotes/origin/main"] => P.into(),
                        ["rev-parse", "--disambiguate=1234567"] => C.into(),
                        ["cat-file", "-t", C] => self.kind.into(),
                        ["rev-list", "--max-count=4097", P, "--"] => self.history.into(),
                        ["rev-list", "--parents", "-n", "1", C, "--"] => {
                            if self.merge {
                                format!("{C} {P} {B}")
                            } else {
                                format!("{C} {P}")
                            }
                        }
                        ["diff-tree", ..] => format!(":100644 100644 {P} {B} M\0{}\0", self.path),
                        ["cat-file", "blob", P] => "return 1".into(),
                        ["cat-file", "blob", B] => "return 2".into(),
                        _ => return Err(GIT),
                    };
                    Ok(out.into_bytes())
                }
            }
            let mut repo = Fixture {
                kind: "commit",
                history: C,
                merge: false,
                path: "src/core.rs",
            };
            let candidates = || {
                let mut f = parse(&events()).unwrap();
                f.extend(parse(&events()).unwrap());
                f
            };
            assert_eq!(verify(&repo, candidates()).unwrap().len(), 1);
            repo.path = "src/other.rs";
            assert_eq!(verify(&repo, candidates()), Err(AUTHOR));
            repo.path = "src/core_test.rs";
            assert!(verify(&repo, candidates()).unwrap().is_empty());
            repo.path = "src/core.rs";
            repo.merge = true;
            assert!(verify(&repo, candidates()).unwrap().is_empty());
            repo.merge = false;
            repo.history = P;
            assert!(verify(&repo, candidates()).unwrap().is_empty());
            repo.kind = "tag";
            assert_eq!(verify(&repo, candidates()), Err(GIT));
        }
    }
}

fn selected_agent_name(name: &str) -> &str {
    match name.split_once(':') {
        Some((ns, agent))
            if ns
                .strip_prefix("agency-rendered-")
                .is_some_and(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit())) =>
        {
            agent
        }
        _ => name,
    }
}

fn initial_history_agent(path: &Path) -> Result<Option<String>, Problem> {
    let file = fs::File::open(path)
        .map_err(|_| Problem::plain("Some conversation event headers could not be read."))?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut consumed = 0;
    while consumed < AGENT_METADATA_LIMIT {
        line.clear();
        let read = (&mut reader)
            .take((AGENT_METADATA_LIMIT - consumed) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|_| Problem::plain("Some conversation event headers could not be read."))?;
        if read == 0 {
            return Ok(None);
        }
        consumed += read;
        let bytes = line.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&line);
        if bytes.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let event: Value = serde_json::from_slice(bytes).map_err(|_| {
            Problem::plain("Some conversation event headers are incomplete or invalid.")
        })?;
        // A task's child-agent activity does not identify the conversation's own selected agent.
        if event.get("agentId").is_some_and(|id| !id.is_null())
            || event
                .pointer("/data/parentToolCallId")
                .is_some_and(|id| !id.is_null())
        {
            continue;
        }
        match event.get("type").and_then(Value::as_str) {
            Some("subagent.selected") => {
                let name = event
                    .pointer("/data/agentName")
                    .and_then(Value::as_str)
                    .filter(|name| !name.trim().is_empty())
                    .ok_or_else(|| {
                        Problem::plain("Some selected-agent records have no agent name.")
                    })?;
                let name = selected_agent_name(name);
                return Ok(Some(name.to_string()));
            }
            // --agent selection is recorded before the first assistant answer. Do not scan or
            // return entire transcripts just to classify their initial agent.
            Some("assistant.message") => return Ok(None),
            _ => {}
        }
    }
    Err(Problem::plain(
        "Some conversation headers exceed the 2 MiB metadata limit; their agent is not guessed.",
    ))
}

struct PendingPermission {
    rpc_id: Value,
    session_id: String,
    options: Vec<CopilotPermissionOption>,
    expires: Instant,
}

struct SessionState {
    cwd: String,
    config_options: Value,
    modes: Value,
}

struct RuntimeCore {
    identity: String,
    audit_root: Option<PathBuf>,
    elicitation: Option<Arc<elicitation::Controller>>,
    tool_calls: Mutex<HashMap<String, HashSet<String>>>,
    elicitation_rpc: Mutex<HashMap<String, String>>,
    client_home: PathBuf,
    consent: Arc<ClientConsent>,
    terminals: Arc<terminals::Manager>,
    client_requests: Mutex<HashMap<String, bool>>,
    report_cleanup: Arc<dyn Fn(&Problem) + Send + Sync>,
    outgoing: mpsc::SyncSender<Value>,
    pending: Mutex<HashMap<String, Sender<Result<Value, Problem>>>>,
    permissions: Mutex<HashMap<String, PendingPermission>>,
    sessions: Mutex<HashMap<String, SessionState>>,
    next_request_id: AtomicU64,
    closed: AtomicBool,
    stopping: AtomicBool,
    stderr: Mutex<String>,
}

struct CopilotRuntime {
    child: Mutex<Child>,
    opening: Mutex<()>,
    core: Arc<RuntimeCore>,
    capabilities: CopilotCapabilities,
}

impl CopilotRuntime {
    fn start<R: Runtime>(app: &AppHandle<R>, consent: Arc<ClientConsent>) -> Result<Self, Problem> {
        let client_home = copilot_home()?;
        let audit_root = app.path().app_local_data_dir().map_err(|error| {
            Problem::with("Native audit storage is unavailable.", error.to_string())
        })?;
        let identity = format!("acp-{:032x}", rand::random::<u128>());
        record_protocol_audit(
            &audit_root,
            &identity,
            None,
            ProtocolOperation::Lifecycle,
            AuditOutcome::Requested,
        )?;
        let mut child = spawn_acp_child()?;
        let stdin = take_child_stdin(&mut child)?;
        let stdout = child.stdout.take().ok_or_else(|| {
            let _ = child.kill();
            Problem::plain("GitHub Copilot CLI did not open its protocol output.")
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            let _ = child.kill();
            Problem::plain("GitHub Copilot CLI did not open its diagnostic output.")
        })?;
        let (outgoing, messages) = mpsc::sync_channel(64);
        let core = Arc::new(RuntimeCore {
            identity,
            audit_root: Some(audit_root),
            elicitation: Some(elicitation::Controller::new(
                app.clone(),
                Some(elicitation::native_patterns()),
            )),
            tool_calls: Mutex::default(),
            elicitation_rpc: Mutex::default(),
            client_home,
            consent,
            terminals: Arc::default(),
            client_requests: Mutex::default(),
            report_cleanup: {
                let app = app.clone();
                Arc::new(move |problem| {
                    if app.emit("copilot:runtime-error", problem).is_err() {
                        eprintln!("Darbot could not show an owned terminal cleanup failure.");
                    }
                })
            },
            outgoing,
            pending: Mutex::new(HashMap::new()),
            permissions: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            next_request_id: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            stderr: Mutex::new(String::new()),
        });

        start_runtime_writer(stdin, messages, Arc::downgrade(&core));
        start_runtime_stderr(stderr, Arc::downgrade(&core));
        start_runtime_stdout(stdout, Arc::downgrade(&core), app.clone());
        start_permission_expiry(Arc::downgrade(&core), app.clone());

        let capabilities = match core
            .request("initialize", initialize_params(true), ACP_TIMEOUT)
            .and_then(|initialized| parse_status(&initialized))
        {
            Ok(status) => status.capabilities,
            Err(problem) => {
                core.stopping.store(true, Ordering::SeqCst);
                core.closed.store(true, Ordering::SeqCst);
                let _ = child.kill();
                let _ = child.wait();
                return Err(problem);
            }
        };
        Ok(Self {
            child: Mutex::new(child),
            opening: Mutex::new(()),
            core,
            capabilities,
        })
    }

    fn is_alive(&self) -> bool {
        if self.core.closed.load(Ordering::SeqCst) {
            return false;
        }
        self.child
            .lock()
            .unwrap()
            .try_wait()
            .map(|status| status.is_none())
            .unwrap_or(false)
    }

    fn stop(&self) {
        self.core.stopping.store(true, Ordering::SeqCst);
        self.core.closed.store(true, Ordering::SeqCst);
        self.core.consent.cancel(&self.core.identity, None);
        fail_pending(
            &self.core,
            Problem::plain("GitHub Copilot was stopped before it answered."),
        );
        let mut child = self.child.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
        self.core.sessions.lock().unwrap().clear();
        self.core.permissions.lock().unwrap().clear();
    }

    fn sessions(
        &self,
        cursor: Option<String>,
        cwd: Option<String>,
    ) -> Result<CopilotSessionPage, Problem> {
        if !self.capabilities.list_sessions {
            return Err(Problem::plain(
                "This GitHub Copilot version does not support listing sessions.",
            ));
        }
        let mut params = serde_json::Map::new();
        if let Some(cursor) = nonempty(cursor) {
            params.insert("cursor".into(), Value::String(cursor));
        }
        if let Some(cwd) = nonempty(cwd) {
            require_absolute(Path::new(&cwd), "session filter")?;
            params.insert("cwd".into(), Value::String(cwd));
        }
        let result = self
            .core
            .request("session/list", Value::Object(params), ACP_TIMEOUT)?;
        serde_json::from_value(result).map_err(|error| {
            Problem::with(
                "GitHub Copilot returned an invalid session list.",
                error.to_string(),
            )
        })
    }

    fn new_session(&self, cwd: String, agent: Option<String>) -> Result<CopilotSession, Problem> {
        let _opening = self.opening.lock().unwrap();
        finish_session_open(
            self.open_session("session/new", json!({"cwd": cwd, "mcpServers": []}))
                .and_then(|result| parse_session(result, cwd))
                .and_then(|session| self.prepare_session(session, agent)),
            || self.stop(),
        )
    }

    fn open_session(&self, method: &str, params: Value) -> Result<Value, Problem> {
        self.core
            .request_with_timeout(method, params, ACP_SESSION_OPEN_TIMEOUT, || {
                Problem::with(
                    "Copilot took too long to open the conversation. Your message was not sent. \
                     Check unavailable MCP servers in Resources before retrying.",
                    format!(
                        "ACP {method} exceeded {} seconds; the owned CLI runtime was stopped.",
                        ACP_SESSION_OPEN_TIMEOUT.as_secs()
                    ),
                )
            })
    }

    fn load_session(
        &self,
        session_id: String,
        cwd: String,
        agent: Option<String>,
    ) -> Result<CopilotSession, Problem> {
        if !self.capabilities.load_session {
            return Err(Problem::plain(
                "This GitHub Copilot version does not support loading sessions.",
            ));
        }
        self.restore_session("session/load", session_id, cwd, agent)
    }

    fn resume_session(
        &self,
        session_id: String,
        cwd: String,
        agent: Option<String>,
    ) -> Result<CopilotSession, Problem> {
        if !self.capabilities.resume_session {
            return Err(Problem::plain(
                "This GitHub Copilot version does not support resuming sessions without replay.",
            ));
        }
        self.restore_session("session/resume", session_id, cwd, agent)
    }

    fn restore_session(
        &self,
        method: &str,
        session_id: String,
        cwd: String,
        agent: Option<String>,
    ) -> Result<CopilotSession, Problem> {
        let _opening = self.opening.lock().unwrap();
        let session_id = required_text(session_id, "session ID")?;
        if self.core.sessions.lock().unwrap().contains_key(&session_id) {
            return Err(Problem::plain("The selected session is already active. Close it before loading or resuming it again."));
        }
        let cwd = session_root(&cwd)?;
        finish_session_open(
            self.open_session(
                method,
                json!({"sessionId": session_id, "cwd": cwd, "mcpServers": []}),
            )
            .and_then(|result| parse_session_setup(session_id, cwd, result))
            .and_then(|session| self.prepare_session(session, agent)),
            || self.stop(),
        )
    }

    fn prepare_session(
        &self,
        mut session: CopilotSession,
        agent: Option<String>,
    ) -> Result<CopilotSession, Problem> {
        self.core.terminals.activate(&session.session_id)?;
        self.core.sessions.lock().unwrap().insert(
            session.session_id.clone(),
            SessionState {
                cwd: session.cwd.clone(),
                config_options: session.config_options.clone().unwrap_or_else(|| json!([])),
                modes: session.modes.clone().unwrap_or(Value::Null),
            },
        );
        // A resumed autopilot session must not silently bypass the native permission UI.
        for (id, allowed) in [
            ("allow_all", "off"),
            (
                "mode",
                "https://agentclientprotocol.com/protocol/session-modes#agent",
            ),
        ] {
            let should_reset = session
                .config_options
                .as_ref()
                .and_then(Value::as_array)
                .and_then(|options| options.iter().find(|option| option["id"] == id))
                .and_then(|option| option["currentValue"].as_str())
                .is_some_and(|current| {
                    (id == "allow_all" && current != "off")
                        || (id == "mode" && unattended_mode(current))
                });
            if should_reset {
                session.config_options = Some(
                    self.configure(session.session_id.clone(), id.into(), allowed.into())?
                        .config_options,
                );
            }
        }
        if session
            .modes
            .as_ref()
            .and_then(|modes| modes["currentModeId"].as_str())
            .is_some_and(unattended_mode)
        {
            let safe_mode = session
                .modes
                .as_ref()
                .and_then(|modes| modes["availableModes"].as_array())
                .and_then(|modes| {
                    modes
                        .iter()
                        .filter_map(|mode| mode["id"].as_str())
                        .find(|id| *id == "agent" || id.ends_with("#agent"))
                })
                .ok_or_else(|| {
                    Problem::plain("The resumed session has no approval-preserving Agent mode.")
                })?
                .to_string();
            session.modes = Some(self.set_mode(session.session_id.clone(), safe_mode)?);
        }
        if let Some(agent) = agent {
            session.config_options = Some(
                self.configure(session.session_id.clone(), "agent".into(), agent)?
                    .config_options,
            );
        }
        Ok(session)
    }

    fn configure(
        &self,
        session_id: String,
        config_id: String,
        value: String,
    ) -> Result<CopilotSessionConfig, Problem> {
        let session_id = self.known_session(session_id)?;
        let config_id = required_text(config_id, "configuration ID")?;
        {
            let sessions = self.core.sessions.lock().unwrap();
            let option = sessions
                .get(&session_id)
                .and_then(|session| session.config_options.as_array())
                .and_then(|options| options.iter().find(|option| option["id"] == config_id))
                .ok_or_else(|| {
                    Problem::plain("This Copilot session does not offer that setting.")
                })?;
            if option["type"] != "select" || !config_has_value(&option["options"], &value) {
                return Err(Problem::plain(
                    "That Copilot setting value is not available. Refresh the session settings.",
                ));
            }
            if (config_id == "allow_all" && value != "off")
                || (config_id == "mode" && unattended_mode(&value))
            {
                return Err(Problem::plain(
                    "Darbot keeps tool approval enabled. Use Agent or Plan mode.",
                ));
            }
        }
        let result = self.core.request(
            "session/set_config_option",
            json!({"sessionId": session_id, "configId": config_id, "value": value}),
            ACP_SESSION_TIMEOUT,
        )?;
        let config_options = result
            .get("configOptions")
            .filter(|options| options.is_array())
            .cloned()
            .ok_or_else(|| {
                Problem::plain("GitHub Copilot returned an invalid configuration response.")
            })?;
        if let Some(session) = self.core.sessions.lock().unwrap().get_mut(&session_id) {
            session.config_options = config_options.clone();
        }
        Ok(CopilotSessionConfig { config_options })
    }

    fn set_mode(&self, session_id: String, mode_id: String) -> Result<Value, Problem> {
        let session_id = self.known_session(session_id)?;
        let mode_id = required_text(mode_id, "mode ID")?;
        {
            let sessions = self.core.sessions.lock().unwrap();
            let modes = &sessions
                .get(&session_id)
                .ok_or_else(|| Problem::plain("The session closed."))?
                .modes;
            validate_mode(modes, &mode_id)?;
        }
        self.core.request(
            "session/set_mode",
            json!({"sessionId":session_id,"modeId":mode_id}),
            ACP_SESSION_TIMEOUT,
        )?;
        let mut sessions = self.core.sessions.lock().unwrap();
        let session = sessions
            .get_mut(&session_id)
            .ok_or_else(|| Problem::plain("The session closed while its mode was changing."))?;
        session.modes["currentModeId"] = json!(mode_id);
        Ok(session.modes.clone())
    }

    fn delete_session(&self, session_id: String) -> Result<(), Problem> {
        let session_id = required_text(session_id, "session ID")?;
        if !self.capabilities.delete_session {
            return Err(Problem::plain(
                "This GitHub Copilot version does not support deleting sessions.",
            ));
        }
        self.core.sessions.lock().unwrap().remove(&session_id);
        let terminals = self.core.terminals.cancel(Some(&session_id), true);
        let permissions = self.core.cancel_permissions(&session_id);
        terminals?;
        permissions?;
        self.core.request(
            "session/delete",
            json!({"sessionId": session_id}),
            ACP_TIMEOUT,
        )?;
        Ok(())
    }

    fn prompt(&self, session_id: String, prompt: String) -> Result<CopilotPromptResult, Problem> {
        let session_id = self.known_session(session_id)?;
        let prompt = required_text(prompt, "prompt")?;
        let result = self.core.request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{"type": "text", "text": prompt}],
            }),
            ACP_PROMPT_TIMEOUT,
        );
        if result.is_err() {
            let _ = self.cancel(session_id.clone());
        }
        let result = result?;
        let stop_reason = result
            .get("stopReason")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                Problem::with(
                    "GitHub Copilot returned an invalid prompt result.",
                    result.to_string(),
                )
            })?
            .to_string();
        Ok(CopilotPromptResult { stop_reason })
    }

    fn cancel(&self, session_id: String) -> Result<(), Problem> {
        let session_id = self.known_session(session_id)?;
        let terminals = self.core.terminals.cancel(Some(&session_id), false);
        let permissions = self.core.cancel_permissions(&session_id);
        let notified = self
            .core
            .notify("session/cancel", json!({"sessionId": session_id}));
        terminals?;
        permissions?;
        notified
    }

    fn close_session(&self, session_id: String) -> Result<(), Problem> {
        let session_id = required_text(session_id, "session ID")?;
        if self
            .core
            .sessions
            .lock()
            .unwrap()
            .remove(&session_id)
            .is_none()
        {
            return Ok(());
        }
        let terminals = self.core.terminals.cancel(Some(&session_id), true);
        let permissions = self.core.cancel_permissions(&session_id);
        terminals?;
        permissions?;
        if !self.capabilities.close_session {
            return Err(Problem::plain(
                "This GitHub Copilot version does not support closing active sessions.",
            ));
        }
        self.core.request(
            "session/close",
            json!({"sessionId": session_id}),
            ACP_TIMEOUT,
        )?;
        self.core.sessions.lock().unwrap().remove(&session_id);
        Ok(())
    }

    fn respond_permission(
        &self,
        request_id: String,
        option_id: Option<String>,
    ) -> Result<(), Problem> {
        self.core.respond_permission(request_id, option_id)
    }

    fn known_session(&self, session_id: String) -> Result<String, Problem> {
        let session_id = required_text(session_id, "session ID")?;
        if self.core.sessions.lock().unwrap().contains_key(&session_id) {
            Ok(session_id)
        } else {
            Err(Problem::plain(
                "That GitHub Copilot session is not active in Darbot. Load it again.",
            ))
        }
    }
}

impl Drop for CopilotRuntime {
    fn drop(&mut self) {
        if let Some(controller) = &self.core.elicitation {
            controller.cancel_all();
        }
        self.core.stopping.store(true, Ordering::SeqCst);
        self.core.closed.store(true, Ordering::SeqCst);
        self.core.consent.cancel(&self.core.identity, None);
        if let Err(problem) = self.core.terminals.cancel(None, true) {
            (self.core.report_cleanup)(&problem);
        }
        let child = self.child.get_mut().unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl RuntimeCore {
    fn audit(
        &self,
        session: Option<&str>,
        operation: ProtocolOperation,
        outcome: AuditOutcome,
    ) -> Result<(), Problem> {
        if let Some(root) = &self.audit_root {
            record_protocol_audit(root, &self.identity, session, operation, outcome)?;
        }
        Ok(())
    }

    fn elicitation_scope(&self, params: &Value) -> Result<elicitation::ScopeContext, Problem> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(Problem::plain("The requesting runtime has closed."));
        }
        let session = params.get("sessionId").and_then(Value::as_str);
        if session.is_some_and(|id| !self.sessions.lock().unwrap().contains_key(id)) {
            return Err(Problem::plain(
                "The elicitation session is not owned by this runtime.",
            ));
        }
        if let Some(request_id) = params.get("requestId") {
            if !json_id_key(request_id)
                .is_some_and(|key| self.pending.lock().unwrap().contains_key(&key))
            {
                return Err(Problem::plain(
                    "The elicitation parent request has already ended.",
                ));
            }
        }
        Ok(elicitation::ScopeContext {
            connection_id: self.identity.clone(),
            current_session_id: session.map(str::to_owned),
            session_generation: session.and_then(|id| self.terminals.generation(id)),
            in_flight_request_ids: self
                .pending
                .lock()
                .unwrap()
                .keys()
                .filter_map(|key| serde_json::from_str(key).ok())
                .collect(),
            tool_call_ids: session
                .and_then(|id| self.tool_calls.lock().unwrap().get(id).cloned())
                .unwrap_or_default()
                .into_iter()
                .collect(),
        })
    }

    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, Problem> {
        self.request_with_timeout(method, params, timeout, || {
            Problem::with(
                "GitHub Copilot did not answer in time. Cancel the operation and try again.",
                format!("ACP {method} exceeded {} seconds.", timeout.as_secs()),
            )
        })
    }

    fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        on_timeout: impl FnOnce() -> Problem,
    ) -> Result<Value, Problem> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(self.closed_problem());
        }
        let audit_session = params
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let operation = match method {
            "session/prompt" => ProtocolOperation::Prompt,
            "session/close" | "session/delete" => ProtocolOperation::SessionClose,
            _ => ProtocolOperation::Lifecycle,
        };
        self.audit(audit_session.as_deref(), operation, AuditOutcome::Requested)?;
        let id = self.next_request_id.fetch_add(1, Ordering::SeqCst);
        let key = id.to_string();
        let (sender, receiver) = mpsc::channel();
        self.pending.lock().unwrap().insert(key.clone(), sender);
        if let Err(problem) = self.write(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        })) {
            self.pending.lock().unwrap().remove(&key);
            fail_pending(self, problem.clone());
            return Err(problem);
        }
        let result =
            wait_for_runtime_response(receiver, timeout, on_timeout, || self.closed_problem());
        if let Some(controller) = &self.elicitation {
            controller.cancel_request(&self.identity, &json!(id));
        }
        if result.is_err() {
            self.pending.lock().unwrap().remove(&key);
        }
        if let Err(problem) = self.audit(
            audit_session.as_deref(),
            operation,
            if result.is_ok() {
                AuditOutcome::Succeeded
            } else {
                AuditOutcome::Failed
            },
        ) {
            (self.report_cleanup)(&problem);
        }
        result
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), Problem> {
        self.write(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
    }

    fn write(&self, message: &Value) -> Result<(), Problem> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(self.closed_problem());
        }
        // Never block the RPC reader on a full OS pipe while the agent is writing to us.
        self.outgoing.try_send(message.clone()).map_err(|_| {
            Problem::plain(
                "The Copilot protocol writer disconnected or exceeded its bounded queue.",
            )
        })
    }

    fn respond_permission(
        &self,
        request_id: String,
        option_id: Option<String>,
    ) -> Result<(), Problem> {
        let request_id = required_text(request_id, "permission request ID")?;
        let mut permissions = self.permissions.lock().unwrap();
        let pending = permissions.get(&request_id).ok_or_else(|| {
            Problem::plain("That GitHub Copilot permission request is no longer pending.")
        })?;
        let result = permission_result(&pending.options, option_id)?;
        let outcome = match result
            .pointer("/outcome/optionId")
            .and_then(Value::as_str)
            .and_then(|id| pending.options.iter().find(|option| option.option_id == id))
        {
            Some(option) if option.kind.starts_with("allow") => AuditOutcome::Approved,
            Some(_) => AuditOutcome::Rejected,
            None => AuditOutcome::Cancelled,
        };
        self.audit(
            Some(&pending.session_id),
            ProtocolOperation::Permission,
            outcome,
        )?;
        let rpc_id = pending.rpc_id.clone();
        permissions.remove(&request_id);
        drop(permissions);
        self.write(&json!({"jsonrpc": "2.0", "id": rpc_id, "result": result}))
    }

    fn cancel_permissions(&self, session_id: &str) -> Result<(), Problem> {
        if let Some(controller) = &self.elicitation {
            controller.cancel_session(&self.identity, session_id);
        }
        self.tool_calls.lock().unwrap().remove(session_id);
        self.consent.cancel(&self.identity, Some(session_id));
        let cancelled = {
            let mut permissions = self.permissions.lock().unwrap();
            let request_ids = permissions
                .iter()
                .filter_map(|(id, pending)| {
                    (pending.session_id == session_id)
                        .then_some((id.clone(), pending.rpc_id.clone()))
                })
                .collect::<Vec<_>>();
            for (request_id, _) in &request_ids {
                permissions.remove(request_id);
            }
            request_ids
        };
        for (_, rpc_id) in cancelled {
            self.write(&json!({
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": {"outcome": {"outcome": "cancelled"}},
            }))?;
        }
        Ok(())
    }

    fn closed_problem(&self) -> Problem {
        Problem::with(
            "GitHub Copilot closed before it answered. Reconnect and try again.",
            self.stderr.lock().unwrap().clone(),
        )
    }
}

fn wait_for_runtime_response(
    receiver: Receiver<Result<Value, Problem>>,
    timeout: Duration,
    on_timeout: impl FnOnce() -> Problem,
    on_disconnect: impl FnOnce() -> Problem,
) -> Result<Value, Problem> {
    match receiver.recv_timeout(timeout) {
        Ok(response) => response,
        Err(mpsc::RecvTimeoutError::Timeout) => Err(on_timeout()),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(on_disconnect()),
    }
}

fn finish_session_open<T>(result: Result<T, Problem>, retire: impl FnOnce()) -> Result<T, Problem> {
    result.map_err(|problem| {
        retire();
        Problem {
            said: format!(
                "{} Darbot closed its owned CLI connection so opening can be retried. \
                 Saved history and the local draft were kept.",
                problem.said
            ),
            detail: problem.detail,
        }
    })
}

fn unattended_mode(id: &str) -> bool {
    id.eq_ignore_ascii_case("autopilot") || id.to_ascii_lowercase().ends_with("#autopilot")
}

fn validate_mode(modes: &Value, id: &str) -> Result<(), Problem> {
    if unattended_mode(id) {
        return Err(Problem::plain(
            "Darbot keeps tool approval enabled. Use Agent or Plan mode.",
        ));
    }
    if !modes["availableModes"]
        .as_array()
        .is_some_and(|modes| modes.iter().any(|mode| mode["id"] == id))
    {
        return Err(Problem::plain(
            "This Copilot session does not offer that mode.",
        ));
    }
    Ok(())
}

fn copilot_command() -> Result<std::process::Command, Problem> {
    let mut command = quiet::command("copilot");
    command.args(crate::copilot_extensions::agent_plugin_launch_args()?);
    Ok(command)
}

fn spawn_acp_child() -> Result<Child, Problem> {
    copilot_command()?
        .args(["--acp", "--stdio", "--no-auto-update"])
        .current_dir(user_home()?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            Problem::with(
                "GitHub Copilot CLI is not available. Install it, then try again.",
                error.to_string(),
            )
        })
}

fn take_child_stdin(child: &mut Child) -> Result<ChildStdin, Problem> {
    child.stdin.take().ok_or_else(|| {
        let _ = child.kill();
        Problem::plain("GitHub Copilot CLI did not open its protocol input.")
    })
}

fn start_runtime_writer(mut stdin: ChildStdin, messages: Receiver<Value>, core: Weak<RuntimeCore>) {
    std::thread::spawn(move || loop {
        let message = match messages.recv_timeout(Duration::from_millis(100)) {
            Ok(message) => message,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if core
                    .upgrade()
                    .is_none_or(|core| core.closed.load(Ordering::SeqCst))
                {
                    break;
                }
                continue;
            }
        };
        let Some(core) = core
            .upgrade()
            .filter(|core| !core.closed.load(Ordering::SeqCst))
        else {
            break;
        };
        let written = serde_json::to_writer(&mut stdin, &message)
            .map_err(std::io::Error::other)
            .and_then(|()| stdin.write_all(b"\n"))
            .and_then(|()| stdin.flush());
        if let Err(error) = written {
            fail_pending(
                &core,
                Problem::with(
                    "Darbot could not write to the Copilot protocol connection.",
                    error.to_string(),
                ),
            );
            break;
        }
    });
}

fn start_runtime_stderr(stderr: std::process::ChildStderr, core: Weak<RuntimeCore>) {
    std::thread::spawn(move || {
        let mut stderr = stderr;
        let mut bytes = [0; 4096];
        loop {
            let count = match stderr.read(&mut bytes) {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            let Some(core) = core.upgrade() else {
                break;
            };
            let mut diagnostic = core.stderr.lock().unwrap();
            diagnostic.push_str(&quiet::said(&bytes[..count]));
            if diagnostic.len() > DIAGNOSTIC_LIMIT {
                let mut start = diagnostic.len() - DIAGNOSTIC_LIMIT;
                while !diagnostic.is_char_boundary(start) {
                    start += 1;
                }
                diagnostic.drain(..start);
            }
        }
    });
}

fn start_runtime_stdout<R: Runtime>(
    stdout: std::process::ChildStdout,
    core: Weak<RuntimeCore>,
    app: AppHandle<R>,
) {
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Some(core) = core.upgrade() else {
                break;
            };
            match line {
                Ok(line) => match serde_json::from_str::<Value>(&line) {
                    Ok(message) => route_runtime_message(&core, &app, message),
                    Err(error) => {
                        let problem = Problem::with(
                            "GitHub Copilot returned an invalid protocol message.",
                            error.to_string(),
                        );
                        let _ = app.emit("copilot:runtime-error", &problem);
                        fail_pending(&core, problem);
                        core.closed.store(true, Ordering::SeqCst);
                        break;
                    }
                },
                Err(error) => {
                    let problem = Problem::with(
                        "Darbot could not read GitHub Copilot's response.",
                        error.to_string(),
                    );
                    let _ = app.emit("copilot:runtime-error", &problem);
                    fail_pending(&core, problem);
                    core.closed.store(true, Ordering::SeqCst);
                    break;
                }
            }
        }
        if let Some(core) = core.upgrade() {
            let already_closed = core.closed.swap(true, Ordering::SeqCst);
            let problem = core.closed_problem();
            fail_pending(&core, problem.clone());
            if !already_closed && !core.stopping.load(Ordering::SeqCst) {
                let _ = app.emit("copilot:runtime-error", problem);
            }
        }
    });
}

fn route_runtime_message<R: Runtime>(core: &Arc<RuntimeCore>, app: &AppHandle<R>, message: Value) {
    if core.closed.load(Ordering::SeqCst) {
        return;
    }
    if !message.is_object()
        || message["jsonrpc"] != "2.0"
        || message
            .get("id")
            .is_some_and(|id| json_id_key(id).is_none())
        || message
            .get("method")
            .is_some_and(|method| !method.is_string())
        || (message.get("method").is_some()
            && (message.get("result").is_some() || message.get("error").is_some()))
        || (message.get("result").is_some() && message.get("error").is_some())
    {
        write_client_error(
            core,
            message
                .get("id")
                .filter(|id| json_id_key(id).is_some())
                .cloned()
                .unwrap_or(Value::Null),
            -32600,
            "Invalid JSON-RPC envelope.",
        );
        return;
    }
    if message.get("result").is_some() || message.get("error").is_some() {
        if let Some(id) = message.get("id").and_then(json_id_key) {
            if let Some(sender) = core.pending.lock().unwrap().remove(&id) {
                let response = if let Some(error) = message.get("error") {
                    Err(Problem::with(
                        "GitHub Copilot returned a runtime error.",
                        error.to_string(),
                    ))
                } else {
                    message.get("result").cloned().ok_or_else(|| {
                        Problem::with(
                            "GitHub Copilot returned an incomplete protocol response.",
                            message.to_string(),
                        )
                    })
                };
                let _ = sender.send(response);
            }
        }
        return;
    }
    if let Some(key) = message.get("id").and_then(json_id_key) {
        let client_pending = core.client_requests.lock().unwrap().contains_key(&key);
        let permission_pending = core
            .permissions
            .lock()
            .unwrap()
            .contains_key(&format!("{}:{key}", core.identity));
        if client_pending || permission_pending {
            write_client_error(
                core,
                message["id"].clone(),
                -32600,
                "Duplicate pending client request ID.",
            );
            return;
        }
    }

    match message.get("method").and_then(Value::as_str) {
        Some("session/update") => {
            if let Some(params) = message.get("params") {
                if matches!(
                    params
                        .pointer("/update/sessionUpdate")
                        .and_then(Value::as_str),
                    Some("tool_call" | "tool_call_update")
                ) {
                    if let (Some(session), Some(tool)) = (
                        params["sessionId"].as_str(),
                        params.pointer("/update/toolCallId").and_then(Value::as_str),
                    ) {
                        if core.sessions.lock().unwrap().contains_key(session) {
                            core.tool_calls
                                .lock()
                                .unwrap()
                                .entry(session.into())
                                .or_default()
                                .insert(tool.into());
                        }
                    }
                }
                if params
                    .pointer("/update/sessionUpdate")
                    .and_then(Value::as_str)
                    == Some("config_option_update")
                {
                    if let (Some(session_id), Some(options)) = (
                        params.get("sessionId").and_then(Value::as_str),
                        params
                            .pointer("/update/configOptions")
                            .filter(|options| options.is_array()),
                    ) {
                        if let Some(session) = core.sessions.lock().unwrap().get_mut(session_id) {
                            session.config_options = options.clone();
                        }
                    }
                }
                if params
                    .pointer("/update/sessionUpdate")
                    .and_then(Value::as_str)
                    == Some("current_mode_update")
                {
                    if let (Some(session_id), Some(mode)) = (
                        params["sessionId"].as_str(),
                        params
                            .pointer("/update/currentModeId")
                            .and_then(Value::as_str),
                    ) {
                        if let Some(session) = core.sessions.lock().unwrap().get_mut(session_id) {
                            if session.modes.is_object() {
                                session.modes["currentModeId"] = json!(mode);
                            }
                        }
                    }
                }
                let _ = app.emit("copilot:session-update", params);
            }
        }
        Some("elicitation/create") => route_elicitation_request(core, &message),
        Some("elicitation/complete") => {
            if let (Some(controller), Some(id)) = (
                &core.elicitation,
                message
                    .pointer("/params/elicitationId")
                    .and_then(Value::as_str),
            ) {
                controller.complete(&core.identity, id);
            }
        }
        Some("$/cancel_request") => {
            if let (Some(controller), Some(id)) =
                (&core.elicitation, message.pointer("/params/requestId"))
            {
                if let Some(local) = json_id_key(id).and_then(|key| {
                    let mut pending = core.elicitation_rpc.lock().unwrap();
                    pending.get_mut(&key).map(|local| {
                        let id = local.clone();
                        if local.is_empty() {
                            *local = "cancelled-before-display".into();
                        }
                        id
                    })
                }) {
                    if !local.is_empty() {
                        controller.cancel_local(&local);
                    }
                }
            }
        }
        Some("session/request_permission") => {
            route_permission_request(core, app, &message);
        }
        Some("fs/read_text_file" | "fs/write_text_file") => {
            route_file_request(core, app, &message);
        }
        Some(
            "terminal/create"
            | "terminal/output"
            | "terminal/wait_for_exit"
            | "terminal/kill"
            | "terminal/release",
        ) => {
            route_terminal_request(core, app, &message);
        }
        Some(_) if message.get("id").is_some() => {
            write_client_error(
                core,
                message["id"].clone(),
                -32601,
                "Darbot does not support this ACP client method.",
            );
        }
        _ if message.get("id").is_some() => {
            write_client_error(
                core,
                message["id"].clone(),
                -32600,
                "Missing JSON-RPC method or result.",
            );
        }
        _ => {}
    }
}

fn route_elicitation_request(core: &Arc<RuntimeCore>, message: &Value) {
    let Some(id) = message
        .get("id")
        .filter(|id| json_id_key(id).is_some())
        .cloned()
    else {
        return;
    };
    let key = json_id_key(&id).unwrap();
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let Some(controller) = core.elicitation.clone() else {
        write_client_error(
            core,
            id,
            -32601,
            "No native elicitation controller is attached.",
        );
        return;
    };
    {
        let mut pending = core.client_requests.lock().unwrap();
        if pending.contains_key(&key) || pending.len() >= 64 {
            drop(pending);
            write_client_error(
                core,
                id,
                -32600,
                "Duplicate or excessive pending client requests.",
            );
            return;
        }
        pending.insert(key.clone(), true);
    }
    core.elicitation_rpc
        .lock()
        .unwrap()
        .insert(key.clone(), String::new());
    let intended_generation = params
        .get("sessionId")
        .and_then(Value::as_str)
        .and_then(|session| core.terminals.generation(session));
    let core = Arc::clone(core);
    std::thread::spawn(move || {
        let _guard = ClientRequestGuard {
            core: Arc::clone(&core),
            key: key.clone(),
        };
        let scope = match core.elicitation_scope(&params) {
            Ok(scope) => scope,
            Err(problem) => {
                core.elicitation_rpc.lock().unwrap().remove(&key);
                write_client_error(&core, id, -32602, &problem.said);
                return;
            }
        };
        if scope.session_generation != intended_generation {
            core.elicitation_rpc.lock().unwrap().remove(&key);
            write_client_error(&core, id, -32800, "Elicitation session was cancelled.");
            return;
        }
        let generation = intended_generation;
        if let Err(problem) = core.audit(
            scope.current_session_id.as_deref(),
            ProtocolOperation::Elicitation,
            AuditOutcome::Requested,
        ) {
            core.elicitation_rpc.lock().unwrap().remove(&key);
            write_client_error(&core, id, -32603, &problem.said);
            return;
        }
        let ticket = match controller.begin(params.clone(), &scope) {
            Ok(ticket) => ticket,
            Err(error) => {
                core.elicitation_rpc.lock().unwrap().remove(&key);
                write_client_error(&core, id, error.code, &error.message);
                return;
            }
        };
        let local_id = ticket.request.request_id.clone();
        let cancelled = {
            let mut pending = core.elicitation_rpc.lock().unwrap();
            let cancelled = pending.get(&key).is_none_or(|value| !value.is_empty());
            pending.insert(key.clone(), local_id.clone());
            cancelled
        };
        if cancelled
            || core.elicitation_scope(&params).is_err()
            || scope
                .current_session_id
                .as_deref()
                .is_some_and(|session| core.terminals.generation(session) != generation)
        {
            controller.cancel_local(&local_id);
        }
        let response = match ticket.response.recv_timeout(Duration::from_secs(300)) {
            Ok(response) => response,
            Err(_) => {
                controller.cancel_local(&local_id);
                Err(elicitation::Error {
                    code: -32800,
                    message: "Elicitation expired or disconnected".into(),
                })
            }
        };
        core.elicitation_rpc.lock().unwrap().remove(&key);
        let outcome = if response.is_ok() {
            AuditOutcome::Succeeded
        } else {
            AuditOutcome::Cancelled
        };
        if let Err(problem) = core.audit(
            scope.current_session_id.as_deref(),
            ProtocolOperation::Elicitation,
            outcome,
        ) {
            (core.report_cleanup)(&problem);
        }
        match response {
            Ok(value) => write_client_result(
                &core,
                id,
                serde_json::to_value(value).map_err(|error| Problem::plain(error.to_string())),
            ),
            Err(error) => write_client_error(&core, id, error.code, &error.message),
        }
    });
}

fn route_permission_request<R: Runtime>(
    core: &Arc<RuntimeCore>,
    app: &AppHandle<R>,
    message: &Value,
) {
    let Some(rpc_key) = message.get("id").and_then(json_id_key) else {
        return;
    };
    let request_id = format!("{}:{rpc_key}", core.identity);
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Permission {
        session_id: String,
        tool_call: Value,
        options: Vec<PermissionOption>,
        #[serde(rename = "_meta")]
        _meta: Option<Value>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct PermissionOption {
        option_id: String,
        name: String,
        kind: String,
        #[serde(rename = "_meta")]
        _meta: Option<Value>,
    }
    let id = message["id"].clone();
    let Ok(params) =
        serde_json::from_value::<Permission>(message.get("params").cloned().unwrap_or(Value::Null))
    else {
        write_client_error(core, id, -32602, "Invalid ACP permission parameters.");
        return;
    };
    let mut ids = HashSet::new();
    if message["params"].to_string().len() > 32 * 1024
        || params.options.is_empty()
        || params.options.len() > 32
        || params._meta.as_ref().is_some_and(|meta| !meta.is_object())
        || !params.tool_call.is_object()
        || params
            .tool_call
            .get("toolCallId")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        || params.options.iter().any(|option| {
            option.option_id.is_empty()
                || option.name.is_empty()
                || option._meta.as_ref().is_some_and(|meta| !meta.is_object())
                || !ids.insert(&option.option_id)
                || !matches!(
                    option.kind.as_str(),
                    "allow_once" | "allow_always" | "reject_once" | "reject_always"
                )
        })
    {
        write_client_error(
            core,
            id,
            -32602,
            "Invalid or oversized ACP permission request.",
        );
        return;
    }
    let options: Vec<_> = params
        .options
        .into_iter()
        .map(|option| CopilotPermissionOption {
            option_id: option.option_id,
            name: option.name,
            kind: option.kind,
        })
        .collect();
    {
        let sessions = core.sessions.lock().unwrap();
        if !sessions.contains_key(&params.session_id) {
            drop(sessions);
            write_client_error(
                core,
                id,
                -32602,
                "Permission requires this runtime's active session.",
            );
            return;
        }
        let mut pending = core.permissions.lock().unwrap();
        if pending.contains_key(&request_id) || pending.len() >= 32 {
            drop(pending);
            drop(sessions);
            write_client_error(
                core,
                id,
                -32600,
                "Duplicate or excessive pending permission request.",
            );
            return;
        }
        pending.insert(
            request_id.clone(),
            PendingPermission {
                rpc_id: id.clone(),
                session_id: params.session_id.clone(),
                options: options.clone(),
                expires: Instant::now() + Duration::from_secs(300),
            },
        );
    }
    if app
        .emit(
            "copilot:permission-request",
            CopilotPermissionRequest {
                request_id: request_id.clone(),
                session_id: params.session_id,
                origin: CopilotPermissionOrigin::Conversation,
                tool_call: params.tool_call,
                options,
            },
        )
        .is_err()
        && core
            .permissions
            .lock()
            .unwrap()
            .remove(&request_id)
            .is_some()
    {
        write_client_error(
            core,
            id,
            -32603,
            "Darbot could not show the permission request.",
        );
    }
}

fn start_permission_expiry<R: Runtime>(core: Weak<RuntimeCore>, app: AppHandle<R>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let Some(core) = core
            .upgrade()
            .filter(|core| !core.closed.load(Ordering::SeqCst))
        else {
            break;
        };
        let expired: Vec<_> = {
            let mut permissions = core.permissions.lock().unwrap();
            let ids: Vec<_> = permissions
                .iter()
                .filter(|(_, pending)| Instant::now() >= pending.expires)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| permissions.remove(&id).map(|p| (id, p)))
                .collect()
        };
        for (request_id, pending) in expired {
            if let Err(problem) = core.write(&json!({
                "jsonrpc": "2.0", "id": pending.rpc_id,
                "result": {"outcome": {"outcome": "cancelled"}}
            })) {
                fail_pending(&core, problem);
                break;
            }
            if app
                .emit(
                    "copilot:permission-closed",
                    json!({"requestId": request_id, "sessionId": pending.session_id}),
                )
                .is_err()
            {
                eprintln!("Darbot could not close an expired permission notification.");
            }
        }
    });
}

fn write_client_error(core: &RuntimeCore, id: Value, code: i64, message: &str) {
    if core.closed.load(Ordering::SeqCst) {
        return;
    }
    if let Err(problem) = core.write(&json!({
        "jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message},
    })) {
        fail_pending(core, problem);
    }
}

struct ClientRequestGuard {
    core: Arc<RuntimeCore>,
    key: String,
}

impl Drop for ClientRequestGuard {
    fn drop(&mut self) {
        self.core.client_requests.lock().unwrap().remove(&self.key);
    }
}

fn route_terminal_request<R: Runtime>(
    core: &Arc<RuntimeCore>,
    app: &AppHandle<R>,
    message: &Value,
) {
    let Some((id, key)) = message
        .get("id")
        .and_then(|id| json_id_key(id).map(|key| (id.clone(), key)))
    else {
        return;
    };
    let method = message["method"].as_str().unwrap().to_string();
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let audit_session = params["sessionId"].as_str().map(str::to_owned);
    let audit_operation = match method.as_str() {
        "terminal/create" => ProtocolOperation::TerminalCreate,
        "terminal/output" => ProtocolOperation::TerminalOutput,
        "terminal/wait_for_exit" => ProtocolOperation::TerminalWait,
        "terminal/kill" => ProtocolOperation::TerminalKill,
        "terminal/release" => ProtocolOperation::TerminalRelease,
        _ => return,
    };
    if let Err(problem) = core.audit(
        audit_session.as_deref(),
        audit_operation,
        AuditOutcome::Requested,
    ) {
        write_client_error(core, id, -32603, &problem.said);
        return;
    }
    enum Request {
        Create(terminals::Create, terminals::Reservation, String),
        Handle(terminals::Handle),
    }
    let parsed = (|| {
        if params.to_string().len() > 24 * 1024 {
            return Err(Problem::plain("Terminal requests are limited to 24 KiB."));
        }
        if method == "terminal/create" {
            let request: terminals::Create = serde_json::from_value(params)
                .map_err(|_| Problem::plain("Invalid ACP terminal/create parameters."))?;
            request.validate()?;
            let cwd = core
                .sessions
                .lock()
                .unwrap()
                .get(&request.session_id)
                .map(|session| session.cwd.clone())
                .ok_or_else(|| {
                    Problem::plain("Terminal creation requires this runtime's active session.")
                })?;
            let reservation = core.terminals.reserve(&request.session_id)?;
            Ok(Request::Create(request, reservation, cwd))
        } else {
            let handle = serde_json::from_value::<terminals::Handle>(params)
                .map_err(|_| Problem::plain("Invalid ACP terminal handle parameters."))?;
            handle.validate()?;
            Ok(Request::Handle(handle))
        }
    })();
    let request = match parsed {
        Ok(request) => request,
        Err(problem) => {
            write_client_error(core, id, -32602, &problem.said);
            return;
        }
    };
    if let Request::Handle(handle) = &request {
        if method == "terminal/output" {
            let result = core.terminals.output(handle);
            if let Err(problem) = core.audit(
                audit_session.as_deref(),
                audit_operation,
                if result.is_ok() {
                    AuditOutcome::Succeeded
                } else {
                    AuditOutcome::Failed
                },
            ) {
                write_client_error(core, id, -32603, &problem.said);
                return;
            }
            write_client_result(core, id, result);
            return;
        }
    }
    {
        let mut pending = core.client_requests.lock().unwrap();
        let slow = matches!(
            method.as_str(),
            "terminal/create" | "terminal/wait_for_exit"
        );
        if pending.contains_key(&key)
            || pending.values().filter(|value| **value == slow).count() >= 32
        {
            drop(pending);
            write_client_error(
                core,
                id,
                -32600,
                "Duplicate or excessive pending terminal requests.",
            );
            return;
        }
        pending.insert(key.clone(), slow);
    }
    let guard = ClientRequestGuard {
        core: Arc::clone(core),
        key,
    };
    let core = Arc::clone(core);
    let app = app.clone();
    std::thread::spawn(move || {
        let _guard = guard;
        let result = (|| match request {
            Request::Create(request, reservation, cwd) => {
                let home = &core.client_home;
                let directory = request.directory(&cwd, home)?;
                if core.consent.ask_if(
                    &app,
                    &core.identity,
                    &request.session_id,
                    CopilotPermissionOrigin::Conversation,
                    request.details(&directory),
                    || reservation.is_current() && !core.closed.load(Ordering::SeqCst),
                )? != ConsentDecision::Allow
                {
                    core.audit(
                        Some(&request.session_id),
                        audit_operation,
                        AuditOutcome::Rejected,
                    )?;
                    return Err(Problem::plain("The native command was not approved."));
                }
                core.audit(
                    Some(&request.session_id),
                    audit_operation,
                    AuditOutcome::Approved,
                )?;
                if core.closed.load(Ordering::SeqCst) || request.directory(&cwd, home)? != directory
                {
                    return Err(Problem::plain(
                        "The command session or directory changed during approval.",
                    ));
                }
                let publish: terminals::Publish = Arc::new(move |session, id, snapshot| {
                    let mut event = serde_json::to_value(snapshot).unwrap();
                    event["sessionId"] = json!(session);
                    event["terminalId"] = json!(id);
                    app.emit("copilot:terminal-output", event)
                        .map_err(|_| "Darbot could not publish terminal output.".to_string())
                });
                core.terminals
                    .create(reservation, &request, &directory, publish)
                    .map(|id| json!({"terminalId": id}))
            }
            Request::Handle(handle) => match method.as_str() {
                "terminal/output" => core.terminals.output(&handle),
                "terminal/wait_for_exit" => core.terminals.wait(&handle),
                "terminal/kill" => core.terminals.kill(&handle).map(|()| json!({})),
                "terminal/release" => core.terminals.release(&handle).map(|()| json!({})),
                _ => unreachable!(),
            },
        })();
        if let Err(problem) = core.audit(
            audit_session.as_deref(),
            audit_operation,
            if result.is_ok() {
                AuditOutcome::Succeeded
            } else {
                AuditOutcome::Failed
            },
        ) {
            (core.report_cleanup)(&problem);
        }
        match result {
            Ok(value) => write_client_result(&core, id, Ok(value)),
            Err(problem) => write_client_error(
                &core,
                id,
                -32000,
                &format!(
                    "{} {}",
                    problem.said,
                    problem.detail.as_deref().unwrap_or("")
                ),
            ),
        }
    });
}

fn fail_pending(core: &RuntimeCore, mut problem: Problem) {
    core.closed.store(true, Ordering::SeqCst);
    if let Some(controller) = &core.elicitation {
        controller.cancel_all();
    }
    core.consent.cancel(&core.identity, None);
    if let Err(cleanup) = core.terminals.cancel(None, true) {
        (core.report_cleanup)(&cleanup);
        problem
            .said
            .push_str(" An owned terminal could not be completely cleaned up.");
        problem.detail = cleanup.detail;
    }
    let pending = std::mem::take(&mut *core.pending.lock().unwrap());
    for (_, sender) in pending {
        let _ = sender.send(Err(problem.clone()));
    }
}

enum ClientFileRequest {
    Read(ReadTextFile),
    Write(WriteTextFile),
}

impl ClientFileRequest {
    fn session_id(&self) -> &str {
        match self {
            Self::Read(request) => &request.session_id,
            Self::Write(request) => &request.session_id,
        }
    }

    fn path(&self) -> &str {
        match self {
            Self::Read(request) => &request.path,
            Self::Write(request) => &request.path,
        }
    }
}

fn route_file_request<R: Runtime>(core: &Arc<RuntimeCore>, app: &AppHandle<R>, message: &Value) {
    let Some(id) = message
        .get("id")
        .filter(|id| json_id_key(id).is_some())
        .cloned()
    else {
        return;
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let parsed = if message["method"] == "fs/read_text_file" {
        serde_json::from_value(params).map(ClientFileRequest::Read)
    } else {
        serde_json::from_value(params).map(ClientFileRequest::Write)
    };
    let request = match parsed {
        Ok(request) => request,
        Err(error) => {
            write_client_result(
                core,
                id,
                Err(Problem::with(
                    "Invalid ACP text-file request.",
                    error.to_string(),
                )),
            );
            return;
        }
    };
    let cwd = core
        .sessions
        .lock()
        .unwrap()
        .get(request.session_id())
        .map(|session| session.cwd.clone());
    let Some(cwd) = cwd else {
        write_client_result(
            core,
            id,
            Err(Problem::plain(
                "File access requires an active session owned by this Darbot connection.",
            )),
        );
        return;
    };
    let Some(generation) = core.terminals.generation(request.session_id()) else {
        write_client_error(core, id, -32602, "The file request's session has closed.");
        return;
    };
    let key = json_id_key(&id).unwrap();
    {
        let mut pending = core.client_requests.lock().unwrap();
        if pending.contains_key(&key) || pending.values().filter(|slow| **slow).count() >= 32 {
            drop(pending);
            write_client_error(core, id, -32600, "Duplicate or excessive client requests.");
            return;
        }
        pending.insert(key.clone(), true);
    }
    let guard = ClientRequestGuard {
        core: Arc::clone(core),
        key,
    };
    let audit_session = request.session_id().to_owned();
    let audit_operation = if matches!(request, ClientFileRequest::Write(_)) {
        ProtocolOperation::FileWrite
    } else {
        ProtocolOperation::FileRead
    };
    if let Err(problem) = core.audit(
        Some(&audit_session),
        audit_operation,
        AuditOutcome::Requested,
    ) {
        write_client_error(core, id, -32603, &problem.said);
        return;
    }
    let core = Arc::clone(core);
    let app = app.clone();
    std::thread::spawn(move || {
        let _guard = guard;
        let result = (|| {
            let writing = matches!(request, ClientFileRequest::Write(_));
            if let ClientFileRequest::Write(request) = &request {
                if request.content.len() > copilot_files::MAX_FILE_BYTES {
                    return Err(Problem::plain(
                        "Client text-file writes are limited to 1 MiB.",
                    ));
                }
            }
            let home = &core.client_home;
            let path = copilot_files::resolve(&cwd, request.path(), writing, home)?;
            let mut details = json!({
                "title": if writing { "Replace a project text file" } else { "Read a project text file" },
                "path": display_path(&path),
                "workingDirectory": cwd,
            });
            match &request {
                ClientFileRequest::Read(request) => {
                    if request.line == Some(0) || request.limit == Some(0) {
                        return Err(Problem::plain(
                            "File line and limit must be positive integers.",
                        ));
                    }
                    details["line"] = json!(request.line);
                    details["limit"] = json!(request.limit);
                }
                ClientFileRequest::Write(request) => {
                    details["bytes"] = json!(request.content.len());
                }
            }
            if core.consent.ask_if(
                &app,
                &core.identity,
                request.session_id(),
                CopilotPermissionOrigin::Conversation,
                details,
                || {
                    core.terminals.generation(request.session_id()) == Some(generation)
                        && !core.closed.load(Ordering::SeqCst)
                },
            )? != ConsentDecision::Allow
            {
                core.audit(
                    Some(&audit_session),
                    audit_operation,
                    AuditOutcome::Rejected,
                )?;
                return Err(Problem::plain("The project file request was not approved."));
            }
            core.audit(
                Some(&audit_session),
                audit_operation,
                AuditOutcome::Approved,
            )?;
            if core.closed.load(Ordering::SeqCst)
                || core.terminals.generation(request.session_id()) != Some(generation)
            {
                return Err(Problem::plain("The file request's session has closed."));
            }
            let current = copilot_files::resolve(&cwd, request.path(), writing, home)?;
            if current != path {
                return Err(Problem::plain(
                    "The requested file changed location during approval.",
                ));
            }
            match request {
                ClientFileRequest::Read(request) => {
                    Ok(json!({"content": copilot_files::read(&path, request.line, request.limit)?}))
                }
                ClientFileRequest::Write(request) => {
                    copilot_files::write(&path, &request.content)?;
                    Ok(json!({}))
                }
            }
        })();
        if let Err(problem) = core.audit(
            Some(&audit_session),
            audit_operation,
            if result.is_ok() {
                AuditOutcome::Succeeded
            } else {
                AuditOutcome::Failed
            },
        ) {
            (core.report_cleanup)(&problem);
        }
        write_client_result(&core, id, result);
    });
}

fn write_client_result(core: &RuntimeCore, id: Value, result: Result<Value, Problem>) {
    if core.closed.load(Ordering::SeqCst) {
        return;
    }
    let message = match result {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err(problem) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": -32602, "message": problem.said, "data": problem.detail},
        }),
    };
    if let Err(problem) = core.write(&message) {
        fail_pending(core, problem);
    }
}

fn initialize_params(client_operations: bool) -> Value {
    let mut params = json!({
        "protocolVersion": 1,
        "clientCapabilities": {},
        "clientInfo": {
            "name": "darbot",
            "title": "Darbot",
            "version": env!("CARGO_PKG_VERSION"),
        },
    });
    if client_operations {
        params["clientCapabilities"]["elicitation"] = json!({"form":{}, "url":{}});
        params["clientCapabilities"]["session"] = json!({"notices":{}, "compaction":{}});
        params["clientCapabilities"]["terminal"] = json!(true);
        params["clientCapabilities"]["fs"] = json!({
            "readTextFile": true,
            "writeTextFile": true,
        });
    }
    params
}

pub fn workspace(cwd: Option<String>) -> Result<CopilotWorkspace, Problem> {
    let requested = match nonempty(cwd) {
        Some(cwd) => cwd,
        None => display_path(&user_home()?),
    };
    Ok(CopilotWorkspace {
        cwd: session_root(&requested)?,
        home: display_path(&copilot_home()?),
    })
}

fn session_root(cwd: &str) -> Result<String, Problem> {
    let cwd = required_text(cwd.to_string(), "working directory")?;
    let path = Path::new(&cwd);
    require_absolute(path, "working directory")?;
    let canonical = path.canonicalize().map_err(|error| {
        Problem::with(
            "That Copilot working folder is unavailable. Choose an existing folder in Settings.",
            format!("{cwd}: {error}"),
        )
    })?;
    if !canonical.is_dir() {
        return Err(Problem::plain(
            "The GitHub Copilot working directory must be a folder.",
        ));
    }
    Ok(display_path(&canonical))
}

fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        if let Some(drive) = text.strip_prefix(r"\\?\") {
            return drive.to_string();
        }
    }
    text.into_owned()
}

fn config_has_value(options: &Value, value: &str) -> bool {
    options.as_array().is_some_and(|options| {
        options.iter().any(|option| {
            option.get("value").and_then(Value::as_str) == Some(value)
                || config_has_value(&option["options"], value)
        })
    })
}

fn require_absolute(path: &Path, label: &str) -> Result<(), Problem> {
    if path.is_absolute() {
        Ok(())
    } else {
        Err(Problem::plain(format!(
            "The GitHub Copilot {label} must be an absolute path."
        )))
    }
}

fn required_text(value: String, label: &str) -> Result<String, Problem> {
    let value = value.trim();
    if value.is_empty() {
        Err(Problem::plain(format!(
            "GitHub Copilot needs a {label} before continuing."
        )))
    } else {
        Ok(value.to_string())
    }
}

fn parse_session(value: Value, cwd: String) -> Result<CopilotSession, Problem> {
    let session_id = value
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            Problem::with(
                "GitHub Copilot returned an invalid new session.",
                value.to_string(),
            )
        })?
        .to_string();
    parse_session_setup(session_id, cwd, value)
}

fn parse_session_setup(
    session_id: String,
    cwd: String,
    value: Value,
) -> Result<CopilotSession, Problem> {
    Ok(CopilotSession {
        session_id: required_text(session_id, "session ID")?,
        cwd,
        modes: value.get("modes").cloned(),
        config_options: value.get("configOptions").cloned(),
    })
}

fn permission_result(
    options: &[CopilotPermissionOption],
    option_id: Option<String>,
) -> Result<Value, Problem> {
    match nonempty(option_id) {
        Some(option_id) if options.iter().any(|option| option.option_id == option_id) => {
            Ok(json!({"outcome": {"outcome": "selected", "optionId": option_id}}))
        }
        Some(_) => Err(Problem::plain(
            "That GitHub Copilot permission option is no longer available.",
        )),
        None => Ok(json!({"outcome": {"outcome": "cancelled"}})),
    }
}

fn json_id_key(value: &Value) -> Option<String> {
    (value.is_string() || value.is_i64() || value.is_u64()).then(|| value.to_string())
}

struct AcpConnection {
    child: Child,
    stdin: ChildStdin,
    stdout: Receiver<Result<String, String>>,
    stderr: Receiver<String>,
}

impl AcpConnection {
    fn start() -> Result<Self, Problem> {
        let mut child = spawn_acp_child()?;

        let stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                let _ = child.kill();
                return Err(Problem::plain(
                    "GitHub Copilot CLI did not open its protocol input.",
                ));
            }
        };
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                let _ = child.kill();
                return Err(Problem::plain(
                    "GitHub Copilot CLI did not open its protocol output.",
                ));
            }
        };
        let stderr = match child.stderr.take() {
            Some(stderr) => stderr,
            None => {
                let _ = child.kill();
                return Err(Problem::plain(
                    "GitHub Copilot CLI did not open its diagnostic output.",
                ));
            }
        };

        let (stdout_sender, stdout_receiver) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let line = line.map_err(|error| error.to_string());
                if stdout_sender.send(line).is_err() {
                    break;
                }
            }
        });

        let (stderr_sender, stderr_receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut stderr = stderr;
            let mut bytes = Vec::new();
            let text = match stderr.read_to_end(&mut bytes) {
                Ok(_) => quiet::said(&bytes),
                Err(error) => error.to_string(),
            };
            let _ = stderr_sender.send(text);
        });

        Ok(Self {
            child,
            stdin,
            stdout: stdout_receiver,
            stderr: stderr_receiver,
        })
    }

    fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value, Problem> {
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        serde_json::to_writer(&mut self.stdin, &request).map_err(|error| {
            Problem::with(
                "Darbot could not send a request to GitHub Copilot.",
                error.to_string(),
            )
        })?;
        self.stdin.write_all(b"\n").map_err(|error| {
            Problem::with(
                "Darbot could not finish sending a request to GitHub Copilot.",
                error.to_string(),
            )
        })?;
        self.stdin.flush().map_err(|error| {
            Problem::with(
                "Darbot could not flush a request to GitHub Copilot.",
                error.to_string(),
            )
        })?;

        let deadline = Instant::now() + ACP_TIMEOUT;
        loop {
            let line = self
                .stdout
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(|error| match error {
                    mpsc::RecvTimeoutError::Timeout => Problem::plain(
                        "GitHub Copilot did not answer in time. Close and reopen Darbot to retry.",
                    ),
                    mpsc::RecvTimeoutError::Disconnected => Problem::plain(
                        "GitHub Copilot closed before it answered. Close and reopen Darbot to retry.",
                    ),
                })?
                .map_err(|detail| {
                    Problem::with("Darbot could not read GitHub Copilot's response.", detail)
                })?;
            let message: Value = serde_json::from_str(&line).map_err(|error| {
                Problem::with(
                    "GitHub Copilot returned an invalid protocol message.",
                    format!("{error}: {line}"),
                )
            })?;
            if message.get("method").is_some() {
                if let Some(callback_id) = message.get("id") {
                    let reply = json!({
                        "jsonrpc": "2.0", "id": callback_id,
                        "error": {"code": -32601, "message":
                            "Client callbacks are unavailable on this read-only status connection."}
                    });
                    serde_json::to_writer(&mut self.stdin, &reply)
                        .map_err(std::io::Error::other)
                        .and_then(|()| self.stdin.write_all(b"\n"))
                        .and_then(|()| self.stdin.flush())
                        .map_err(|error| {
                            Problem::with(
                                "Darbot could not reject a callback on its status connection.",
                                error.to_string(),
                            )
                        })?;
                }
                continue;
            }
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(Problem::with(
                    "GitHub Copilot returned a runtime error.",
                    error.to_string(),
                ));
            }
            return message.get("result").cloned().ok_or_else(|| {
                Problem::with(
                    "GitHub Copilot returned an incomplete protocol response.",
                    line,
                )
            });
        }
    }

    fn finish(mut self) -> String {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.stderr.recv_timeout(STDERR_TIMEOUT).unwrap_or_default()
    }
}

impl Drop for AcpConnection {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn status() -> Result<CopilotStatus, Problem> {
    let mut connection = AcpConnection::start()?;
    let mut status = diagnostics::reading(None, Operation::AcpInitialize, || {
        parse_status(&connection.request(0, "initialize", initialize_params(false))?)
    })?;

    if status.capabilities.list_sessions {
        let result = diagnostics::reading(None, Operation::AcpListSessions, || {
            let result = connection.request(1, "session/list", json!({}))?;
            let count = result
                .get("sessions")
                .and_then(Value::as_array)
                .ok_or_else(|| Problem::plain("GitHub Copilot returned an invalid session list."))?
                .len();
            let more = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .is_some_and(|cursor| !cursor.is_empty());
            Ok((count, more))
        });
        match result {
            Ok((count, more)) => {
                status.authentication = CopilotAuthentication::Ready;
                status.session_count = count;
                status.has_more_sessions = more;
            }
            Err(problem) if authentication_required(&problem) => {
                status.authentication = CopilotAuthentication::Required;
            }
            Err(problem) => return Err(problem),
        }
    }

    let warning = connection.finish();
    if !warning.is_empty() {
        status.warnings.push(warning);
    }
    status.observations = diagnostics::snapshot(None);
    Ok(status)
}

pub fn inventory(cwd: Option<String>) -> Result<CopilotInventory, Problem> {
    let cwd = workspace(cwd)?.cwd;
    let mut warnings = Vec::new();
    let mut agents = match discover_agents() {
        Ok((agents, agent_warnings)) => {
            warnings.extend(agent_warnings);
            agents
        }
        Err(problem) => {
            warnings.push(problem.said);
            Vec::new()
        }
    };
    let cloud = studio_catalog::catalog(false)?;
    agents.extend(cloud.agents);
    warnings.extend(cloud.warnings);
    let (plugins, skills, mcp) = std::thread::scope(|scope| {
        let plugins = scope.spawn(|| {
            read_inventory(
                "plugin",
                "plugins",
                &cwd,
                Operation::ListPlugins,
                parse_plugins,
            )
        });
        let skills = scope
            .spawn(|| read_inventory("skill", "skills", &cwd, Operation::ListSkills, parse_skills));
        let mcp = scope.spawn(|| {
            read_inventory(
                "mcp",
                "MCP servers",
                &cwd,
                Operation::ListMcp,
                parse_mcp_servers,
            )
        });
        let failed = || Problem::plain("A Copilot resource reader stopped unexpectedly.");
        (
            plugins.join().unwrap_or_else(|_| Err(failed())),
            skills.join().unwrap_or_else(|_| Err(failed())),
            mcp.join().unwrap_or_else(|_| Err(failed())),
        )
    });

    let mut observations = diagnostics::snapshot(Some(&cwd));
    observations.extend(diagnostics::snapshot(None));
    Ok(CopilotInventory {
        agents,
        sources: cloud.sources,
        plugins: resource_result(plugins, &mut warnings),
        skills: resource_result(skills, &mut warnings),
        mcp_servers: resource_result(mcp, &mut warnings),
        warnings,
        observations,
    })
}

pub fn agents() -> Result<CopilotAgentCatalog, Problem> {
    let (mut agents, mut warnings) = discover_agents()?;
    let cloud = studio_catalog::catalog(true)?;
    agents.extend(cloud.agents);
    warnings.extend(cloud.warnings);
    Ok(CopilotAgentCatalog {
        agents,
        sources: cloud.sources,
        warnings,
    })
}

pub fn create_agent(
    name: String,
    description: String,
    instructions: String,
) -> Result<CopilotAgent, Problem> {
    let name = name.trim();
    let description = description.trim();
    let instructions = instructions.trim();
    if name.is_empty()
        || name.len() > 64
        || !name.as_bytes()[0].is_ascii_alphanumeric()
        || !name
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_')
    {
        return Err(Problem::plain(
            "Use an agent name of 1-64 lowercase letters, numbers, hyphens or underscores, starting with a letter or number.",
        ));
    }
    let reserved = matches!(name, "con" | "prn" | "aux" | "nul")
        || (name.len() == 4
            && (name.starts_with("com") || name.starts_with("lpt"))
            && name.as_bytes()[3].is_ascii_digit());
    if reserved {
        return Err(Problem::plain(
            "Choose a name that is not a reserved Windows file name.",
        ));
    }
    if description.is_empty()
        || description.chars().count() > 1000
        || description.contains(['\n', '\r', '\0'])
    {
        return Err(Problem::plain(
            "Give the agent a single-line description of 1-1,000 characters.",
        ));
    }
    if instructions.is_empty()
        || instructions.chars().count() > 30_000
        || instructions.contains('\0')
    {
        return Err(Problem::plain(
            "Give the agent instructions of 1-30,000 characters.",
        ));
    }
    let (existing, _) = discover_agents()?;
    if existing
        .iter()
        .any(|agent| agent.id.eq_ignore_ascii_case(name))
    {
        return Err(Problem::plain(
            "An agent with that name already exists. Choose a different name.",
        ));
    }
    let directory = copilot_home()?.join("agents");
    fs::create_dir_all(&directory).map_err(|error| {
        Problem::with(
            "Darbot could not open your personal agents folder.",
            error.to_string(),
        )
    })?;
    let path = directory.join(format!("{name}.agent.md"));
    if directory.join(format!("{name}.md")).exists() {
        return Err(Problem::plain(
            "An agent file with that name already exists. Choose a different name.",
        ));
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|error| {
        Problem::with(
            "Darbot could not create the agent. Existing agent files are never replaced.",
            error.to_string(),
        )
    })?;
    let content = format!(
        "---\nname: '{name}'\ndescription: '{}'\n---\n\n{instructions}\n",
        description.replace('\'', "''"),
    );
    let written = file
        .write_all(content.as_bytes())
        .and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = written {
        let detail = match fs::remove_file(&path) {
            Ok(()) => error.to_string(),
            Err(cleanup) => {
                format!("{error}. The incomplete agent file could not be removed: {cleanup}")
            }
        };
        return Err(Problem::with(
            "Darbot could not save the new agent.",
            detail,
        ));
    }
    Ok(CopilotAgent {
        id: name.into(),
        name: name.into(),
        description: description.into(),
        model: None,
        definition: Some(LocalDefinition {
            file: path.to_string_lossy().into_owned(),
            modified_at_unix: modified_at_unix(&path),
            declared_id: None,
            tools: Vec::new(),
            omitted_entries: 0,
        }),
        source: None,
    })
}

fn resource_result<T>(
    result: Result<(Vec<T>, Option<String>), Problem>,
    warnings: &mut Vec<String>,
) -> Vec<T> {
    match result {
        Ok((resources, warning)) => {
            warnings.extend(warning);
            resources
        }
        Err(problem) => {
            warnings.push(problem.said);
            Vec::new()
        }
    }
}

fn discover_agents() -> Result<(Vec<CopilotAgent>, Vec<String>), Problem> {
    let agents_dir = copilot_home()?.join("agents");
    if !agents_dir.is_dir() {
        return Ok((Vec::new(), Vec::new()));
    }

    let entries = fs::read_dir(&agents_dir).map_err(|error| {
        Problem::with(
            "Darbot could not read personal GitHub Copilot agents.",
            error.to_string(),
        )
    })?;
    let mut agents = Vec::new();
    let mut warnings = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                warnings.push(format!(
                    "An agent directory entry could not be read: {error}"
                ));
                continue;
            }
        };
        let path = entry.path();
        if !entry.file_type().is_ok_and(|kind| kind.is_file())
            || path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_none_or(|extension| !extension.eq_ignore_ascii_case("md"))
        {
            continue;
        }
        let text = match fs::File::open(&path).and_then(|file| {
            // Stop at the closing delimiter; the instruction body is not card metadata.
            let mut reader = BufReader::new(file.take(64 * 1024 + 1));
            let mut header = String::new();
            loop {
                let offset = header.len();
                if reader.read_line(&mut header)? == 0 {
                    break;
                }
                let delimiter = header[offset..].trim_start_matches('\u{feff}').trim_end() == "---";
                if (offset == 0 && !delimiter) || (offset > 0 && delimiter) {
                    break;
                }
            }
            Ok(header)
        }) {
            Ok(header) => header,
            Err(error) => {
                warnings.push(format!(
                    "{} could not be read: {error}",
                    entry.file_name().to_string_lossy()
                ));
                continue;
            }
        };
        if let Some(mut agent) = parse_agent_definition(&text, &path.to_string_lossy()) {
            if let Some(definition) = &mut agent.definition {
                definition.modified_at_unix = modified_at_unix(&path);
            }
            agents.push(agent);
        } else {
            warnings.push(format!(
                "{} has no valid agent name/description. Copilot will validate it when loading a session.",
                entry.file_name().to_string_lossy()
            ));
        }
    }
    agents.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
    });
    Ok((agents, warnings))
}

fn copilot_home() -> Result<PathBuf, Problem> {
    if let Some(home) = std::env::var_os("COPILOT_HOME").filter(|home| !home.is_empty()) {
        let home = PathBuf::from(home);
        require_absolute(&home, "configuration directory")?;
        return Ok(home);
    }
    Ok(user_home()?.join(".copilot"))
}

fn user_home() -> Result<PathBuf, Problem> {
    let home = if cfg!(windows) {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
    } else {
        std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
    };
    home.filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| {
            Problem::plain(
                "Darbot could not locate your home folder. Choose a Copilot working folder.",
            )
        })
}

fn modified_at_unix(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|t| t.as_secs())
}

// Admit bounded display prose, not markup, connection strings or credential-like tokens.
fn public_description(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= 1000
        && value
            .chars()
            .all(|c| c.is_alphanumeric() || " .,;:!?()'’\"-/–—&".contains(c))
        && !sensitive_metadata(value)
}

fn sensitive_metadata(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    [
        "bearer ",
        "basic ",
        "token",
        "secret",
        "password",
        "passwd",
        "credential",
        "api key",
        "api-key",
        "apikey",
        "api_key",
        "private key",
        "://",
        "ghp_",
        "github_pat_",
        "xox",
        "akia",
        "eyj",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
        || lower
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '-')
            .any(|word| word.starts_with("sk-") || (word.starts_with("asia") && word.len() == 20))
        || value
            .split(|c: char| !c.is_ascii_alphanumeric())
            .any(|part| part.len() >= 32)
}

fn parse_agent_definition(text: &str, file: &str) -> Option<CopilotAgent> {
    use serde_yaml_ng::Value as Yaml;
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    let mut header = String::new();
    loop {
        let line = lines.next()?;
        if line.trim_end() == "---" {
            break;
        }
        header.push_str(line);
        header.push('\n');
        if header.len() > 64 * 1024 {
            return None;
        }
    }
    let fields: Yaml = serde_yaml_ng::from_str(&header).ok()?;
    let scalar = |key: &str| nonempty(fields.get(key)?.as_str().map(str::to_owned));
    let name = scalar("name")?;
    let declared_id = scalar("id").filter(|id| public_symbol(id));
    let mut definition = LocalDefinition {
        file: file.into(),
        modified_at_unix: None,
        declared_id: declared_id.clone(),
        tools: Vec::new(),
        omitted_entries: 0,
    };
    let mut collect = |field: &str, values: Option<&Yaml>, server: Option<&str>| {
        let Some(values) = values else { return };
        let Some(items) = values.as_sequence() else {
            definition.omitted_entries += 1;
            return;
        };
        for item in items {
            if let Some(name) = item.as_str().filter(|name| public_symbol(name)) {
                definition.tools.push(DeclaredTool {
                    name: name.into(),
                    field: field.into(),
                    server: server.map(str::to_owned),
                });
            } else {
                definition.omitted_entries += 1;
            }
        }
    };
    collect("mcps", fields.get("mcps"), None);
    if let Some(tools) = fields.get("tools") {
        if tools.is_mapping() {
            for level in ["required", "optional"] {
                collect(&format!("tools.{level}"), tools.get(level), None);
            }
            if let Some(servers) = tools.get("mcp").and_then(Yaml::as_mapping) {
                for (server, config) in servers {
                    if let Some(server) = server.as_str().filter(|name| public_symbol(name)) {
                        for level in ["required", "optional"] {
                            collect(
                                &format!("tools.mcp.{level}"),
                                config.get(level),
                                Some(server),
                            );
                        }
                    }
                }
            }
        } else {
            collect("tools", Some(tools), None);
        }
    }
    // Only keys, never configuration objects (which may contain commands or environment values).
    for field in ["mcp-servers", "mcpServers"] {
        if let Some(servers) = fields.get(field).and_then(Yaml::as_mapping) {
            for server in servers.keys() {
                if let Some(name) = server.as_str().filter(|s| public_symbol(s)) {
                    definition.tools.push(DeclaredTool {
                        name: name.into(),
                        field: field.into(),
                        server: None,
                    });
                } else {
                    definition.omitted_entries += 1;
                }
            }
        }
    }
    Some(CopilotAgent {
        // ACP selection and existing workspace history use the frontmatter name.
        id: name.clone(),
        name,
        description: ["description", "purpose"]
            .iter()
            .find_map(|field| scalar(field).filter(|s| public_description(s)))
            .unwrap_or_default(),
        model: scalar("model").filter(|model| public_symbol(model)),
        definition: Some(definition),
        source: None,
    })
}

fn public_symbol(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && (value == "*" || value.as_bytes()[0].is_ascii_alphanumeric())
        && !value.contains("//")
        && !value.contains("..")
        && !sensitive_metadata(value)
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-/*:".contains(&b))
}

pub fn login() -> Result<CopilotStatus, Problem> {
    let output = copilot_command()?
        .args(["login", "--web-flow"])
        .output()
        .map_err(|error| {
            Problem::with(
                "GitHub Copilot sign-in could not be started.",
                error.to_string(),
            )
        })?;
    if !output.status.success() {
        return Err(Problem::with(
            "GitHub Copilot sign-in did not finish.",
            quiet::said(&output.stderr),
        ));
    }
    status()
}

fn read_inventory<T>(
    resource: &str,
    label: &str,
    cwd: &str,
    operation: Operation,
    parse: impl FnOnce(Value) -> Result<Vec<T>, Problem>,
) -> Result<(Vec<T>, Option<String>), Problem> {
    diagnostics::reading(Some(cwd), operation, || {
        let output = copilot_command()?
            .args([resource, "list", "--json"])
            .current_dir(cwd)
            .output()
            .map_err(|_| {
                Problem::plain(format!("Darbot could not read GitHub Copilot {label}."))
            })?;
        if !output.status.success() {
            return Err(Problem::plain(format!(
                "GitHub Copilot could not list {label}."
            )));
        }
        let value = serde_json::from_slice(&output.stdout).map_err(|_| {
            Problem::plain(format!("GitHub Copilot returned invalid {label} data."))
        })?;
        let warning = (!output.stderr.is_empty())
            .then(|| format!("GitHub Copilot reported a warning while listing {label}."));
        Ok((parse(value)?, warning))
    })
}

fn parse_status(initialized: &Value) -> Result<CopilotStatus, Problem> {
    let protocol_version = initialized
        .get("protocolVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid_initialize(initialized))?;
    if protocol_version != 1 {
        return Err(Problem::with(
            "This GitHub Copilot protocol version is not supported by Darbot.",
            format!("Copilot selected ACP protocol version {protocol_version}."),
        ));
    }
    let agent = initialized
        .get("agentCapabilities")
        .ok_or_else(|| invalid_initialize(initialized))?;
    let sessions = agent.get("sessionCapabilities");
    let prompt = agent.get("promptCapabilities");
    let mcp = agent.get("mcpCapabilities");
    let version = initialized
        .pointer("/agentInfo/version")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let auth_methods = initialized
        .get("authMethods")
        .and_then(Value::as_array)
        .map(|methods| {
            methods
                .iter()
                .filter_map(parse_auth_method)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(CopilotStatus {
        version,
        protocol_version,
        authentication: CopilotAuthentication::Unknown,
        capabilities: CopilotCapabilities {
            load_session: agent
                .get("loadSession")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            resume_session: capability_present(sessions, "resume"),
            list_sessions: capability_present(sessions, "list"),
            close_session: capability_present(sessions, "close"),
            delete_session: capability_present(sessions, "delete"),
            // These are usable desktop capabilities, not merely the agent's declarations.
            prompt_image: false,
            prompt_embedded_context: false,
            mcp_http: capability_enabled(mcp, "http"),
            mcp_sse: capability_enabled(mcp, "sse"),
        },
        auth_methods,
        session_count: 0,
        has_more_sessions: false,
        warnings: {
            let mut warnings = Vec::new();
            if capability_enabled(prompt, "image") || capability_enabled(prompt, "embeddedContext")
            {
                warnings.push("The agent supports additional prompt content, but this desktop sends text prompts only.".into());
            }
            if initialized["authMethods"]
                .as_array()
                .is_some_and(|methods| !methods.is_empty())
            {
                warnings.push("Generic ACP authentication methods are not implemented here; GitHub Copilot login is the supported sign-in flow.".into());
            }
            warnings
        },
        observations: Observations::new(),
    })
}

fn parse_auth_method(value: &Value) -> Option<CopilotAuthMethod> {
    Some(CopilotAuthMethod {
        id: value.get("id")?.as_str()?.to_string(),
        name: value.get("name")?.as_str()?.to_string(),
        description: value
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
        kind: if value.pointer("/_meta/terminal-auth").is_some()
            || value.get("type").and_then(Value::as_str) == Some("terminal")
        {
            "terminal".into()
        } else {
            "agent".into()
        },
    })
}

fn parse_plugins(value: Value) -> Result<Vec<CopilotPlugin>, Problem> {
    let records: Vec<PluginRecord> = serde_json::from_value(value).map_err(|error| {
        Problem::with(
            "GitHub Copilot returned invalid plugin data.",
            error.to_string(),
        )
    })?;
    Ok(records
        .into_iter()
        .map(|record| CopilotPlugin {
            name: record.name,
            marketplace: nonempty(record.marketplace),
            version: nonempty(record.version),
            enabled: record.enabled,
            source: nonempty(record.source),
        })
        .collect())
}

fn parse_skills(value: Value) -> Result<Vec<CopilotSkill>, Problem> {
    let records: Vec<SkillRecord> = serde_json::from_value(value).map_err(|error| {
        Problem::with(
            "GitHub Copilot returned invalid skill data.",
            error.to_string(),
        )
    })?;
    Ok(records
        .into_iter()
        .map(|record| CopilotSkill {
            name: record.name,
            description: nonempty(record.description),
            enabled: record.enabled,
            source: nonempty(record.source),
        })
        .collect())
}

fn parse_mcp_servers(value: Value) -> Result<Vec<CopilotMcpServer>, Problem> {
    let servers = value
        .get("mcpServers")
        .and_then(Value::as_object)
        .ok_or_else(|| Problem::plain("GitHub Copilot returned invalid MCP server data."))?;
    let mut summaries = servers
        .iter()
        .map(|(name, server)| CopilotMcpServer {
            name: name.clone(),
            enabled: server
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            source: server
                .get("source")
                .and_then(Value::as_str)
                .map(str::to_string),
            transport: server
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string),
            tool_count: server
                .get("tools")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0),
        })
        .collect::<Vec<_>>();
    summaries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(summaries)
}

fn capability_present(capabilities: Option<&Value>, name: &str) -> bool {
    capabilities
        .and_then(|value| value.get(name))
        .is_some_and(Value::is_object)
}

fn capability_enabled(capabilities: Option<&Value>, name: &str) -> bool {
    capabilities
        .and_then(|value| value.get(name))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn invalid_initialize(value: &Value) -> Problem {
    Problem::with(
        "GitHub Copilot returned an invalid initialization response.",
        value.to_string(),
    )
}

fn authentication_required(problem: &Problem) -> bool {
    let text = format!(
        "{}\n{}",
        problem.said,
        problem.detail.as_deref().unwrap_or_default()
    )
    .to_lowercase();
    text.contains("auth_required")
        || text.contains("expired")
        || text.contains("expired_token")
        || text.contains("invalid_token")
        || text.contains("invalid_grant")
        || text.contains("unauthorized")
        || text.contains("401")
        || text.contains("authentication required")
        || text.contains("not authenticated")
        || text.contains("log in")
}

fn nonempty(value: Option<String>) -> Option<String> {
    value.and_then(|value| (!value.trim().is_empty()).then_some(value))
}

mod studio_catalog {
    use super::*;
    use reqwest::blocking::Client;
    use reqwest::Url;
    use std::sync::OnceLock;
    use std::time::UNIX_EPOCH;

    const CONFIG_LIMIT: usize = 128 * 1024;
    const CACHE_LIMIT: usize = 16 * 1024 * 1024;
    const RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
    const TOKEN_LIMIT: usize = 128 * 1024;
    const MAX_PAGES: usize = 1000;
    const MAX_AGENTS: usize = 100_000;
    const BOTS_PATH: &str = "/api/data/v9.2/bots";
    const BOT_SELECT: &str = "botid,name,schemaname,modifiedon,statecode,description";
    const STALE_SECONDS: u64 = 3600;

    fn approved_assets(source: &SourceConfig) -> bool {
        source.asset_inventory
    }

    #[derive(Copy, Clone)]
    struct Projection {
        operation: Operation,
        path: &'static str,
        select: &'static str,
        id: &'static str,
        filter: Option<&'static str>,
    }

    const BOTS: Projection = Projection {
        operation: Operation::Bots,
        path: BOTS_PATH,
        select: BOT_SELECT,
        id: "botid",
        filter: None,
    };
    // Dataverse Web API references: workflow, canvasapp and appmodule. Exclude
    // process activations, templates, dialogs, business rules and actions.
    const ASSETS: [(&str, &str, Projection); 3] = [
        ("workflow", "name", Projection {
            operation: Operation::Workflows,
            path: "/api/data/v9.2/workflows", select: "workflowid,name", id: "workflowid",
            filter: Some("type eq 1 and (category eq 0 or category eq 4 or category eq 5 or category eq 6 or category eq 7)"),
        }),
        ("canvas-app", "displayname", Projection {
            operation: Operation::CanvasApps,
            path: "/api/data/v9.2/canvasapps", select: "canvasappid,displayname", id: "canvasappid", filter: None,
        }),
        ("model-driven-app", "name", Projection {
            operation: Operation::ModelDrivenApps,
            path: "/api/data/v9.2/appmodules", select: "appmoduleid,name", id: "appmoduleid", filter: None,
        }),
    ];

    fn asset_reason(failure: Failure) -> &'static str {
        match failure {
            Failure::Forbidden => "HTTP 403",
            Failure::Unauthorized => "HTTP 401",
            Failure::NotFound => "HTTP 404",
            Failure::Retryable => "HTTP 429 or 5xx",
            Failure::Http => "unexpected HTTP status",
            Failure::Network => "network failure",
            Failure::Limit => "collection limit exceeded",
            Failure::Pagination => "invalid pagination",
            _ => "invalid metadata",
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(super) enum Failure {
        Config,
        ConfigChanged,
        Cache,
        CacheWrite,
        CliMissing,
        Cli,
        CliTimeout,
        Token,
        Tenant,
        Account,
        Identity,
        Network,
        Unauthorized,
        Forbidden,
        NotFound,
        Retryable,
        Http,
        Response,
        Pagination,
        Limit,
        Aged,
        Unsupported,
    }

    impl Failure {
        fn message(self) -> &'static str {
            match self {
                Self::Config => "Copilot Studio configuration is invalid or unreadable. Check studio-sources.json schema, unique sources, GUIDs, account and public Dataverse root URLs.",
                Self::ConfigChanged => "Copilot Studio configuration changed during discovery. Refresh again; results for the previous configuration were discarded.",
                Self::Cache => "The Copilot Studio cache is invalid or unreadable. Refresh the catalog to rebuild it.",
                Self::CacheWrite => "The Copilot Studio catalog could not be saved atomically (16 MiB limit). Check app-data permissions and refresh again.",
                Self::CliMissing => "Azure CLI was not found in an absolute PATH directory. Install Azure CLI, then refresh.",
                Self::Cli => "Azure CLI could not obtain a token. Verify the configured subscription and existing signed-in account, then refresh. Darbot does not change accounts or sign in automatically.",
                Self::CliTimeout => "Azure CLI token acquisition exceeded 60 seconds. Check Azure CLI outside Darbot, then refresh.",
                Self::Token => "Azure CLI returned an invalid token response. Verify Azure CLI authentication, then refresh.",
                Self::Tenant => "Azure CLI returned a different tenant. Verify the configured subscription and tenant; no fallback account was used.",
                Self::Account => "Dataverse authenticated a different account. Verify the configured account and subscription; no fallback account was used.",
                Self::Identity => "Dataverse identity verification failed. Verify access to the configured environment, then refresh.",
                Self::Network => "Dataverse could not be reached within the network timeout. Check connectivity, then refresh.",
                Self::Unauthorized => "Dataverse returned HTTP 401. Renew the configured Azure CLI authentication outside Darbot, then refresh.",
                Self::Forbidden => "Dataverse returned HTTP 403. Request read access to this environment and its bots, then refresh.",
                Self::NotFound => "Dataverse returned HTTP 404. Verify the environment URL and Dataverse API availability.",
                Self::Retryable => "Dataverse returned HTTP 429 or 5xx. The service is busy; wait and refresh again.",
                Self::Http => "Dataverse returned an unexpected HTTP status or redirect. Verify the environment URL and access.",
                Self::Response => "Dataverse returned invalid bot metadata. Refresh again; the previous complete snapshot was retained.",
                Self::Pagination => "Dataverse returned unsafe, repeated or conflicting pagination. The incomplete snapshot was discarded.",
                Self::Limit => "Dataverse exceeded the bounded response, page or agent limit. The incomplete snapshot was discarded.",
                Self::Aged => "This Copilot Studio snapshot is more than one hour old. Refresh the catalog.",
                Self::Unsupported => "Copilot Studio catalog configuration requires Windows LOCALAPPDATA.",
            }
        }

        fn problem(self) -> Problem {
            Problem::plain(self.message())
        }

        fn known_message(message: &str) -> bool {
            [
                Self::Config,
                Self::ConfigChanged,
                Self::Cache,
                Self::CacheWrite,
                Self::CliMissing,
                Self::Cli,
                Self::CliTimeout,
                Self::Token,
                Self::Tenant,
                Self::Account,
                Self::Identity,
                Self::Network,
                Self::Unauthorized,
                Self::Forbidden,
                Self::NotFound,
                Self::Retryable,
                Self::Http,
                Self::Response,
                Self::Pagination,
                Self::Limit,
                Self::Aged,
                Self::Unsupported,
            ]
            .iter()
            .any(|failure| failure.message() == message)
        }
    }

    #[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub(super) struct SourceConfig {
        pub(super) tenant_id: String,
        pub(super) environment_id: String,
        pub(super) environment_name: String,
        pub(super) environment_url: String,
        pub(super) subscription_id: String,
        pub(super) account: String,
        #[serde(default)]
        asset_inventory: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub(super) struct Config {
        schema_version: u32,
        pub(super) sources: Vec<SourceConfig>,
    }

    #[derive(Clone, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub(super) struct Snapshot {
        pub(super) config: SourceConfig,
        pub(super) agents: Vec<CopilotAgent>,
        pub(super) status: StudioSourceStatus,
    }

    #[derive(Default, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub(super) struct Cache {
        pub(super) schema_version: u32,
        pub(super) sources: Vec<Snapshot>,
    }

    pub(super) fn guid(value: &str) -> Result<String, Failure> {
        if value.len() != 36
            || !value.bytes().enumerate().all(|(index, ch)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    ch == b'-'
                } else {
                    ch.is_ascii_hexdigit()
                }
            })
        {
            return Err(Failure::Config);
        }
        Ok(value.to_ascii_lowercase())
    }

    fn text(value: &str, max: usize) -> bool {
        !value.trim().is_empty() && value.len() <= max && !value.chars().any(|ch| ch.is_control())
    }

    fn account(value: &str) -> bool {
        text(value, 320)
            && value.bytes().all(|ch| {
                ch.is_ascii_alphanumeric() || matches!(ch, b'@' | b'.' | b'_' | b'-' | b'+' | b'#')
            })
    }

    fn root_url(value: &str) -> Result<String, Failure> {
        // Validate the original spelling too: URL parsers normalize backslashes and dot segments.
        let authority = value
            .strip_prefix("https://")
            .ok_or(Failure::Config)?
            .strip_suffix('/')
            .unwrap_or_else(|| value.strip_prefix("https://").unwrap());
        let host = authority.strip_suffix(":443").unwrap_or(authority);
        if host.len() > 253
            || !host.to_ascii_lowercase().ends_with(".crm.dynamics.com")
            || !host.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && label.as_bytes()[0].is_ascii_alphanumeric()
                    && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                    && label
                        .bytes()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == b'-')
            })
        {
            return Err(Failure::Config);
        }
        let parsed = Url::parse(value).map_err(|_| Failure::Config)?;
        if parsed.scheme() != "https"
            || parsed.path() != "/"
            || parsed.port().is_some()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(Failure::Config);
        }
        Ok(format!("https://{}", host.to_ascii_lowercase()))
    }

    fn normalize_source(source: &mut SourceConfig) -> Result<(), Failure> {
        source.tenant_id = guid(&source.tenant_id)?;
        source.environment_id = guid(&source.environment_id)?;
        source.subscription_id = guid(&source.subscription_id)?;
        if !text(&source.environment_name, 256) || !account(&source.account) {
            return Err(Failure::Config);
        }
        source.account = source.account.to_ascii_lowercase();
        source.environment_url = root_url(&source.environment_url)?;
        Ok(())
    }

    pub(super) fn parse_config(bytes: &[u8]) -> Result<Config, Failure> {
        if bytes.len() > CONFIG_LIMIT {
            return Err(Failure::Config);
        }
        let mut config: Config = serde_json::from_slice(bytes).map_err(|_| Failure::Config)?;
        if config.schema_version != 1 || config.sources.len() > 100 {
            return Err(Failure::Config);
        }
        let mut identities = HashSet::new();
        let mut urls = HashSet::new();
        for source in &mut config.sources {
            normalize_source(source)?;
            if !identities.insert((source.tenant_id.clone(), source.environment_id.clone()))
                || !urls.insert(source.environment_url.clone())
            {
                return Err(Failure::Config);
            }
        }
        Ok(config)
    }

    pub(super) fn scoped_id(config: &SourceConfig, bot_id: &str) -> String {
        format!(
            "studio:{}:{}:{}",
            config.tenant_id, config.environment_id, bot_id
        )
        .to_ascii_lowercase()
    }

    fn status(config: &SourceConfig, now: Option<u64>) -> StudioSourceStatus {
        StudioSourceStatus {
            tenant_id: config.tenant_id.clone(),
            environment_id: config.environment_id.clone(),
            environment_name: config.environment_name.clone(),
            environment_url: config.environment_url.clone(),
            state: if now.is_some() {
                "ready"
            } else {
                "unavailable"
            }
            .into(),
            agent_count: 0,
            last_synced_at: now,
            error: None,
            assets: None,
            asset_warnings: Vec::new(),
            observations: Observations::new(),
        }
    }

    fn read_bounded(
        path: &Path,
        limit: usize,
        failure: Failure,
    ) -> Result<Option<Vec<u8>>, Failure> {
        let file = match fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(failure),
        };
        let mut bytes = Vec::new();
        file.take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| failure)?;
        if bytes.len() > limit {
            return Err(failure);
        }
        Ok(Some(bytes))
    }

    fn cache_write(path: &Path, cache: &Cache) -> Result<(), Failure> {
        let content = serde_json::to_string(cache).map_err(|_| Failure::CacheWrite)?;
        if content.len() > CACHE_LIMIT {
            return Err(Failure::CacheWrite);
        }
        // Reuse the approved atomic writer when its 1 MiB text limit permits.
        if content.len() <= 1024 * 1024 {
            return copilot_files::write(path, &content).map_err(|_| Failure::CacheWrite);
        }
        // Larger catalogs use the same sibling-file, sync and rename protocol.
        let parent = path.parent().ok_or(Failure::CacheWrite)?;
        let temporary = parent.join(format!(".studio-catalog-{:032x}", rand::random::<u128>()));
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            if let Ok(metadata) = fs::metadata(path) {
                file.set_permissions(metadata.permissions())?;
            }
            file.write_all(content.as_bytes())?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result.map_err(|_: std::io::Error| Failure::CacheWrite)
    }

    pub(super) fn validate_snapshot(snapshot: &Snapshot, now: u64) -> Result<(), Failure> {
        let mut config = snapshot.config.clone();
        normalize_source(&mut config).map_err(|_| Failure::Cache)?;
        if config != snapshot.config || snapshot.agents.len() > MAX_AGENTS {
            return Err(Failure::Cache);
        }
        let actual = &snapshot.status;
        for (&op, history) in &actual.observations {
            let allowed = matches!(
                op,
                Operation::Identity | Operation::VerifyAccount | Operation::Bots
            ) || (approved_assets(&config)
                && ASSETS.iter().any(|(_, _, q)| q.operation == op));
            let valid = |call: diagnostics::Call| {
                call.at_unix_ms > 0
                    && call.at_unix_ms / 1000 <= now.saturating_add(300)
                    && call.http_status.is_none_or(|s| (100..=599).contains(&s))
                    && (!call.succeeded || call.http_status == Some(200))
            };
            if !allowed
                || !valid(history.last_call)
                || history
                    .last_success
                    .is_some_and(|c| !valid(c) || !c.succeeded)
                || history
                    .last_failure
                    .is_some_and(|c| !valid(c) || c.succeeded)
                || Some(history.last_call)
                    != if history.last_call.succeeded {
                        history.last_success
                    } else {
                        history.last_failure
                    }
            {
                return Err(Failure::Cache);
            }
        }
        if actual.assets.is_some() || !actual.asset_warnings.is_empty() {
            if !approved_assets(&config) || actual.last_synced_at.is_none() {
                return Err(Failure::Cache);
            }
            let mut failed = HashSet::new();
            for warning in &actual.asset_warnings {
                let (kind, reason) = warning.split_once(": ").ok_or(Failure::Cache)?;
                if !ASSETS.iter().any(|entry| entry.0 == kind)
                    || !failed.insert(kind)
                    || ![
                        Failure::Forbidden,
                        Failure::Unauthorized,
                        Failure::NotFound,
                        Failure::Retryable,
                        Failure::Http,
                        Failure::Network,
                        Failure::Limit,
                        Failure::Pagination,
                        Failure::Response,
                    ]
                    .iter()
                    .any(|&f| asset_reason(f) == reason)
                {
                    return Err(Failure::Cache);
                }
            }
            if actual.assets.is_none() != (failed.len() == ASSETS.len()) {
                return Err(Failure::Cache);
            }
            let mut ids = HashSet::new();
            for asset in actual.assets.iter().flatten() {
                if !ASSETS.iter().any(|entry| entry.0 == asset.kind)
                    || failed.contains(asset.kind.as_str())
                    || !text(&asset.name, 1024)
                    || guid(&asset.id).ok().as_ref() != Some(&asset.id)
                    || !ids.insert((&asset.kind, &asset.id))
                    || ids.len() > ASSETS.len() * MAX_AGENTS
                {
                    return Err(Failure::Cache);
                }
            }
        }
        let expected = status(&config, actual.last_synced_at);
        if actual.tenant_id != expected.tenant_id
            || actual.environment_id != expected.environment_id
            || actual.environment_name != expected.environment_name
            || actual.environment_url != expected.environment_url
            || actual.agent_count != snapshot.agents.len()
            || actual
                .error
                .as_deref()
                .is_some_and(|error| !Failure::known_message(error))
        {
            return Err(Failure::Cache);
        }
        match (actual.state.as_str(), actual.last_synced_at) {
            ("ready", Some(timestamp))
                if timestamp > 0 && timestamp <= now + 300 && actual.error.is_none() => {}
            ("stale", Some(timestamp))
                if timestamp > 0 && timestamp <= now + 300 && actual.error.is_some() => {}
            ("unavailable", None) if snapshot.agents.is_empty() && actual.error.is_some() => {}
            _ => return Err(Failure::Cache),
        }
        let mut ids = HashSet::new();
        for agent in &snapshot.agents {
            let source = agent.source.as_ref().ok_or(Failure::Cache)?;
            if source.provider != "copilot-studio"
                || source.tenant_id != config.tenant_id
                || source.environment_id != config.environment_id
                || source.environment_name != config.environment_name
                || source.environment_url != config.environment_url
                || guid(&source.bot_id).map_err(|_| Failure::Cache)? != source.bot_id
                || agent.id != scoped_id(&config, &source.bot_id)
                || !ids.insert(&agent.id)
                || !text(&agent.name, 1024)
                || !text(&source.schema_name, 512)
                || source
                    .declared_description
                    .as_deref()
                    .is_some_and(|s| !public_description(s))
                || !timestamp(&source.modified_at)
                || !matches!(source.state_code, 0 | 1)
                || Some(source.last_synced_at) != actual.last_synced_at
                || agent.model.is_some()
                || agent.definition.is_some()
                || agent.description != format!("Copilot Studio · {}", config.environment_name)
            {
                return Err(Failure::Cache);
            }
        }
        Ok(())
    }

    pub(super) fn matching_snapshot(
        cache: &Cache,
        config: &SourceConfig,
        now: u64,
    ) -> Result<Option<Snapshot>, Failure> {
        let mut matches = cache
            .sources
            .iter()
            .filter(|snapshot| &snapshot.config == config);
        let Some(snapshot) = matches.next() else {
            return Ok(None);
        };
        if matches.next().is_some() {
            return Err(Failure::Cache);
        }
        validate_snapshot(snapshot, now)?;
        let mut snapshot = snapshot.clone();
        if snapshot.status.state == "ready"
            && snapshot
                .status
                .last_synced_at
                .is_some_and(|time| now.saturating_sub(time) > STALE_SECONDS)
        {
            snapshot.status.state = "stale".into();
            snapshot.status.error = Some(Failure::Aged.message().into());
        }
        Ok(Some(snapshot))
    }

    pub(super) fn refreshed(
        config: &SourceConfig,
        previous: Option<Snapshot>,
        result: Result<Vec<CopilotAgent>, Failure>,
        now: u64,
    ) -> Snapshot {
        match result {
            Ok(agents) => {
                let mut status = status(config, Some(now));
                status.agent_count = agents.len();
                Snapshot {
                    config: config.clone(),
                    agents,
                    status,
                }
            }
            Err(error) => {
                let mut snapshot = previous.unwrap_or_else(|| Snapshot {
                    config: config.clone(),
                    agents: Vec::new(),
                    status: status(config, None),
                });
                snapshot.status.state = if snapshot.status.last_synced_at.is_some() {
                    "stale"
                } else {
                    "unavailable"
                }
                .into();
                snapshot.status.error = Some(error.message().into());
                snapshot
            }
        }
    }

    fn data_directory() -> Result<PathBuf, Failure> {
        if !cfg!(windows) {
            return Err(Failure::Unsupported);
        }
        let root = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .filter(|root| root.is_absolute())
            .ok_or(Failure::Unsupported)?;
        Ok(root.join("ai.darbotlm.darbot.desktop"))
    }

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }

    const CACHE_SCHEMA: u32 = 2;

    fn decode_cache(bytes: &[u8]) -> Result<Cache, Failure> {
        // v1 has catalog sync times and coarse warnings, not call times or durations.
        // Its absent observations map stays empty, including for a cached HTTP 403.
        let mut cache: Cache = serde_json::from_slice(bytes).map_err(|_| Failure::Cache)?;
        if !matches!(cache.schema_version, 1 | CACHE_SCHEMA) || cache.sources.len() > 100 {
            return Err(Failure::Cache);
        }
        cache.schema_version = CACHE_SCHEMA;
        Ok(cache)
    }

    pub(super) fn catalog(refresh: bool) -> Result<CopilotAgentCatalog, Problem> {
        // Studio configuration is Windows-only; unconfigured platforms keep local discovery.
        if !cfg!(windows) {
            return Ok(CopilotAgentCatalog {
                agents: Vec::new(),
                sources: Vec::new(),
                warnings: Vec::new(),
            });
        }
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let _lock = LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| Failure::Cache.problem())?;
        let directory = data_directory().map_err(Failure::problem)?;
        let Some(bytes) = read_bounded(
            &directory.join("studio-sources.json"),
            CONFIG_LIMIT,
            Failure::Config,
        )
        .map_err(Failure::problem)?
        else {
            return Ok(CopilotAgentCatalog {
                agents: Vec::new(),
                sources: Vec::new(),
                warnings: Vec::new(),
            });
        };
        let config = parse_config(&bytes).map_err(Failure::problem)?;
        let path = directory.join("studio-catalog.json");
        let mut warnings = Vec::new();
        let cache = read_bounded(&path, CACHE_LIMIT, Failure::Cache)
            .and_then(|bytes| match bytes {
                None => Ok(Cache {
                    schema_version: CACHE_SCHEMA,
                    sources: Vec::new(),
                }),
                Some(bytes) => decode_cache(&bytes),
            })
            .unwrap_or_else(|error| {
                warnings.push(error.message().into());
                Cache::default()
            });
        let mut next = Cache {
            schema_version: CACHE_SCHEMA,
            sources: Vec::new(),
        };
        for source in &config.sources {
            let previous = matching_snapshot(&cache, source, now()).unwrap_or_else(|error| {
                warnings.push(error.message().into());
                None
            });
            let snapshot = match previous {
                Some(snapshot) if !refresh => snapshot,
                previous => {
                    let synced_at = now();
                    refresh_with(source, previous, synced_at, |rows| {
                        fetch_source(source, synced_at, rows)
                    })
                }
            };
            next.sources.push(snapshot);
        }
        let current = read_bounded(
            &directory.join("studio-sources.json"),
            CONFIG_LIMIT,
            Failure::Config,
        )
        .map_err(Failure::problem)?
        .ok_or_else(|| Failure::ConfigChanged.problem())?;
        if parse_config(&current).map_err(Failure::problem)?.sources != config.sources {
            return Err(Failure::ConfigChanged.problem());
        }
        // Always write only currently configured identities: removed sources/account snapshots
        // must not survive a successful cache reconciliation.
        if let Err(error) = cache_write(&path, &next) {
            warnings.push(error.message().into());
        }
        let mut result = CopilotAgentCatalog {
            agents: Vec::new(),
            sources: Vec::new(),
            warnings,
        };
        for snapshot in next.sources {
            if let Some(error) = &snapshot.status.error {
                result.warnings.push(format!(
                    "Copilot Studio · {}: {error}",
                    snapshot.config.environment_name
                ));
            }
            result.agents.extend(snapshot.agents);
            result.sources.push(snapshot.status);
        }
        Ok(result)
    }

    fn azure_command(config: &SourceConfig) -> Result<std::process::Command, Failure> {
        #[cfg(windows)]
        {
            // Azure's Windows MSI launcher uses wbin\..\python.exe. Invoking that
            // interpreter directly avoids shell quoting/injection and leaves one killable process.
            let paths = std::env::var_os("PATH").ok_or(Failure::CliMissing)?;
            for directory in std::env::split_paths(&paths).filter(|path| path.is_absolute()) {
                if directory.join("az.cmd").is_file() {
                    let python = directory
                        .parent()
                        .ok_or(Failure::CliMissing)?
                        .join("python.exe");
                    if !python.is_file() {
                        continue;
                    }
                    let mut command = quiet::command(python);
                    command.args(["-IBm", "azure.cli"]);
                    command.env("AZ_INSTALLER", "MSI");
                    token_args(&mut command, config);
                    return Ok(command);
                }
                let executable = directory.join("az.exe");
                if executable.is_file() {
                    let mut command = quiet::command(executable);
                    token_args(&mut command, config);
                    return Ok(command);
                }
            }
            Err(Failure::CliMissing)
        }
        #[cfg(not(windows))]
        {
            let _ = config;
            Err(Failure::Unsupported)
        }
    }

    pub(super) fn token_args(command: &mut std::process::Command, config: &SourceConfig) {
        command.args([
            "account",
            "get-access-token",
            "--subscription",
            &config.subscription_id,
            "--resource",
            &config.environment_url,
            "--output",
            "json",
            "--only-show-errors",
        ]);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
    }

    #[derive(Deserialize)]
    struct TokenResponse {
        tenant: String,
        #[serde(rename = "accessToken")]
        access_token: String,
    }

    pub(super) fn parse_token(bytes: &[u8], config: &SourceConfig) -> Result<String, Failure> {
        if bytes.len() > TOKEN_LIMIT {
            return Err(Failure::Token);
        }
        let response: TokenResponse = serde_json::from_slice(bytes).map_err(|_| Failure::Token)?;
        if guid(&response.tenant).map_err(|_| Failure::Token)? != config.tenant_id {
            return Err(Failure::Tenant);
        }
        if response.access_token.len() < 16
            || response.access_token.len() > 64 * 1024
            || !response
                .access_token
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'.' | b'_' | b'-'))
        {
            return Err(Failure::Token);
        }
        Ok(response.access_token)
    }

    fn token(config: &SourceConfig) -> Result<String, Failure> {
        let mut command = azure_command(config)?;
        let mut child = command.spawn().map_err(|_| Failure::Cli)?;
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Failure::Cli);
        };
        let (sender, receiver) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = stdout.take(TOKEN_LIMIT as u64 + 1).read_to_end(&mut bytes);
            let _ = sender.send(result.map(|_| bytes));
        });
        let started = Instant::now();
        let result = loop {
            if started.elapsed() >= Duration::from_secs(60) {
                break Err(Failure::CliTimeout);
            }
            match child.try_wait() {
                Ok(Some(status)) if status.success() => {
                    let remaining = Duration::from_secs(60).saturating_sub(started.elapsed());
                    break receiver
                        .recv_timeout(remaining)
                        .map_err(|_| Failure::CliTimeout)
                        .and_then(|bytes| bytes.map_err(|_| Failure::Cli))
                        .and_then(|bytes| parse_token(&bytes, config));
                }
                Ok(Some(_)) | Err(_) => break Err(Failure::Cli),
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            }
        };
        if result.is_err() {
            let _ = child.kill();
        }
        let _ = child.wait();
        result
    }

    struct Dataverse<'a> {
        client: Client,
        token: &'a str,
        observations: &'a mut Observations,
    }

    impl Dataverse<'_> {
        fn get<T>(
            &mut self,
            op: Operation,
            url: Url,
            accept: impl FnOnce(&[u8]) -> Result<T, Failure>,
        ) -> Result<T, Failure> {
            observed_get(
                self.observations,
                op,
                || {
                    let response = self
                        .client
                        .get(url)
                        .bearer_auth(self.token)
                        .header("Accept", "application/json")
                        .header("OData-Version", "4.0")
                        .header("OData-MaxVersion", "4.0")
                        .header("Prefer", "odata.maxpagesize=100")
                        .send()
                        .map_err(|_| Failure::Network)?;
                    Ok((
                        response.status().as_u16(),
                        response.content_length(),
                        response,
                    ))
                },
                accept,
            )
        }
    }

    fn observed_get<T, R: Read>(
        observations: &mut Observations,
        op: Operation,
        send: impl FnOnce() -> Result<(u16, Option<u64>, R), Failure>,
        accept: impl FnOnce(&[u8]) -> Result<T, Failure>,
    ) -> Result<T, Failure> {
        let started = Instant::now();
        let mut status = None;
        let result = send().and_then(|(code, length, response)| {
            status = Some(code);
            match code {
                200 => {}
                401 => return Err(Failure::Unauthorized),
                403 => return Err(Failure::Forbidden),
                404 => return Err(Failure::NotFound),
                429 | 500..=599 => return Err(Failure::Retryable),
                _ => return Err(Failure::Http),
            }
            if length.is_some_and(|size| size > RESPONSE_LIMIT as u64) {
                return Err(Failure::Limit);
            }
            let mut bytes = Vec::new();
            response
                .take(RESPONSE_LIMIT as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| Failure::Network)?;
            if bytes.len() > RESPONSE_LIMIT {
                return Err(Failure::Limit);
            }
            accept(&bytes)
        });
        if let Some(call) = diagnostics::finished(started, result.is_ok(), status) {
            diagnostics::record(observations, op, call);
        }
        result
    }

    #[derive(Deserialize)]
    struct Identity {
        #[serde(rename = "UserId")]
        user_id: String,
        #[serde(rename = "OrganizationId")]
        organization_id: String,
    }

    #[derive(Deserialize)]
    struct UserIdentity {
        domainname: String,
    }

    pub(super) fn verify_account(bytes: &[u8], config: &SourceConfig) -> Result<(), Failure> {
        let user: UserIdentity = serde_json::from_slice(bytes).map_err(|_| Failure::Identity)?;
        if !account(&user.domainname) || !user.domainname.eq_ignore_ascii_case(&config.account) {
            return Err(Failure::Account);
        }
        Ok(())
    }

    #[derive(Deserialize)]
    pub(super) struct BotPage {
        value: Vec<BotRecord>,
        #[serde(rename = "@odata.nextLink")]
        pub(super) next_link: Option<String>,
    }

    #[derive(Deserialize)]
    struct BotRecord {
        botid: String,
        description: Option<String>,
        name: String,
        schemaname: String,
        modifiedon: String,
        statecode: i64,
    }

    fn timestamp(value: &str) -> bool {
        // Dataverse emits UTC ISO-8601; reject free text and unbounded metadata.
        let bytes = value.as_bytes();
        if !(20..=28).contains(&bytes.len())
            || !value.is_ascii()
            || bytes[4] != b'-'
            || bytes[7] != b'-'
            || bytes[10] != b'T'
            || bytes[13] != b':'
            || bytes[16] != b':'
            || bytes[bytes.len() - 1] != b'Z'
        {
            return false;
        }
        if ![0..4, 5..7, 8..10, 11..13, 14..16, 17..19]
            .iter()
            .all(|range| bytes[range.clone()].iter().all(u8::is_ascii_digit))
        {
            return false;
        }
        if bytes.len() > 20
            && (bytes[19] != b'.'
                || bytes.len() == 21
                || !bytes[20..bytes.len() - 1].iter().all(u8::is_ascii_digit))
        {
            return false;
        }
        let number = |start, end| value[start..end].parse::<u32>().unwrap_or(u32::MAX);
        (1..=12).contains(&number(5, 7))
            && (1..=31).contains(&number(8, 10))
            && number(11, 13) <= 23
            && number(14, 16) <= 59
            && number(17, 19) <= 59
    }

    pub(super) fn parse_page(bytes: &[u8]) -> Result<BotPage, Failure> {
        if bytes.len() > RESPONSE_LIMIT {
            return Err(Failure::Limit);
        }
        serde_json::from_slice(bytes).map_err(|_| Failure::Response)
    }

    pub(super) fn append_page(
        page: BotPage,
        config: &SourceConfig,
        synced_at: u64,
        agents: &mut BTreeMap<String, CopilotAgent>,
    ) -> Result<Option<String>, Failure> {
        let mut page_ids = HashSet::new();
        for bot in page.value {
            let bot_id = guid(&bot.botid).map_err(|_| Failure::Response)?;
            if !text(&bot.name, 1024)
                || !text(&bot.schemaname, 512)
                || !timestamp(&bot.modifiedon)
                || !matches!(bot.statecode, 0 | 1)
            {
                return Err(Failure::Response);
            }
            let id = scoped_id(config, &bot_id);
            if !page_ids.insert(id.clone()) {
                return Err(Failure::Response);
            }
            let agent = CopilotAgent {
                id: id.clone(),
                name: bot.name,
                description: format!("Copilot Studio · {}", config.environment_name),
                model: None,
                definition: None,
                source: Some(StudioAgentSource {
                    provider: "copilot-studio".into(),
                    tenant_id: config.tenant_id.clone(),
                    environment_id: config.environment_id.clone(),
                    environment_name: config.environment_name.clone(),
                    environment_url: config.environment_url.clone(),
                    bot_id,
                    schema_name: bot.schemaname,
                    declared_description: bot.description.filter(|s| public_description(s)),
                    modified_at: bot.modifiedon,
                    state_code: bot.statecode,
                    last_synced_at: synced_at,
                }),
            };
            // An identical row repeated across page boundaries is safe to deduplicate; a changed
            // row means this traversal is not a coherent snapshot and must not replace the cache.
            if let Some(existing) = agents.get(&id) {
                if existing != &agent {
                    return Err(Failure::Pagination);
                }
            } else {
                agents.insert(id, agent);
                if agents.len() > MAX_AGENTS {
                    return Err(Failure::Limit);
                }
            }
        }
        Ok(page.next_link)
    }

    #[cfg(test)]
    pub(super) fn next_link(config: &SourceConfig, value: &str) -> Result<Url, Failure> {
        projected_link(config, BOTS, value)
    }

    fn projected_link(
        config: &SourceConfig,
        query: Projection,
        value: &str,
    ) -> Result<Url, Failure> {
        if value.len() > 32 * 1024
            || value.chars().any(|ch| ch.is_control())
            || value.contains('\\')
        {
            return Err(Failure::Pagination);
        }
        let url = Url::parse(value).map_err(|_| Failure::Pagination)?;
        let base = Url::parse(&config.environment_url).map_err(|_| Failure::Pagination)?;
        let rest = value.strip_prefix("https://").ok_or(Failure::Pagination)?;
        let path_start = rest.find('/').ok_or(Failure::Pagination)?;
        if root_url(&format!("https://{}", &rest[..path_start])).map_err(|_| Failure::Pagination)?
            != config.environment_url
        {
            return Err(Failure::Pagination);
        }
        let raw_path = rest[path_start..]
            .split(['?', '#'])
            .next()
            .ok_or(Failure::Pagination)?;
        if url.origin() != base.origin()
            || url.path() != query.path
            || raw_path != query.path
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(Failure::Pagination);
        }
        let mut keys = HashSet::new();
        for (key, value) in url.query_pairs() {
            if !keys.insert(key.to_string()) {
                return Err(Failure::Pagination);
            }
            match key.as_ref() {
                "$select" if value == query.select => {}
                "$orderby" if value == query.id || value.strip_suffix(" asc") == Some(query.id) => {
                }
                "$filter" if query.filter == Some(value.as_ref()) => {}
                "$skiptoken" if !value.is_empty() => {}
                _ => return Err(Failure::Pagination),
            }
        }
        if !keys.contains("$skiptoken") {
            return Err(Failure::Pagination);
        }
        // Some OData next links contain only a cursor. Reapply the same metadata projection.
        let mut url = url;
        if !keys.contains("$select") {
            url.query_pairs_mut().append_pair("$select", query.select);
        }
        if !keys.contains("$orderby") {
            url.query_pairs_mut().append_pair("$orderby", query.id);
        }
        if let Some(filter) = query.filter.filter(|_| !keys.contains("$filter")) {
            url.query_pairs_mut().append_pair("$filter", filter);
        }
        Ok(url)
    }

    type SourceResult = (Vec<CopilotAgent>, Option<Vec<StudioAsset>>, Vec<String>);
    fn refresh_with(
        config: &SourceConfig,
        mut previous: Option<Snapshot>,
        synced_at: u64,
        fetch: impl FnOnce(&mut Observations) -> Result<SourceResult, Failure>,
    ) -> Snapshot {
        let mut observations = previous
            .as_mut()
            .map(|s| std::mem::take(&mut s.status.observations))
            .unwrap_or_default();
        let mut snapshot = match fetch(&mut observations) {
            Ok((agents, assets, warnings)) => {
                let mut snapshot = refreshed(config, previous, Ok(agents), synced_at);
                snapshot.status.assets = assets;
                snapshot.status.asset_warnings = warnings;
                snapshot
            }
            Err(error) => refreshed(config, previous, Err(error), synced_at),
        };
        snapshot.status.observations = observations;
        snapshot
    }

    fn fetch_source(
        config: &SourceConfig,
        synced_at: u64,
        observations: &mut Observations,
    ) -> Result<SourceResult, Failure> {
        let token = token(config)?;
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| Failure::Network)?;
        let identity_url = Url::parse(&format!("{}/api/data/v9.2/WhoAmI", config.environment_url))
            .map_err(|_| Failure::Config)?;
        let mut api = Dataverse {
            client,
            token: &token,
            observations,
        };
        let user_id = api.get(Operation::Identity, identity_url, |bytes| {
            let identity: Identity =
                serde_json::from_slice(bytes).map_err(|_| Failure::Identity)?;
            guid(&identity.organization_id).map_err(|_| Failure::Identity)?;
            guid(&identity.user_id).map_err(|_| Failure::Identity)
        })?;
        let user_url = Url::parse(&format!(
            "{}/api/data/v9.2/systemusers({user_id})?$select=domainname",
            config.environment_url
        ))
        .map_err(|_| Failure::Identity)?;
        api.get(Operation::VerifyAccount, user_url, |bytes| {
            verify_account(bytes, config)
        })?;
        let mut agents = BTreeMap::new();
        pages(&mut api, config, BOTS, |bytes| {
            append_page(parse_page(bytes)?, config, synced_at, &mut agents)
        })?;
        let mut assets = None;
        let mut warnings = Vec::new();
        if approved_assets(config) {
            for (kind, name, query) in ASSETS {
                let mut rows = BTreeMap::new();
                match pages(&mut api, config, query, |bytes| {
                    asset_page(bytes, kind, query.id, name, &mut rows)
                }) {
                    Ok(()) => assets
                        .get_or_insert_with(Vec::new)
                        .extend(rows.into_values()),
                    Err(failure) => warnings.push(format!("{kind}: {}", asset_reason(failure))),
                }
            }
        }
        Ok((agents.into_values().collect(), assets, warnings))
    }

    fn asset_page(
        bytes: &[u8],
        kind: &str,
        id_key: &str,
        name_key: &str,
        rows: &mut BTreeMap<String, StudioAsset>,
    ) -> Result<Option<String>, Failure> {
        #[derive(Deserialize)]
        struct Page {
            value: Vec<serde_json::Value>,
            #[serde(rename = "@odata.nextLink")]
            next: Option<String>,
        }
        let page: Page = serde_json::from_slice(bytes).map_err(|_| Failure::Response)?;
        let mut ids = HashSet::new();
        for row in page.value {
            let id = guid(row[id_key].as_str().ok_or(Failure::Response)?)
                .map_err(|_| Failure::Response)?;
            let name = row[name_key]
                .as_str()
                .filter(|s| text(s, 1024))
                .ok_or(Failure::Response)?;
            if !ids.insert(id.clone()) {
                return Err(Failure::Response);
            }
            let asset = StudioAsset {
                id: id.clone(),
                kind: kind.into(),
                name: name.into(),
            };
            if let Some(existing) = rows.get(&id) {
                if existing != &asset {
                    return Err(Failure::Pagination);
                }
            } else {
                rows.insert(id, asset);
                if rows.len() > MAX_AGENTS {
                    return Err(Failure::Limit);
                }
            }
        }
        Ok(page.next)
    }

    fn pages(
        api: &mut Dataverse<'_>,
        config: &SourceConfig,
        query: Projection,
        mut append: impl FnMut(&[u8]) -> Result<Option<String>, Failure>,
    ) -> Result<(), Failure> {
        let mut url = Url::parse(&format!("{}{}", config.environment_url, query.path))
            .map_err(|_| Failure::Config)?;
        url.query_pairs_mut()
            .append_pair("$select", query.select)
            .append_pair("$orderby", query.id);
        if let Some(filter) = query.filter {
            url.query_pairs_mut().append_pair("$filter", filter);
        }
        let mut visited = HashSet::new();
        let mut cursors = HashSet::new();
        for _ in 0..MAX_PAGES {
            if !visited.insert(url.as_str().to_owned()) {
                return Err(Failure::Pagination);
            }
            for (_, cursor) in url.query_pairs().filter(|(key, _)| key == "$skiptoken") {
                if !cursors.insert(cursor.into_owned()) {
                    return Err(Failure::Pagination);
                }
            }
            match api.get(query.operation, url, |bytes| {
                append(bytes)?
                    .map(|next| projected_link(config, query, &next))
                    .transpose()
            })? {
                None => return Ok(()),
                Some(next) => url = next,
            }
        }
        Err(Failure::Limit)
    }

    #[cfg(test)]
    mod asset_tests {
        use super::*;

        fn approved() -> SourceConfig {
            let tenant = "11111111-1111-1111-1111-111111111111";
            SourceConfig {
                tenant_id: tenant.into(),
                environment_id: tenant.into(),
                environment_name: "test".into(),
                environment_url: "https://example.crm.dynamics.com".into(),
                subscription_id: tenant.into(),
                account: "test@example.com".into(),
                asset_inventory: true,
            }
        }

        #[test]
        fn diagnostics_capture_http_status_and_keep_last_accepted_page_without_network() {
            let mut rows = Observations::new();
            let mut assets = BTreeMap::new();
            let mut read_page = |status, body| {
                observed_get(
                    &mut rows,
                    Operation::CanvasApps,
                    || Ok((status, None, body)),
                    |bytes| {
                        asset_page(
                            bytes,
                            "canvas-app",
                            "canvasappid",
                            "displayname",
                            &mut assets,
                        )
                    },
                )
            };
            read_page(200, br#"{"value":[]}"#.as_slice()).unwrap();
            assert_eq!(read_page(200, b"not-json"), Err(Failure::Response));
            assert_eq!(
                read_page(403, b"private-error-body"),
                Err(Failure::Forbidden)
            );
            let history = &rows[&Operation::CanvasApps];
            assert_eq!(history.last_call.http_status, Some(403));
            assert_eq!(history.last_failure, Some(history.last_call));
            assert!(!history.last_call.succeeded);
            assert_eq!(history.last_success.unwrap().http_status, Some(200));
            assert!(history.last_success.unwrap().succeeded);
            let success = history.last_success;
            assert_eq!(
                observed_get::<(), &[u8]>(
                    &mut rows,
                    Operation::CanvasApps,
                    || Err(Failure::Network),
                    |_| unreachable!()
                ),
                Err(Failure::Network)
            );
            let history = &rows[&Operation::CanvasApps];
            assert_eq!(history.last_call.http_status, None);
            assert_eq!(history.last_success, success);
            let payload = serde_json::to_value(&rows).unwrap();
            assert_eq!(
                payload["canvas-apps"]["lastCall"]
                    .as_object()
                    .unwrap()
                    .len(),
                4
            );
            assert!(!payload.to_string().contains("private-error-body"));
        }

        #[test]
        fn diagnostics_migrate_v1_without_retiming_cached_errors_or_claiming_success() {
            let config = approved();
            let mut previous = refreshed(&config, None, Ok(Vec::new()), 100);
            previous.status.assets = Some(Vec::new());
            previous
                .status
                .asset_warnings
                .push("canvas-app: HTTP 403".into());
            let encoded = serde_json::to_vec(&Cache {
                schema_version: 1,
                sources: vec![previous],
            })
            .unwrap();
            let cache = decode_cache(&encoded).unwrap();
            assert_eq!(cache.schema_version, CACHE_SCHEMA);
            let migrated = matching_snapshot(&cache, &config, 9000).unwrap().unwrap();
            assert!(migrated.status.observations.is_empty());
            assert_eq!(migrated.status.last_synced_at, Some(100));
            assert_eq!(migrated.status.asset_warnings, ["canvas-app: HTTP 403"]);
            assert_eq!(migrated.status.state, "stale");
        }

        #[test]
        fn diagnostics_survive_refresh_failure_and_cache_roundtrip_in_the_same_scope() {
            let config = approved();
            let first = refresh_with(&config, None, 100, |rows| {
                observed_get(
                    rows,
                    Operation::Bots,
                    || Ok((200, None, br#"{"value":[]}"#.as_slice())),
                    |bytes| parse_page(bytes).map(|_| (Vec::new(), None, Vec::new())),
                )
            });
            let success = first.status.observations[&Operation::Bots]
                .last_success
                .unwrap();
            let failed = refresh_with(&config, Some(first), 110, |rows| {
                observed_get(
                    rows,
                    Operation::Bots,
                    || Ok((403, None, b"".as_slice())),
                    |_| unreachable!(),
                )
            });
            let bytes = serde_json::to_vec(&Cache {
                schema_version: CACHE_SCHEMA,
                sources: vec![failed],
            })
            .unwrap();
            let cached = matching_snapshot(&decode_cache(&bytes).unwrap(), &config, now())
                .unwrap()
                .unwrap();
            assert_eq!(cached.status.last_synced_at, Some(100));
            let history = &cached.status.observations[&Operation::Bots];
            assert_eq!(history.last_call.http_status, Some(403));
            assert_eq!(history.last_success, Some(success));
        }

        #[test]
        fn studio_asset_cursor_cannot_change_collection_projection_or_filter() {
            let source = approved();
            for (_, _, q) in ASSETS {
                let base = format!("{}{}?$skiptoken=cursor", source.environment_url, q.path);
                let url = projected_link(&source, q, &base).unwrap();
                assert!(url
                    .query_pairs()
                    .any(|(k, v)| k == "$select" && v == q.select));
                assert_eq!(
                    url.query_pairs()
                        .find(|(k, _)| k == "$filter")
                        .map(|(_, v)| v.into_owned()),
                    q.filter.map(String::from)
                );
                for bad in [
                    format!("{base}&$select=*"),
                    format!("{base}&$filter=true"),
                    base.replace(q.path, BOTS_PATH),
                    base.replace("example.", "other."),
                ] {
                    assert!(projected_link(&source, q, &bad).is_err());
                }
            }
        }

        #[test]
        fn studio_asset_cache_distinguishes_uncollected_empty_and_partial() {
            let source = approved();
            let mut s = refreshed(&source, None, Ok(Vec::new()), 100);
            assert!(serde_json::to_value(&s.status)
                .unwrap()
                .get("assets")
                .is_none());
            s.status.assets = Some(Vec::new());
            s.status.asset_warnings.push("canvas-app: HTTP 403".into());
            validate_snapshot(&s, 100).unwrap();
            let mut rows = BTreeMap::new();
            let input = br#"{"value":[{"workflowid":"11111111-1111-1111-1111-111111111111","name":"Example","ignored":"not persisted"}]}"#;
            asset_page(input, "workflow", "workflowid", "name", &mut rows).unwrap();
            s.status.assets = Some(rows.into_values().collect());
            validate_snapshot(&s, 100).unwrap();
            assert!(!serde_json::to_string(&s).unwrap().contains("not persisted"));
            s.status
                .asset_warnings
                .push("workflow: network failure".into());
            assert!(validate_snapshot(&s, 100).is_err());
            s.status.asset_warnings.pop();
            s.status.asset_warnings.push("untrusted detail".into());
            assert!(validate_snapshot(&s, 100).is_err());
            s.status.asset_warnings.clear();
            s.config.asset_inventory = false;
            assert!(validate_snapshot(&s, 100).is_err());
            let mut legacy = serde_json::to_value(source).unwrap();
            legacy.as_object_mut().unwrap().remove("assetInventory");
            let legacy: SourceConfig = serde_json::from_value(legacy).unwrap();
            assert!(!approved_assets(&legacy));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_open_budget_allows_slow_mcp_initialization_but_is_bounded() {
        assert_eq!(ACP_SESSION_OPEN_TIMEOUT, Duration::from_secs(300));
        assert!(ACP_SESSION_OPEN_TIMEOUT > ACP_SESSION_TIMEOUT);
        assert!(ACP_SESSION_OPEN_TIMEOUT < ACP_PROMPT_TIMEOUT);
    }

    #[test]
    fn runtime_timeout_runs_cleanup_before_returning_and_rejects_late_results() {
        let (sender, receiver) = mpsc::channel();
        let stopped = AtomicBool::new(false);
        let problem = Problem::plain("The owned runtime was stopped.");
        let result = wait_for_runtime_response(
            receiver,
            Duration::ZERO,
            || {
                stopped.store(true, Ordering::SeqCst);
                problem.clone()
            },
            || panic!("A live sender must not be reported as disconnected."),
        );
        assert_eq!(result, Err(problem));
        assert!(stopped.load(Ordering::SeqCst));
        assert!(sender
            .send(Ok(json!({"sessionId": "late-session"})))
            .is_err());
    }

    #[test]
    fn runtime_response_does_not_retire_a_healthy_connection() {
        let (sender, receiver) = mpsc::channel();
        let response = json!({"sessionId": "ready-session"});
        sender.send(Ok(response.clone())).unwrap();
        assert_eq!(
            wait_for_runtime_response(
                receiver,
                Duration::ZERO,
                || panic!("A ready response must not trigger timeout cleanup."),
                || panic!("A ready response must not be reported as disconnected."),
            ),
            Ok(response)
        );
    }

    #[test]
    fn runtime_refusal_preserves_the_actual_problem_without_timeout_cleanup() {
        let (sender, receiver) = mpsc::channel();
        let problem = Problem::with("Copilot refused this request.", "Protocol rejection");
        sender.send(Err(problem.clone())).unwrap();
        assert_eq!(
            wait_for_runtime_response(
                receiver,
                Duration::ZERO,
                || panic!("A protocol refusal must not trigger timeout cleanup."),
                || panic!("A protocol refusal must not be reported as disconnected."),
            ),
            Err(problem)
        );
    }

    #[test]
    fn runtime_disconnect_is_not_reported_as_a_timeout() {
        let (sender, receiver) = mpsc::channel();
        drop(sender);
        let problem = Problem::plain("The Copilot connection closed.");
        assert_eq!(
            wait_for_runtime_response(
                receiver,
                Duration::ZERO,
                || panic!("A disconnected channel must not trigger timeout cleanup."),
                || problem.clone(),
            ),
            Err(problem)
        );
    }

    #[test]
    fn failed_open_configuration_retires_before_exposing_retry() {
        let retired = AtomicBool::new(false);
        let problem = Problem::with(
            "The recorded agent could not be restored.",
            "ACP session/set_config_option exceeded 120 seconds.",
        );
        let result: Result<(), Problem> = finish_session_open(Err(problem), || {
            retired.store(true, Ordering::SeqCst);
        });
        let error = result.unwrap_err();
        assert!(retired.load(Ordering::SeqCst));
        assert!(error
            .said
            .contains("Saved history and the local draft were kept"));
        assert_eq!(
            error.detail.as_deref(),
            Some("ACP session/set_config_option exceeded 120 seconds.")
        );
    }

    #[test]
    fn malformed_open_response_retires_even_without_a_usable_session_id() {
        let retired = AtomicBool::new(false);
        let result = finish_session_open(
            parse_session(json!({"unexpected": true}), "C:\\workspace".into()),
            || retired.store(true, Ordering::SeqCst),
        );
        assert!(result.is_err());
        assert!(retired.load(Ordering::SeqCst));
    }

    #[test]
    fn completed_open_keeps_its_runtime_and_exact_session_identity() {
        let result = finish_session_open(
            parse_session(json!({"sessionId": "runtime-id"}), "C:\\workspace".into()),
            || panic!("A completed opening must not retire its connection."),
        )
        .unwrap();
        assert_eq!(result.session_id, "runtime-id");
    }

    #[test]
    fn initialization_maps_only_negotiated_capabilities() {
        let status = parse_status(&json!({
            "protocolVersion": 1,
            "agentCapabilities": {
                "loadSession": true,
                "mcpCapabilities": { "http": true, "sse": false },
                "promptCapabilities": { "image": true, "embeddedContext": true },
                "sessionCapabilities": {
                    "list": {},
                    "resume": {},
                    "close": {},
                    "delete": null
                }
            },
            "agentInfo": { "version": "1.2.3" },
            "authMethods": [{
                "id": "copilot-login",
                "name": "Log in",
                "_meta": { "terminal-auth": { "args": ["login"] } }
            }]
        }))
        .unwrap();

        assert_eq!(status.version, "1.2.3");
        assert!(status.capabilities.load_session);
        assert!(status.capabilities.resume_session);
        assert!(status.capabilities.list_sessions);
        assert!(status.capabilities.close_session);
        assert!(!status.capabilities.delete_session);
        assert!(!status.capabilities.prompt_image);
        assert!(!status.capabilities.prompt_embedded_context);
        assert!(status.capabilities.mcp_http);
        assert!(!status.capabilities.mcp_sse);
        assert_eq!(status.auth_methods[0].kind, "terminal");
    }

    #[test]
    fn unsupported_acp_version_is_explicit() {
        let problem = parse_status(&json!({
            "protocolVersion": 2,
            "agentCapabilities": {}
        }))
        .unwrap_err();
        assert!(problem.said.contains("not supported"));
        assert!(problem.detail.unwrap().contains("version 2"));
    }

    #[test]
    fn inventory_excludes_paths_endpoints_headers_and_environment_values() {
        let servers = parse_mcp_servers(json!({
            "mcpServers": {
                "example": {
                    "type": "http",
                    "url": "https://private.example/mcp",
                    "headers": { "Authorization": "******" },
                    "env": { "TOKEN": "secret" },
                    "source": "user",
                    "enabled": true,
                    "tools": ["one", "two"]
                }
            }
        }))
        .unwrap();

        assert_eq!(
            servers,
            vec![CopilotMcpServer {
                name: "example".into(),
                enabled: true,
                source: Some("user".into()),
                transport: Some("http".into()),
                tool_count: 2,
            }]
        );
        let serialized = serde_json::to_string(&servers).unwrap();
        for secret in ["private.example", "Authorization", "TOKEN", "secret"] {
            assert!(!serialized.contains(secret), "{serialized}");
        }
    }

    #[test]
    fn plugin_and_skill_summaries_keep_supported_metadata() {
        let plugins = parse_plugins(json!([{
            "name": "dataverse",
            "marketplace": "awesome-copilot",
            "version": "1.0.0",
            "enabled": true,
            "source": "installed"
        }]))
        .unwrap();
        assert_eq!(plugins[0].name, "dataverse");
        assert_eq!(plugins[0].marketplace.as_deref(), Some("awesome-copilot"));

        let skills = parse_skills(json!([{
            "name": "review",
            "description": "Review code",
            "enabled": false,
            "source": "personal-copilot",
            "path": "C:\\Users\\person\\.copilot\\skills\\review"
        }]))
        .unwrap();
        assert_eq!(skills[0].name, "review");
        assert_eq!(skills[0].source.as_deref(), Some("personal-copilot"));
        assert!(!serde_json::to_string(&skills)
            .unwrap()
            .contains("\\.copilot"));
    }

    #[test]
    fn auth_required_detection_accepts_protocol_and_human_forms() {
        assert!(authentication_required(&Problem::with(
            "GitHub Copilot refused the request.",
            r#"{"code":-32000,"message":"auth_required"}"#
        )));
        assert!(authentication_required(&Problem::plain(
            "Log in to GitHub Copilot first."
        )));
        assert!(authentication_required(&Problem::plain(
            "The authentication token expired."
        )));
        assert!(authentication_required(&Problem::with(
            "GitHub Copilot returned an HTTP status.",
            "401 Unauthorized"
        )));
        assert!(!authentication_required(&Problem::plain(
            "The session cursor was invalid."
        )));
    }

    #[test]
    fn initialization_advertises_only_the_callbacks_darbot_implements() {
        let capabilities = initialize_params(false)
            .get("clientCapabilities")
            .cloned()
            .unwrap();
        assert_eq!(capabilities, json!({}));
        assert!(capabilities.get("fs").is_none());
        assert!(capabilities.get("terminal").is_none());
        assert!(capabilities.get("elicitation").is_none());
        let connected = initialize_params(true);
        assert_eq!(
            connected["clientCapabilities"]["fs"],
            json!({"readTextFile": true, "writeTextFile": true})
        );
        assert_eq!(connected["clientCapabilities"]["terminal"], true);
    }

    fn terminal_wire_core(
        fixture: &terminals::test_fixture::Fixture,
    ) -> (
        Arc<RuntimeCore>,
        terminals::test_fixture::OwnedChild,
        std::process::ChildStdout,
    ) {
        let mut child = terminals::test_fixture::OwnedChild::new(
            quiet::command(&fixture.executable)
                .arg("wire")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let (outgoing, messages) = mpsc::sync_channel(64);
        let stdin = child.stdin.take().unwrap();
        let core = Arc::new(RuntimeCore {
            identity: format!("wire-{:032x}", rand::random::<u128>()),
            audit_root: Some(fixture.root.join("audit-app")),
            elicitation: Some(elicitation::Controller::with_hooks(
                Arc::new(|_, _| Ok(())),
                Arc::new(|_| Err("Test browser opening is forbidden".into())),
                Some(Arc::new(|pattern, input| {
                    let regex = regress::Regex::new(pattern).map_err(|error| error.to_string())?;
                    Ok(input.is_none_or(|value| regex.find(value).is_some()))
                })),
            )),
            tool_calls: Mutex::default(),
            elicitation_rpc: Mutex::default(),
            client_home: fixture.root.with_extension("unused-private-home"),
            consent: Arc::default(),
            terminals: Arc::default(),
            client_requests: Mutex::default(),
            report_cleanup: Arc::new(|_| {}),
            outgoing,
            pending: Mutex::default(),
            permissions: Mutex::default(),
            sessions: Mutex::new(HashMap::from([(
                "one".into(),
                SessionState {
                    cwd: fixture.root.to_string_lossy().into(),
                    config_options: json!([]),
                    modes: Value::Null,
                },
            )])),
            next_request_id: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            stderr: Mutex::default(),
        });
        start_runtime_writer(stdin, messages, Arc::downgrade(&core));
        core.terminals.activate("one").unwrap();
        let stdout = child.stdout.take().unwrap();
        (core, child, stdout)
    }

    fn terminal_wire(
        fixture: &terminals::test_fixture::Fixture,
    ) -> (
        Arc<RuntimeCore>,
        terminals::test_fixture::OwnedChild,
        Receiver<Value>,
    ) {
        let (core, child, stdout) = terminal_wire_core(fixture);
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    break;
                };
                let value = serde_json::from_str(&line).unwrap();
                if sender.send(value).is_err() {
                    break;
                }
            }
        });
        (core, child, receiver)
    }

    #[test]
    fn elicitation_wire_response_and_cancel_are_bound_to_live_native_scope() {
        let fixture = terminals::test_fixture::Fixture::new();
        let (core, mut child, replies) = terminal_wire(&fixture);
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let params = json!({"sessionId":"one","mode":"form","message":"Choose the review strategy.",
            "requestedSchema":{"type":"object","properties":{"choice":{"type":"string","enum":["safe","fast"]}},"required":["choice"]}});
        route_runtime_message(
            &core,
            app.handle(),
            json!({"jsonrpc":"2.0","id":"form","method":"elicitation/create","params":params}),
        );
        let controller = core.elicitation.as_ref().unwrap();
        let started = Instant::now();
        let local = loop {
            if let Some(local) = core
                .elicitation_rpc
                .lock()
                .unwrap()
                .get("\"form\"")
                .filter(|local| local.starts_with("el-"))
                .cloned()
            {
                break local;
            }
            assert!(started.elapsed() < Duration::from_secs(10));
            std::thread::sleep(Duration::from_millis(5));
        };
        let scope = core.elicitation_scope(&params).unwrap();
        assert!(controller
            .respond(
                &local,
                elicitation::Response {
                    action: elicitation::Action::Accept,
                    content: Some(json!({"choice":"invalid"}))
                },
                &scope
            )
            .is_err());
        controller
            .respond(
                &local,
                elicitation::Response {
                    action: elicitation::Action::Accept,
                    content: Some(json!({"choice":"safe"})),
                },
                &scope,
            )
            .unwrap();
        let response = replies.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(
            response["result"],
            json!({"action":"accept","content":{"choice":"safe"}})
        );
        route_runtime_message(
            &core,
            app.handle(),
            json!({"jsonrpc":"2.0","id":9,"method":"elicitation/create","params":params}),
        );
        route_runtime_message(
            &core,
            app.handle(),
            json!({"jsonrpc":"2.0","method":"$/cancel_request","params":{"requestId":9}}),
        );
        let cancelled = replies.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(cancelled["id"], 9);
        assert_eq!(cancelled["error"]["code"], -32800);
        route_runtime_message(
            &core,
            app.handle(),
            json!({"jsonrpc":"2.0","id":10,"method":"elicitation/create","params":{"sessionId":"foreign","mode":"url","url":"https://example.com","elicitationId":"other","message":"Open"}}),
        );
        assert_eq!(
            replies.recv_timeout(Duration::from_secs(10)).unwrap()["error"]["code"],
            -32602
        );
        fail_pending(&core, Problem::plain("Finished test"));
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn terminal_stdout_eof_and_malformed_protocol_dispose_owned_commands() {
        for malformed in [false, true] {
            let fixture = terminals::test_fixture::Fixture::new();
            let (core, mut child, stdout) = terminal_wire_core(&fixture);
            let app = tauri::test::mock_builder()
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            let request = fixture.request("sleep", 1024);
            let id = core
                .terminals
                .create(
                    core.terminals.reserve("one").unwrap(),
                    &request,
                    &fixture.root,
                    Arc::new(|_, _, _| Ok(())),
                )
                .unwrap();
            start_runtime_stdout(stdout, Arc::downgrade(&core), app.handle().clone());
            if malformed {
                core.write(&json!("not-json")).unwrap();
            } else {
                child.kill().unwrap();
                child.wait().unwrap();
            }
            let deadline = Instant::now() + Duration::from_secs(10);
            let handle: terminals::Handle = serde_json::from_value(json!({
                "sessionId":"one","terminalId":id
            }))
            .unwrap();
            while !core.closed.load(Ordering::SeqCst) || core.terminals.output(&handle).is_ok() {
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(core.terminals.reserve("one").is_err());
            core.terminals.cancel(None, true).unwrap();
            if malformed {
                child.kill().unwrap();
                child.wait().unwrap();
            }
        }
    }

    #[test]
    fn terminal_wire_dispatch_runs_all_five_methods_without_blocking_reader_and_publishes_final_output(
    ) {
        use tauri::Listener;
        let fixture = terminals::test_fixture::Fixture::new();
        let (core, mut child, replies) = terminal_wire(&fixture);
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let (opened, requests) = mpsc::channel();
        app.listen("copilot:permission-request", move |event| {
            opened
                .send(serde_json::from_str::<Value>(event.payload()).unwrap())
                .unwrap();
        });
        let events = Arc::new(Mutex::new(Vec::<Value>::new()));
        let output_events = Arc::clone(&events);
        app.listen("copilot:terminal-output", move |event| {
            output_events
                .lock()
                .unwrap()
                .push(serde_json::from_str(event.payload()).unwrap());
        });
        let send = |id: Value, method: &str, params: Value| {
            route_runtime_message(
                &core,
                app.handle(),
                json!({
                    "jsonrpc":"2.0", "id":id, "method":method, "params":params
                }),
            );
        };
        send(
            json!("create"),
            "terminal/create",
            json!({
                "sessionId":"one","command":fixture.executable,"args":["sleep"],"_meta":{}
            }),
        );
        let request = requests.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(request["toolCall"]["command"], json!(fixture.executable));
        assert_eq!(request["toolCall"]["args"], json!(["sleep"]));
        assert_eq!(request["toolCall"]["env"], json!([]));
        assert!(request["toolCall"]["warning"]
            .as_str()
            .unwrap()
            .contains("not a filesystem sandbox"));
        core.consent
            .respond(request["requestId"].as_str().unwrap(), Some("allow-once"))
            .unwrap();
        let created = replies.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(created["id"], "create");
        let handle = json!({"sessionId":"one","terminalId":created["result"]["terminalId"]});
        assert!(handle["terminalId"].is_string(), "{created}");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if events.lock().unwrap().iter().any(|event| {
                event["output"]
                    .as_str()
                    .is_some_and(|text| text.contains("ready"))
                    && event.get("exitStatus").is_none()
            }) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "output was not published before command exit"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        send(json!("wait"), "terminal/wait_for_exit", handle.clone());
        send(json!(12), "terminal/output", handle.clone());
        let output = replies.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(output["id"], 12);
        assert!(output["result"]["output"].is_string());
        send(json!("kill"), "terminal/kill", handle.clone());
        let first = replies.recv_timeout(Duration::from_secs(10)).unwrap();
        let second = replies.recv_timeout(Duration::from_secs(10)).unwrap();
        let responses = HashMap::from([
            (first["id"].as_str().unwrap().to_string(), first),
            (second["id"].as_str().unwrap().to_string(), second),
        ]);
        assert_eq!(responses["kill"]["result"], json!({}));
        #[cfg(windows)]
        assert_eq!(responses["wait"]["result"]["exitCode"], 1);
        #[cfg(unix)]
        assert_eq!(responses["wait"]["result"]["signal"], "SIGKILL");
        send(json!("release"), "terminal/release", handle.clone());
        assert_eq!(
            replies.recv_timeout(Duration::from_secs(10)).unwrap()["result"],
            json!({})
        );
        send(json!("after-release"), "terminal/output", handle.clone());
        assert!(replies
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .get("error")
            .is_some());
        send(json!("release-again"), "terminal/release", handle);
        assert!(replies
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .get("error")
            .is_some());
        let events = events.lock().unwrap();
        assert!(events.len() >= 2);
        assert_eq!(events[0]["output"], "");
        assert_eq!(events[0]["sessionId"], "one");
        assert_eq!(
            events.last().unwrap()["terminalId"],
            created["result"]["terminalId"]
        );
        assert!(events.last().unwrap().get("exitStatus").is_some());
        drop(events);
        core.terminals.cancel(None, true).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn terminal_wire_validation_rejection_and_cancelled_approval_never_start_commands() {
        use tauri::Listener;
        let fixture = terminals::test_fixture::Fixture::new();
        let (core, mut child, replies) = terminal_wire(&fixture);
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let (opened, requests) = mpsc::channel();
        app.listen("copilot:permission-request", move |event| {
            opened
                .send(serde_json::from_str::<Value>(event.payload()).unwrap())
                .unwrap();
        });
        let send = |id: i64, method: &str, params: Value| {
            route_runtime_message(
                &core,
                app.handle(),
                json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
            );
        };
        for (index, params) in [
            json!(null),
            json!({"sessionId":"unknown","command":"unused"}),
            json!({"sessionId":"one","command":"unused","outputByteLimit":-1}),
            json!({"sessionId":"one","command":"unused","extra":true}),
        ]
        .into_iter()
        .enumerate()
        {
            send(index as i64, "terminal/create", params);
            assert_eq!(
                replies.recv_timeout(Duration::from_secs(2)).unwrap()["error"]["code"],
                -32602
            );
        }
        for (id, cancel) in [(10, false), (11, true)] {
            send(
                id,
                "terminal/create",
                json!({
                    "sessionId":"one","command":fixture.executable,"args":["sleep"]
                }),
            );
            let request = requests.recv_timeout(Duration::from_secs(10)).unwrap();
            if cancel {
                core.terminals.cancel(Some("one"), false).unwrap();
                core.cancel_permissions("one").unwrap();
            } else {
                core.consent
                    .respond(request["requestId"].as_str().unwrap(), Some("reject-once"))
                    .unwrap();
            }
            let response = replies.recv_timeout(Duration::from_secs(10)).unwrap();
            assert_eq!(response["id"], id);
            assert!(response.get("result").is_none());
            assert_eq!(response["error"]["code"], -32000);
        }
        assert!(requests.try_recv().is_err());
        core.terminals.cancel(None, true).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn permission_wire_replies_to_malformed_unknown_and_duplicate_requests_without_overwriting() {
        use tauri::Listener;
        let fixture = terminals::test_fixture::Fixture::new();
        let (core, mut child, replies) = terminal_wire(&fixture);
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let (opened, requests) = mpsc::channel();
        app.listen("copilot:permission-request", move |event| {
            opened
                .send(serde_json::from_str::<Value>(event.payload()).unwrap())
                .unwrap();
        });
        let send = |id: &str, params: Value| {
            route_runtime_message(
                &core,
                app.handle(),
                json!({
                    "jsonrpc":"2.0","id":id,"method":"session/request_permission","params":params
                }),
            );
        };
        send("missing", json!(null));
        assert_eq!(
            replies.recv_timeout(Duration::from_secs(2)).unwrap()["error"]["code"],
            -32602
        );
        let mut params = json!({
            "sessionId":"unknown","toolCall":{"toolCallId":"test"},
            "options":[{"optionId":"allow","name":"Allow","kind":"allow_once"}]
        });
        send("unknown", params.clone());
        assert_eq!(
            replies.recv_timeout(Duration::from_secs(2)).unwrap()["error"]["code"],
            -32602
        );
        params["sessionId"] = json!("one");
        send("valid", params.clone());
        let request = requests.recv_timeout(Duration::from_secs(2)).unwrap();
        send("valid", params);
        assert_eq!(
            replies.recv_timeout(Duration::from_secs(2)).unwrap()["error"]["code"],
            -32600
        );
        assert_eq!(core.permissions.lock().unwrap().len(), 1);
        core.respond_permission(
            request["requestId"].as_str().unwrap().into(),
            Some("allow".into()),
        )
        .unwrap();
        assert_eq!(
            replies.recv_timeout(Duration::from_secs(2)).unwrap()["result"]["outcome"]["optionId"],
            "allow"
        );
        assert!(requests.try_recv().is_err());
        core.terminals.cancel(None, true).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn file_wire_read_write_and_cancel_return_actual_rpc_responses() {
        use tauri::Listener;
        let fixture = terminals::test_fixture::Fixture::new();
        let (core, mut child, replies) = terminal_wire(&fixture);
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let (opened, requests) = mpsc::channel();
        app.listen("copilot:permission-request", move |event| {
            opened
                .send(serde_json::from_str::<Value>(event.payload()).unwrap())
                .unwrap();
        });
        let path = fixture.root.join("approved.txt");
        let send = |id: i64, method: &str, params: Value| {
            route_runtime_message(
                &core,
                app.handle(),
                json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
            );
        };
        send(
            1,
            "fs/write_text_file",
            json!({"sessionId":"one","path":path,"content":"first\n😀\n"}),
        );
        let request = requests.recv_timeout(Duration::from_secs(10)).unwrap();
        core.consent
            .respond(request["requestId"].as_str().unwrap(), Some("allow-once"))
            .unwrap();
        assert_eq!(
            replies.recv_timeout(Duration::from_secs(10)).unwrap()["result"],
            json!({})
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "first\n😀\n");
        send(
            2,
            "fs/read_text_file",
            json!({"sessionId":"one","path":path}),
        );
        let request = requests.recv_timeout(Duration::from_secs(10)).unwrap();
        core.consent
            .respond(request["requestId"].as_str().unwrap(), Some("allow-once"))
            .unwrap();
        assert_eq!(
            replies.recv_timeout(Duration::from_secs(10)).unwrap()["result"]["content"],
            "first\n😀\n"
        );
        send(
            3,
            "fs/write_text_file",
            json!({"sessionId":"one","path":path,"content":"cancelled"}),
        );
        let request = requests.recv_timeout(Duration::from_secs(10)).unwrap();
        core.terminals.cancel(Some("one"), false).unwrap();
        core.cancel_permissions("one").unwrap();
        assert!(core
            .consent
            .respond(request["requestId"].as_str().unwrap(), Some("allow-once"))
            .is_err());
        assert!(replies
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .get("error")
            .is_some());
        assert_eq!(fs::read_to_string(&path).unwrap(), "first\n😀\n");
        for (id, method, params) in [
            (
                4,
                "fs/read_text_file",
                json!({"sessionId":"unknown","path":path}),
            ),
            (
                5,
                "fs/write_text_file",
                json!({"sessionId":"one","path":path}),
            ),
        ] {
            send(id, method, params);
            assert!(replies
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .get("error")
                .is_some());
        }
        assert!(requests.try_recv().is_err());
        core.terminals.cancel(None, true).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn rpc_envelopes_capabilities_and_legacy_modes_are_validated() {
        let fixture = terminals::test_fixture::Fixture::new();
        let (core, mut child, replies) = terminal_wire(&fixture);
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        for message in [
            json!({"jsonrpc":"1.0","id":1,"method":"terminal/create"}),
            json!({"jsonrpc":"2.0","id":true,"method":"terminal/create"}),
            json!({"jsonrpc":"2.0","id":2,"method":1}),
            json!({"jsonrpc":"2.0","id":3,"method":"terminal/create","result":{}}),
            json!({"jsonrpc":"2.0","id":4}),
        ] {
            route_runtime_message(&core, app.handle(), message);
            assert_eq!(
                replies.recv_timeout(Duration::from_secs(2)).unwrap()["error"]["code"],
                -32600
            );
        }
        assert!(!capability_present(
            Some(&json!({"delete":false})),
            "delete"
        ));
        assert!(!capability_present(Some(&json!({"delete":true})), "delete"));
        assert!(capability_present(Some(&json!({"delete":{}})), "delete"));
        let modes = json!({"currentModeId":"agent","availableModes":[
            {"id":"agent"},{"id":"plan"},{"id":"autopilot"},
            {"id":"https://agentclientprotocol.com/protocol/session-modes#autopilot"}
        ]});
        assert!(validate_mode(&modes, "plan").is_ok());
        assert!(validate_mode(&modes, "unknown").is_err());
        assert!(validate_mode(&modes, "autopilot").is_err());
        assert!(validate_mode(
            &modes,
            "https://agentclientprotocol.com/protocol/session-modes#autopilot"
        )
        .is_err());
        core.sessions.lock().unwrap().get_mut("one").unwrap().modes = modes;
        route_runtime_message(
            &core,
            app.handle(),
            json!({
                "jsonrpc":"2.0","method":"session/update","params":{
                    "sessionId":"one","update":{"sessionUpdate":"current_mode_update","currentModeId":"plan"}
                }
            }),
        );
        assert_eq!(
            core.sessions.lock().unwrap()["one"].modes["currentModeId"],
            "plan"
        );
        core.terminals.cancel(None, true).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn blocked_protocol_pipe_does_not_block_response_dispatch() {
        let fixture = terminals::test_fixture::Fixture::new();
        let (core, mut child, _unread_stdout) = terminal_wire_core(&fixture);
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        for _ in 0..3 {
            core.write(&json!({"payload": "x".repeat(1024 * 1024)}))
                .unwrap();
        }
        let (sender, received) = mpsc::channel();
        core.pending.lock().unwrap().insert("99".into(), sender);
        route_runtime_message(
            &core,
            app.handle(),
            json!({"jsonrpc":"2.0","id":99,"result":{"alive":true}}),
        );
        assert_eq!(
            received
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap()["alive"],
            true
        );
        fail_pending(&core, Problem::plain("Fixture stopped."));
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn status_probe_explicitly_answers_callbacks_without_granting_authority() {
        let fixture = terminals::test_fixture::Fixture::new();
        let mut child = terminals::test_fixture::OwnedChild::new(
            quiet::command(&fixture.executable)
                .arg("probe")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, received) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if sender
                    .send(line.map_err(|error| error.to_string()))
                    .is_err()
                {
                    break;
                }
            }
        });
        let (_, stderr) = mpsc::channel();
        let mut probe = AcpConnection {
            child: child.into_inner(),
            stdin,
            stdout: received,
            stderr,
        };
        assert_eq!(
            probe
                .request(42, "initialize", initialize_params(false))
                .unwrap(),
            json!({"answered":true})
        );
        drop(probe);
        reader.join().unwrap();
    }

    #[test]
    fn shared_cli_builder_preserves_exact_portable_plugin_arguments() {
        if crate::test_support::isolated_process(
            "copilot::tests::shared_cli_builder_preserves_exact_portable_plugin_arguments",
        ) {
            return;
        }
        let fixture = terminals::test_fixture::Fixture::new();
        let first = fixture.root.join("first plugin");
        let second = fixture.root.join("second-plugin");
        for root in [&first, &second] {
            fs::create_dir(root).unwrap();
            fs::write(root.join("plugin.json"), r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"fixture","version":"1.0.0"}"#).unwrap();
        }
        std::env::set_var(
            "DARBOT_AGENT_PLUGIN_DIRS",
            std::env::join_paths([&first, &second]).unwrap(),
        );
        let mut command = copilot_command().unwrap();
        command.args(["--acp", "--stdio", "--no-auto-update"]);
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![
                "--plugin-dir".to_string(),
                first.canonicalize().unwrap().to_string_lossy().into_owned(),
                "--plugin-dir".to_string(),
                second
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                "--acp".into(),
                "--stdio".into(),
                "--no-auto-update".into(),
            ]
        );
        std::env::set_var("DARBOT_AGENT_PLUGIN_DIRS", fixture.root.join("missing"));
        assert!(copilot_command().is_err());
    }

    #[test]
    fn native_delete_and_set_mode_send_exact_methods_and_retire_local_authority() {
        let fixture = terminals::test_fixture::Fixture::new();
        let (core, child, replies) = terminal_wire(&fixture);
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        core.sessions.lock().unwrap().get_mut("one").unwrap().modes =
            json!({"currentModeId":"agent","availableModes":[{"id":"agent"},{"id":"plan"}]});
        let capabilities = parse_status(&json!({
            "protocolVersion":1,"agentCapabilities":{"sessionCapabilities":{"delete":{}}}
        }))
        .unwrap()
        .capabilities;
        let runtime = Arc::new(CopilotRuntime {
            child: Mutex::new(child.into_inner()),
            opening: Mutex::new(()),
            core: Arc::clone(&core),
            capabilities,
        });
        let state = Arc::new(CopilotRuntimeState::default());
        *state.runtime.lock().unwrap() = Some(Arc::clone(&runtime));
        let changing = Arc::clone(&state);
        let change = std::thread::spawn(move || changing.set_mode("one".into(), "plan".into()));
        let request = replies.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(request["method"], "session/set_mode");
        assert_eq!(
            request["params"],
            json!({"sessionId":"one","modeId":"plan"})
        );
        route_runtime_message(
            &core,
            app.handle(),
            json!({"jsonrpc":"2.0","id":request["id"],"result":{}}),
        );
        assert_eq!(change.join().unwrap().unwrap()["currentModeId"], "plan");
        let deleting = Arc::clone(&state);
        let delete = std::thread::spawn(move || deleting.delete_session("one".into()));
        let request = replies.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(request["method"], "session/delete");
        assert_eq!(request["params"], json!({"sessionId":"one"}));
        assert!(core.terminals.generation("one").is_none());
        assert!(!core.sessions.lock().unwrap().contains_key("one"));
        route_runtime_message(
            &core,
            app.handle(),
            json!({"jsonrpc":"2.0","id":request["id"],"result":{}}),
        );
        delete.join().unwrap().unwrap();
        state.shutdown();
    }

    #[test]
    fn permission_response_accepts_only_advertised_options() {
        let options = vec![CopilotPermissionOption {
            option_id: "allow-once".into(),
            name: "Allow once".into(),
            kind: "allow_once".into(),
        }];
        assert_eq!(
            permission_result(&options, Some("allow-once".into())).unwrap(),
            json!({"outcome": {"outcome": "selected", "optionId": "allow-once"}})
        );
        assert_eq!(
            permission_result(&options, None).unwrap(),
            json!({"outcome": {"outcome": "cancelled"}})
        );
        assert!(permission_result(&options, Some("allow-always".into())).is_err());
    }

    #[test]
    fn session_setup_keeps_only_supported_initial_state() {
        let session = parse_session(
            json!({
                "sessionId": "session-1",
                "modes": {"currentModeId": "agent"},
                "configOptions": [{"id": "model", "type": "select"}],
                "private": {"token": "not-returned"}
            }),
            String::from("working-folder"),
        )
        .unwrap();
        assert_eq!(session.session_id, "session-1");
        assert_eq!(session.modes, Some(json!({"currentModeId": "agent"})));
        assert_eq!(
            session.config_options,
            Some(json!([{"id": "model", "type": "select"}]))
        );
        assert!(!serde_json::to_string(&session)
            .unwrap()
            .contains("not-returned"));
    }

    fn studio_config_value() -> Value {
        json!({
            "schemaVersion": 1,
            "sources": [{
                "tenantId": "11111111-1111-4111-8111-111111111111",
                "environmentId": "22222222-2222-4222-8222-222222222222",
                "environmentName": "Test environment",
                "environmentUrl": "https://example.crm.dynamics.com",
                "subscriptionId": "33333333-3333-4333-8333-333333333333",
                "account": "person@example.com"
            }]
        })
    }

    fn studio_source() -> studio_catalog::SourceConfig {
        studio_catalog::parse_config(&serde_json::to_vec(&studio_config_value()).unwrap())
            .unwrap()
            .sources
            .remove(0)
    }

    fn studio_bot() -> Value {
        json!({
            "botid": "abcdefab-4444-4444-8444-444444444444",
            "name": "Test agent",
            "schemaname": "test_agent",
            "modifiedon": "2026-11-17T17:10:35Z",
            "statecode": 0
        })
    }

    fn studio_rows() -> Vec<CopilotAgent> {
        let page = studio_catalog::parse_page(
            &serde_json::to_vec(&json!({"value": [studio_bot()]})).unwrap(),
        )
        .unwrap();
        let mut rows = BTreeMap::new();
        studio_catalog::append_page(page, &studio_source(), 10_000, &mut rows).unwrap();
        rows.into_values().collect()
    }

    fn studio_snapshot() -> studio_catalog::Snapshot {
        studio_catalog::refreshed(&studio_source(), None, Ok(studio_rows()), 10_000)
    }

    #[test]
    fn studio_config_is_strict_and_normalizes_identity() {
        let mut value = studio_config_value();
        value["sources"][0]["tenantId"] = json!("ABCDEFAB-1111-4111-8111-111111111111");
        value["sources"][0]["account"] = json!("Person@Example.COM");
        value["sources"][0]["environmentUrl"] = json!("https://Example.crm.dynamics.com:443/");
        let source = studio_catalog::parse_config(&serde_json::to_vec(&value).unwrap())
            .unwrap()
            .sources
            .remove(0);
        assert_eq!(source.tenant_id, "abcdefab-1111-4111-8111-111111111111");
        assert_eq!(source.account, "person@example.com");
        assert_eq!(source.environment_url, "https://example.crm.dynamics.com");
        for key in ["schemaVersion", "sources"] {
            let mut value = studio_config_value();
            value.as_object_mut().unwrap().remove(key);
            assert!(studio_catalog::parse_config(&serde_json::to_vec(&value).unwrap()).is_err());
        }
        for key in [
            "tenantId",
            "environmentId",
            "environmentName",
            "environmentUrl",
            "subscriptionId",
            "account",
        ] {
            let mut value = studio_config_value();
            value["sources"][0].as_object_mut().unwrap().remove(key);
            assert!(
                studio_catalog::parse_config(&serde_json::to_vec(&value).unwrap()).is_err(),
                "{key}"
            );
        }
        let mut value = studio_config_value();
        value["accessToken"] = json!("not-allowed");
        assert!(studio_catalog::parse_config(&serde_json::to_vec(&value).unwrap()).is_err());
        let mut value = studio_config_value();
        value["sources"][0]["accessToken"] = json!("not-allowed");
        assert!(studio_catalog::parse_config(&serde_json::to_vec(&value).unwrap()).is_err());
        let mut value = studio_config_value();
        value["schemaVersion"] = json!(2);
        assert!(studio_catalog::parse_config(&serde_json::to_vec(&value).unwrap()).is_err());
        assert!(studio_catalog::parse_config(&vec![b' '; 128 * 1024 + 1]).is_err());
    }

    #[test]
    fn studio_config_rejects_urls_accounts_and_duplicate_sources() {
        for url in [
            "http://example.crm.dynamics.com",
            "https://example.crm.dynamics.com:444",
            "https://example.crm.dynamics.com/api",
            "https://example.crm.dynamics.com/?q=1",
            "https://example.crm.dynamics.com/#fragment",
            "https://person@example.crm.dynamics.com",
            "https://@example.crm.dynamics.com",
            "https://example.crm.dynamics.com.evil.test",
            "https://example.crm.dynamics.com.",
            "https://example..crm.dynamics.com",
            "https://-example.crm.dynamics.com",
            "https://example-.crm.dynamics.com",
            "https://127.0.0.1",
            "https://example.crm.dynamics.com\\",
            "https://example.crm.dynamics.com/a/../",
            "https://example.crm.dynamics.com/%2e",
            " https://example.crm.dynamics.com",
            "https://example.crm.dynamics.com\n",
            "https://ex%61mple.crm.dynamics.com",
            "https://例.crm.dynamics.com",
        ] {
            let mut value = studio_config_value();
            value["sources"][0]["environmentUrl"] = json!(url);
            assert!(
                studio_catalog::parse_config(&serde_json::to_vec(&value).unwrap()).is_err(),
                "{url:?}"
            );
        }
        for account in [
            "",
            "person@example.com\n",
            " person@example.com",
            "$(whoami)",
            "x&whoami",
            "x;whoami",
            "x\"y",
            "x`y",
            "x\0y",
        ] {
            let mut value = studio_config_value();
            value["sources"][0]["account"] = json!(account);
            assert!(
                studio_catalog::parse_config(&serde_json::to_vec(&value).unwrap()).is_err(),
                "{account:?}"
            );
        }
        for key in ["tenantId", "environmentId", "subscriptionId"] {
            let mut value = studio_config_value();
            value["sources"][0][key] = json!("--tenant injected");
            assert!(studio_catalog::parse_config(&serde_json::to_vec(&value).unwrap()).is_err());
        }
        for name in ["".to_string(), "a\nb".to_string(), "a".repeat(257)] {
            let mut value = studio_config_value();
            value["sources"][0]["environmentName"] = json!(name);
            assert!(studio_catalog::parse_config(&serde_json::to_vec(&value).unwrap()).is_err());
        }
        for same_identity in [true, false] {
            let mut value = studio_config_value();
            let mut duplicate = value["sources"][0].clone();
            if same_identity {
                duplicate["environmentUrl"] = json!("https://other.crm.dynamics.com");
            } else {
                duplicate["environmentId"] = json!("55555555-5555-4555-8555-555555555555");
            }
            value["sources"].as_array_mut().unwrap().push(duplicate);
            assert!(studio_catalog::parse_config(&serde_json::to_vec(&value).unwrap()).is_err());
        }
    }

    #[test]
    fn studio_scoped_ids_distinguish_tenants_and_environments() {
        let mut source = studio_source();
        let bot = "ABCDEFAB-4444-4444-8444-444444444444";
        let first = studio_catalog::scoped_id(&source, bot);
        source.tenant_id = "55555555-5555-4555-8555-555555555555".into();
        let second = studio_catalog::scoped_id(&source, bot);
        source.environment_id = "66666666-6666-4666-8666-666666666666".into();
        assert_ne!(first, second);
        assert_ne!(second, studio_catalog::scoped_id(&source, bot));
        assert_eq!(first, first.to_ascii_lowercase());
        assert!(first.ends_with(":abcdefab-4444-4444-8444-444444444444"));
    }

    #[test]
    fn studio_token_is_subscription_scoped_and_account_checked_without_fallback() {
        let source = studio_source();
        let mut command = quiet::command("unused-test-program");
        studio_catalog::token_args(&mut command, &source);
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert_eq!(
            args,
            vec![
                "account",
                "get-access-token",
                "--subscription",
                &source.subscription_id,
                "--resource",
                &source.environment_url,
                "--output",
                "json",
                "--only-show-errors",
            ]
        );
        assert!(!args.iter().any(|arg| arg == "--tenant" || arg == "login"));
        let bytes = serde_json::to_vec(&json!({
            "tenant": source.tenant_id, "accessToken": "synthetic-token-for-test"
        }))
        .unwrap();
        assert!(studio_catalog::parse_token(&bytes, &source).is_ok());
        let mut other = source.clone();
        other.tenant_id = "77777777-7777-4777-8777-777777777777".into();
        assert_eq!(
            studio_catalog::parse_token(&bytes, &other),
            Err(studio_catalog::Failure::Tenant)
        );
        assert!(studio_catalog::parse_token(br#"{"accessToken":"secret"}"#, &source).is_err());
        let bytes = serde_json::to_vec(
            &json!({"tenant": source.tenant_id, "accessToken": "injected\r\nheader-value"}),
        )
        .unwrap();
        assert_eq!(
            studio_catalog::parse_token(&bytes, &source),
            Err(studio_catalog::Failure::Token)
        );
        assert!(
            studio_catalog::verify_account(br#"{"domainname":"PERSON@EXAMPLE.COM"}"#, &source)
                .is_ok()
        );
        assert_eq!(
            studio_catalog::verify_account(br#"{"domainname":"guest@example.com"}"#, &source),
            Err(studio_catalog::Failure::Account)
        );
        assert!(studio_catalog::verify_account(br#"{"domainname":null}"#, &source).is_err());
    }

    #[test]
    fn studio_pagination_rejects_cross_origin_and_non_metadata_queries() {
        let source = studio_source();
        let good = "https://example.crm.dynamics.com/api/data/v9.2/bots?$skiptoken=cursor";
        let url = studio_catalog::next_link(&source, good).unwrap();
        assert!(url.query_pairs().any(|(key, value)| key == "$select"
            && value == "botid,name,schemaname,modifiedon,statecode,description"));
        assert!(url
            .query_pairs()
            .any(|(key, value)| key == "$orderby" && value == "botid"));
        for bad in [
            "https://evil.test/api/data/v9.2/bots?$skiptoken=x",
            "http://example.crm.dynamics.com/api/data/v9.2/bots?$skiptoken=x",
            "https://example.crm.dynamics.com:444/api/data/v9.2/bots?$skiptoken=x",
            "https://user@example.crm.dynamics.com/api/data/v9.2/bots?$skiptoken=x",
            "https://@example.crm.dynamics.com/api/data/v9.2/bots?$skiptoken=x",
            "https://example.crm.dynamics.com/api/data/v9.2/systemusers?$skiptoken=x",
            "https://example.crm.dynamics.com/api/data/v9.2/bots/?$skiptoken=x",
            "https://example.crm.dynamics.com/api/data/v9.2/other/../bots?$skiptoken=x",
            "https://example.crm.dynamics.com/api/data/v9.2/%62ots?$skiptoken=x",
            "https://example.crm.dynamics.com/api/data/v9.2/bots?$skiptoken=x#secret",
            "https://example.crm.dynamics.com/api/data/v9.2/bots?$select=description&$skiptoken=x",
            "https://example.crm.dynamics.com/api/data/v9.2/bots?$expand=topics&$skiptoken=x",
            "https://example.crm.dynamics.com/api/data/v9.2/bots?$top=1&$skiptoken=x",
            "https://example.crm.dynamics.com/api/data/v9.2/bots?$skiptoken=x&$skiptoken=y",
            "https://example.crm.dynamics.com/api/data/v9.2/bots?$skiptoken=",
            "https://example.crm.dynamics.com/api/data/v9.2/bots",
            "/api/data/v9.2/bots?$skiptoken=x",
        ] {
            assert!(studio_catalog::next_link(&source, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn studio_purpose_is_optional_bounded_display_prose_in_rows_and_cache() {
        for value in [
            None,
            Some("Reviews support requests."),
            Some("Authorization: Bearer private"),
            Some("https://example.test/?sig=private"),
            Some("<markup>"),
        ] {
            let mut bot = studio_bot();
            if let Some(value) = value {
                bot["description"] = json!(value);
            }
            bot["instructions"] = json!("NEVER COPY");
            let page =
                studio_catalog::parse_page(&serde_json::to_vec(&json!({"value": [bot]})).unwrap())
                    .unwrap();
            let mut rows = BTreeMap::new();
            studio_catalog::append_page(page, &studio_source(), 10_000, &mut rows).unwrap();
            let row = rows.into_values().next().unwrap();
            assert_eq!(
                row.source.as_ref().unwrap().declared_description.as_deref(),
                value.filter(|v| *v == "Reviews support requests.")
            );
            assert!(!serde_json::to_string(&row).unwrap().contains("NEVER COPY"));
            let mut snap = studio_snapshot();
            snap.agents = vec![row];
            studio_catalog::validate_snapshot(&snap, 10_100).unwrap();
            snap.agents[0].source.as_mut().unwrap().declared_description =
                Some("password: hidden".into());
            assert!(studio_catalog::validate_snapshot(&snap, 10_100).is_err());
        }
    }

    #[test]
    fn studio_dataverse_rows_are_allowlisted_and_duplicates_are_not_silent() {
        let source = studio_source();
        let mut bot = studio_bot();
        bot["description"] = json!("Bearer private-description");
        bot["topics"] = json!(["private-topic"]);
        let mut rows = BTreeMap::new();
        let page = studio_catalog::parse_page(
            &serde_json::to_vec(&json!({
                "@odata.context": "unused-context",
                "value": [bot], "@odata.nextLink": null
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(
            studio_catalog::append_page(page, &source, 10_000, &mut rows)
                .unwrap()
                .is_none()
        );
        let serialized = serde_json::to_string(&rows).unwrap();
        assert!(!serialized.contains("private-description"));
        assert!(!serialized.contains("private-topic"));
        assert_eq!(
            rows.values().next().unwrap().description,
            "Copilot Studio · Test environment"
        );
        assert!(rows.values().next().unwrap().model.is_none());
        let page = studio_catalog::parse_page(
            &serde_json::to_vec(&json!({"value": [studio_bot()]})).unwrap(),
        )
        .unwrap();
        studio_catalog::append_page(page, &source, 10_000, &mut rows).unwrap();
        assert_eq!(rows.len(), 1);
        let mut changed = studio_bot();
        changed["name"] = json!("Changed mid-traversal");
        let page =
            studio_catalog::parse_page(&serde_json::to_vec(&json!({"value": [changed]})).unwrap())
                .unwrap();
        assert_eq!(
            studio_catalog::append_page(page, &source, 10_000, &mut rows),
            Err(studio_catalog::Failure::Pagination)
        );
        let page = studio_catalog::parse_page(
            &serde_json::to_vec(&json!({"value": [studio_bot(), studio_bot()]})).unwrap(),
        )
        .unwrap();
        assert_eq!(
            studio_catalog::append_page(page, &source, 10_000, &mut BTreeMap::new()),
            Err(studio_catalog::Failure::Response)
        );
    }

    #[test]
    fn studio_dataverse_rejects_malformed_required_fields() {
        for body in [
            r#"{}"#,
            r#"{"value":null}"#,
            r#"{"value":[{}]}"#,
            r#"{"value":[],"value":[]}"#,
            r#"{"value":[],"@odata.nextLink":42}"#,
        ] {
            assert!(studio_catalog::parse_page(body.as_bytes()).is_err());
        }
        for (key, value) in [
            ("botid", json!("not-a-guid")),
            ("name", json!("")),
            ("name", json!("bad\nname")),
            ("schemaname", json!("")),
            ("modifiedon", json!("not-a-date")),
            ("modifiedon", json!("2026-13-17T17:10:35Z")),
            ("statecode", json!(5)),
            ("statecode", json!("0")),
        ] {
            let mut bot = studio_bot();
            bot[key] = value;
            let result =
                studio_catalog::parse_page(&serde_json::to_vec(&json!({"value": [bot]})).unwrap())
                    .and_then(|page| {
                        studio_catalog::append_page(
                            page,
                            &studio_source(),
                            10_000,
                            &mut BTreeMap::new(),
                        )
                    });
            assert!(result.is_err(), "{key}");
        }
        for key in ["botid", "name", "schemaname", "modifiedon", "statecode"] {
            let mut bot = studio_bot();
            bot.as_object_mut().unwrap().remove(key);
            assert!(studio_catalog::parse_page(
                &serde_json::to_vec(&json!({"value": [bot]})).unwrap()
            )
            .is_err());
        }
    }

    #[test]
    fn studio_cache_invalidates_changed_config_and_rejects_scope_spoofing() {
        let cache = studio_catalog::Cache {
            schema_version: 1,
            sources: vec![studio_snapshot()],
        };
        assert!(
            studio_catalog::matching_snapshot(&cache, &studio_source(), 10_100)
                .unwrap()
                .is_some()
        );
        for field in [
            "account",
            "subscriptionId",
            "environmentId",
            "tenantId",
            "environmentUrl",
            "environmentName",
        ] {
            let mut value = serde_json::to_value(studio_source()).unwrap();
            value[field] = match field {
                "account" => json!("other@example.com"),
                "environmentName" => json!("Other environment"),
                "environmentUrl" => json!("https://other.crm.dynamics.com"),
                _ => json!("88888888-8888-4888-8888-888888888888"),
            };
            let changed = serde_json::from_value(value).unwrap();
            assert!(
                studio_catalog::matching_snapshot(&cache, &changed, 10_100)
                    .unwrap()
                    .is_none(),
                "{field}"
            );
        }
        for field in [
            "provider",
            "tenantId",
            "environmentId",
            "environmentUrl",
            "botId",
            "lastSyncedAt",
        ] {
            let mut value = serde_json::to_value(studio_snapshot()).unwrap();
            value["agents"][0]["source"][field] = if field == "lastSyncedAt" {
                json!(10_001)
            } else {
                json!("spoofed")
            };
            if let Ok(invalid) = serde_json::from_value(value) {
                assert!(
                    studio_catalog::validate_snapshot(&invalid, 10_100).is_err(),
                    "{field}"
                );
            }
        }
        let mut bad = studio_snapshot();
        bad.agents[0].id = "local-agent".into();
        assert!(studio_catalog::validate_snapshot(&bad, 10_100).is_err());
        let mut bad = studio_snapshot();
        bad.status.error = Some("untrusted-secret-error-body".into());
        assert!(studio_catalog::validate_snapshot(&bad, 10_100).is_err());
        let mut bad = studio_snapshot();
        bad.agents.push(bad.agents[0].clone());
        bad.status.agent_count = 2;
        assert!(studio_catalog::validate_snapshot(&bad, 10_100).is_err());
    }

    #[test]
    fn studio_cache_retains_last_complete_snapshot_and_ages_it() {
        let source = studio_source();
        let previous = studio_snapshot();
        let cache = studio_catalog::Cache {
            schema_version: 1,
            sources: vec![previous.clone()],
        };
        let fresh = studio_catalog::matching_snapshot(&cache, &source, 13_600)
            .unwrap()
            .unwrap();
        assert_eq!(fresh.status.state, "ready");
        let aged = studio_catalog::matching_snapshot(&cache, &source, 13_601)
            .unwrap()
            .unwrap();
        assert_eq!(aged.status.state, "stale");
        assert_eq!(aged.status.last_synced_at, Some(10_000));
        assert_eq!(aged.agents, previous.agents);
        for failure in [
            studio_catalog::Failure::Account,
            studio_catalog::Failure::Pagination,
            studio_catalog::Failure::Retryable,
        ] {
            let stale =
                studio_catalog::refreshed(&source, Some(previous.clone()), Err(failure), 20_000);
            assert_eq!(stale.agents, previous.agents);
            assert_eq!(stale.status.state, "stale");
            assert_eq!(stale.status.last_synced_at, Some(10_000));
            assert!(stale.status.error.is_some());
            studio_catalog::validate_snapshot(&stale, 20_000).unwrap();
        }
        let absent = studio_catalog::refreshed(
            &source,
            None,
            Err(studio_catalog::Failure::Forbidden),
            20_000,
        );
        assert!(absent.agents.is_empty());
        assert_eq!(absent.status.state, "unavailable");
        assert_eq!(absent.status.last_synced_at, None);
        studio_catalog::validate_snapshot(&absent, 20_000).unwrap();
        let empty = studio_catalog::refreshed(&source, Some(previous), Ok(Vec::new()), 20_000);
        assert_eq!(empty.status.state, "ready");
        assert_eq!(empty.status.agent_count, 0);
        let stale_empty = studio_catalog::refreshed(
            &source,
            Some(empty),
            Err(studio_catalog::Failure::Network),
            21_000,
        );
        assert_eq!(stale_empty.status.state, "stale");
        assert_eq!(stale_empty.status.last_synced_at, Some(20_000));
    }

    #[test]
    fn agent_card_projects_only_public_metadata() {
        let text = "---\nname: 'Display name'\nid: dayour-example\nmodel: example-model\ndescription: >-\n  Declared\n  description\nmcps: [calendar, 'command --token PRIVATE']\ntools:\n  required: [search]\n  mcp:\n    files:\n      optional: [list]\n      env: {SECRET: PRIVATE}\ninstructions: PRIVATE\n---\nPRIVATE BODY";
        let agent = parse_agent_definition(text, "example.md").unwrap();
        assert_eq!(agent.name, "Display name");
        assert_eq!(agent.description, "Declared description");
        assert_eq!(agent.model.as_deref(), Some("example-model"));
        let def = agent.definition.as_ref().unwrap();
        assert_eq!(def.declared_id.as_deref(), Some("dayour-example"));
        assert_eq!(def.tools.len(), 3);
        assert_eq!(def.tools[2].server.as_deref(), Some("files"));
        assert_eq!(def.omitted_entries, 1);
        assert!(!serde_json::to_string(&agent).unwrap().contains("PRIVATE"));
    }

    #[test]
    fn studio_contract_keeps_local_agents_compatible_and_cache_roundtrips() {
        let local = parse_agent_definition(
            "---\nname: local\ndescription: Local agent\n---\n",
            "local.md",
        )
        .unwrap();
        assert!(local.source.is_none());
        let value = serde_json::to_value(&local).unwrap();
        assert!(value.get("source").is_none());
        assert_eq!(
            serde_json::from_value::<CopilotAgent>(value).unwrap(),
            local
        );
        let snapshot = studio_snapshot();
        let cache = studio_catalog::Cache {
            schema_version: 1,
            sources: vec![snapshot.clone()],
        };
        let value = serde_json::to_value(&cache).unwrap();
        assert_eq!(
            value["sources"][0]["config"]["account"],
            "person@example.com"
        );
        assert_eq!(
            value["sources"][0]["config"]["subscriptionId"],
            studio_source().subscription_id
        );
        assert_eq!(
            value["sources"][0]["agents"][0]["source"]["provider"],
            "copilot-studio"
        );
        let decoded: studio_catalog::Cache = serde_json::from_value(value).unwrap();
        studio_catalog::validate_snapshot(&decoded.sources[0], 10_100).unwrap();
        assert_eq!(decoded.sources[0].agents, snapshot.agents);
    }

    #[test]
    fn studio_guard_rejects_before_workspace_validation_or_runtime_connection() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let state = CopilotRuntimeState::default();
        let agent = Some(studio_rows()[0].id.clone());
        for result in [
            state.new_session(app.handle(), agent.clone(), "invalid-relative-root".into()),
            state.load_session(
                app.handle(),
                agent.clone(),
                "session".into(),
                "invalid-relative-root".into(),
            ),
            state.resume_session(
                app.handle(),
                agent,
                "session".into(),
                "invalid-relative-root".into(),
            ),
        ] {
            let error = result.unwrap_err();
            assert!(error.said.contains("catalog-only"));
            assert!(error.detail.is_none());
        }
        assert!(state
            .configure(
                "session".into(),
                "agent".into(),
                studio_rows()[0].id.clone()
            )
            .unwrap_err()
            .said
            .contains("catalog-only"));
        assert!(state.runtime.lock().unwrap().is_none());
        assert!(require_local_agent(Some(" STUDIO:untrusted ")).is_err());
        assert!(require_local_agent(Some("local-agent")).is_ok());
        assert!(require_local_agent(None).is_ok());
    }

    #[test]
    #[ignore = "Requires explicitly approved real studio-sources.json and existing Azure CLI authentication"]
    fn studio_catalog_refresh_live() {
        let catalog = studio_catalog::catalog(true).expect("Configured Studio refresh failed");
        for source in &catalog.sources {
            print!(
                "{} bots={} state={}",
                source.environment_name, source.agent_count, source.state
            );
            for kind in ["workflow", "canvas-app", "model-driven-app"] {
                if let Some(rows) = source.assets.as_ref().filter(|_| {
                    !source
                        .asset_warnings
                        .iter()
                        .any(|w| w.starts_with(&format!("{kind}: ")))
                }) {
                    print!(" {kind}={}", rows.iter().filter(|r| r.kind == kind).count());
                } else {
                    print!(" {kind}=uncollected");
                }
            }
            println!(
                " error={:?} assetWarnings={:?}",
                source.error, source.asset_warnings
            );
        }
        println!(
            "sources={} agents={} warnings={}",
            catalog.sources.len(),
            catalog.agents.len(),
            catalog.warnings.len()
        );
        assert!(!catalog.sources.is_empty(), "No Studio sources configured");
        assert!(
            catalog
                .sources
                .iter()
                .all(|source| source.state == "ready" && source.asset_warnings.is_empty()),
            "Some Studio sources did not refresh successfully"
        );
        assert!(
            catalog.warnings.is_empty(),
            "Catalog persistence or validation reported a warning"
        );
    }
}
