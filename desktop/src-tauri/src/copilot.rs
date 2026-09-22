//! Supported GitHub Copilot CLI discovery for the desktop shell.
//!
//! Authentication belongs to Copilot CLI; OAuth tokens never enter Darbot. ACP supplies session
//! configuration, including authoritative agent/model choices. CLI JSON supplies resource inventory.
//! Only public agent frontmatter is read locally, for the picker before a session exists.

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
use tauri::{AppHandle, Emitter, Runtime};

use crate::copilot_client::{ClientConsent, ConsentDecision};
use crate::copilot_files::{self, ReadTextFile, WriteTextFile};
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotAgent {
    pub id: String,
    pub name: String,
    pub description: String,
    pub model: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotAgentCatalog {
    pub agents: Vec<CopilotAgent>,
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
    pub plugins: Vec<CopilotPlugin>,
    pub skills: Vec<CopilotSkill>,
    pub mcp_servers: Vec<CopilotMcpServer>,
    pub warnings: Vec<String>,
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
    history_agents: Mutex<HashMap<PathBuf, CachedHistoryAgent>>,
    pub consent: Arc<ClientConsent>,
}

impl CopilotRuntimeState {
    fn connected<R: Runtime>(&self, app: &AppHandle<R>) -> Result<Arc<CopilotRuntime>, Problem> {
        let mut runtime = self.runtime.lock().unwrap();
        if runtime
            .as_ref()
            .is_some_and(|connection| connection.is_alive())
        {
            return Ok(Arc::clone(runtime.as_ref().unwrap()));
        }

        if let Some(previous) = runtime.take() {
            previous.stop();
        }
        let connection = Arc::new(CopilotRuntime::start(app, Arc::clone(&self.consent))?);
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
        if let Some(runtime) = self.runtime.lock().unwrap().take() {
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
        let cwd = session_root(&cwd)?;
        self.connected(app)?.resume_session(session_id, cwd, agent)
    }

    pub fn prompt<R: Runtime>(
        &self,
        _app: &AppHandle<R>,
        _agent: Option<String>,
        session_id: String,
        prompt: String,
    ) -> Result<CopilotPromptResult, Problem> {
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
        self.current()?.configure(session_id, config_id, value)
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
                let name = match name.split_once(':') {
                    Some((namespace, agent))
                        if namespace
                            .strip_prefix("agency-rendered-")
                            .is_some_and(|suffix| {
                                suffix.len() == 32
                                    && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
                            }) =>
                    {
                        agent
                    }
                    _ => name,
                };
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
}

struct SessionState {
    cwd: String,
    config_options: Value,
}

struct RuntimeCore {
    identity: String,
    consent: Arc<ClientConsent>,
    stdin: Mutex<ChildStdin>,
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
        let core = Arc::new(RuntimeCore {
            identity: format!("acp-{:032x}", rand::random::<u128>()),
            consent,
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            permissions: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            next_request_id: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            stderr: Mutex::new(String::new()),
        });

        start_runtime_stderr(stderr, Arc::downgrade(&core));
        start_runtime_stdout(stdout, Arc::downgrade(&core), app.clone());

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
        let mut child = self.child.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
        fail_pending(
            &self.core,
            Problem::plain("GitHub Copilot was stopped before it answered."),
        );
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
        self.core.sessions.lock().unwrap().insert(
            session.session_id.clone(),
            SessionState {
                cwd: session.cwd.clone(),
                config_options: session.config_options.clone().unwrap_or_else(|| json!([])),
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
                        || (id == "mode" && current.ends_with("#autopilot"))
                });
            if should_reset {
                session.config_options = Some(
                    self.configure(session.session_id.clone(), id.into(), allowed.into())?
                        .config_options,
                );
            }
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
                || (config_id == "mode" && value.ends_with("#autopilot"))
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
        self.core.cancel_permissions(&session_id)?;
        self.core
            .notify("session/cancel", json!({"sessionId": session_id}))
    }

    fn close_session(&self, session_id: String) -> Result<(), Problem> {
        let session_id = required_text(session_id, "session ID")?;
        if !self.core.sessions.lock().unwrap().contains_key(&session_id) {
            return Ok(());
        }
        if !self.capabilities.close_session {
            return Err(Problem::plain(
                "This GitHub Copilot version does not support closing active sessions.",
            ));
        }
        self.core.cancel_permissions(&session_id)?;
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
        self.core.stopping.store(true, Ordering::SeqCst);
        self.core.closed.store(true, Ordering::SeqCst);
        self.core.consent.cancel(&self.core.identity, None);
        let child = self.child.get_mut().unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl RuntimeCore {
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
            return Err(problem);
        }
        let result =
            wait_for_runtime_response(receiver, timeout, on_timeout, || self.closed_problem());
        if result.is_err() {
            self.pending.lock().unwrap().remove(&key);
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
        let mut stdin = self.stdin.lock().unwrap();
        serde_json::to_writer(&mut *stdin, message).map_err(|error| {
            Problem::with(
                "Darbot could not send a request to GitHub Copilot.",
                error.to_string(),
            )
        })?;
        stdin.write_all(b"\n").map_err(|error| {
            Problem::with(
                "Darbot could not finish sending a request to GitHub Copilot.",
                error.to_string(),
            )
        })?;
        stdin.flush().map_err(|error| {
            Problem::with(
                "Darbot could not flush a request to GitHub Copilot.",
                error.to_string(),
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
        let rpc_id = pending.rpc_id.clone();
        permissions.remove(&request_id);
        drop(permissions);
        self.write(&json!({"jsonrpc": "2.0", "id": rpc_id, "result": result}))
    }

    fn cancel_permissions(&self, session_id: &str) -> Result<(), Problem> {
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

fn spawn_acp_child() -> Result<Child, Problem> {
    quiet::command("copilot")
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
    if message.get("result").is_some() || message.get("error").is_some() {
        if let Some(id) = message.get("id").and_then(json_id_key) {
            if let Some(sender) = core.pending.lock().unwrap().remove(&id) {
                let response = if let Some(error) = message.get("error") {
                    Err(Problem::with(
                        "GitHub Copilot refused the request.",
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

    match message.get("method").and_then(Value::as_str) {
        Some("session/update") => {
            if let Some(params) = message.get("params") {
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
                let _ = app.emit("copilot:session-update", params);
            }
        }
        Some("session/request_permission") => {
            route_permission_request(core, app, &message);
        }
        Some("fs/read_text_file" | "fs/write_text_file") => {
            route_file_request(core, app, &message);
        }
        Some(method) if message.get("id").is_some() => {
            let _ = core.write(&json!({
                "jsonrpc": "2.0",
                "id": message.get("id").cloned().unwrap_or(Value::Null),
                "error": {
                    "code": -32601,
                    "message": format!("Darbot does not support ACP client method {method}."),
                },
            }));
        }
        _ => {}
    }
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
    let Some(params) = message.get("params") else {
        return;
    };
    let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
        return;
    };
    let options: Vec<CopilotPermissionOption> = params
        .get("options")
        .cloned()
        .and_then(|options| serde_json::from_value(options).ok())
        .unwrap_or_default();
    if options.is_empty() {
        let _ = core.write(&json!({
            "jsonrpc": "2.0",
            "id": message.get("id").cloned().unwrap_or(Value::Null),
            "result": {"outcome": {"outcome": "cancelled"}},
        }));
        return;
    }
    core.permissions.lock().unwrap().insert(
        request_id.clone(),
        PendingPermission {
            rpc_id: message["id"].clone(),
            session_id: session_id.to_string(),
            options: options.clone(),
        },
    );
    let _ = app.emit(
        "copilot:permission-request",
        CopilotPermissionRequest {
            request_id,
            session_id: session_id.to_string(),
            origin: CopilotPermissionOrigin::Conversation,
            tool_call: params.get("toolCall").cloned().unwrap_or(Value::Null),
            options,
        },
    );
}

fn fail_pending(core: &RuntimeCore, problem: Problem) {
    core.consent.cancel(&core.identity, None);
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
    let core = Arc::clone(core);
    let app = app.clone();
    std::thread::spawn(move || {
        let result = (|| {
            let writing = matches!(request, ClientFileRequest::Write(_));
            if let ClientFileRequest::Write(request) = &request {
                if request.content.len() > copilot_files::MAX_FILE_BYTES {
                    return Err(Problem::plain(
                        "Client text-file writes are limited to 1 MiB.",
                    ));
                }
            }
            let home = copilot_home()?;
            let path = copilot_files::resolve(&cwd, request.path(), writing, &home)?;
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
            if core.consent.ask(
                &app,
                &core.identity,
                request.session_id(),
                CopilotPermissionOrigin::Conversation,
                details,
            )? != ConsentDecision::Allow
            {
                return Err(Problem::plain("The project file request was not approved."));
            }
            if core.closed.load(Ordering::SeqCst)
                || !core
                    .sessions
                    .lock()
                    .unwrap()
                    .contains_key(request.session_id())
            {
                return Err(Problem::plain("The file request's session has closed."));
            }
            let current = copilot_files::resolve(&cwd, request.path(), writing, &home)?;
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
        eprintln!(
            "Darbot could not answer a client operation: {}",
            problem.said
        );
    }
}

fn initialize_params(client_files: bool) -> Value {
    let mut params = json!({
        "protocolVersion": 1,
        "clientCapabilities": {
            "auth": {"terminal": true},
        },
        "clientInfo": {
            "name": "darbot",
            "title": "Darbot",
            "version": env!("CARGO_PKG_VERSION"),
        },
    });
    if client_files {
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

        loop {
            let line = self
                .stdout
                .recv_timeout(ACP_TIMEOUT)
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
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(Problem::with(
                    "GitHub Copilot refused the request.",
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
    let initialized = connection.request(0, "initialize", initialize_params(false))?;
    let mut status = parse_status(&initialized)?;

    if status.capabilities.list_sessions {
        match connection.request(1, "session/list", json!({})) {
            Ok(result) => {
                let sessions = result
                    .get("sessions")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        Problem::with(
                            "GitHub Copilot returned an invalid session list.",
                            result.to_string(),
                        )
                    })?;
                status.authentication = CopilotAuthentication::Ready;
                status.session_count = sessions.len();
                status.has_more_sessions = result
                    .get("nextCursor")
                    .and_then(Value::as_str)
                    .is_some_and(|cursor| !cursor.is_empty());
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
    Ok(status)
}

pub fn inventory(cwd: Option<String>) -> Result<CopilotInventory, Problem> {
    let cwd = workspace(cwd)?.cwd;
    let mut warnings = Vec::new();
    let agents = match discover_agents() {
        Ok((agents, agent_warnings)) => {
            warnings.extend(agent_warnings);
            agents
        }
        Err(problem) => {
            warnings.push(problem.said);
            Vec::new()
        }
    };
    let (plugins, skills, mcp) = std::thread::scope(|scope| {
        let plugins = scope.spawn(|| run_json(["plugin", "list", "--json"], "plugins", &cwd));
        let skills = scope.spawn(|| run_json(["skill", "list", "--json"], "skills", &cwd));
        let mcp = scope.spawn(|| run_json(["mcp", "list", "--json"], "MCP servers", &cwd));
        let failed = || Problem::plain("A Copilot resource reader stopped unexpectedly.");
        (
            plugins.join().unwrap_or_else(|_| Err(failed())),
            skills.join().unwrap_or_else(|_| Err(failed())),
            mcp.join().unwrap_or_else(|_| Err(failed())),
        )
    });

    Ok(CopilotInventory {
        agents,
        plugins: resource_result(plugins, parse_plugins, &mut warnings),
        skills: resource_result(skills, parse_skills, &mut warnings),
        mcp_servers: resource_result(mcp, parse_mcp_servers, &mut warnings),
        warnings,
    })
}

pub fn agents() -> Result<CopilotAgentCatalog, Problem> {
    let (agents, warnings) = discover_agents()?;
    Ok(CopilotAgentCatalog { agents, warnings })
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
    })
}

fn resource_result<T>(
    result: Result<(Value, Option<String>), Problem>,
    parse: impl FnOnce(Value) -> Result<Vec<T>, Problem>,
    warnings: &mut Vec<String>,
) -> Vec<T> {
    let result = result.and_then(|(value, warning)| {
        warnings.extend(warning);
        parse(value)
    });
    match result {
        Ok(resources) => resources,
        Err(problem) => {
            warnings.push(match problem.detail {
                Some(detail) if !detail.is_empty() => format!("{}\n{detail}", problem.said),
                _ => problem.said,
            });
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
        if !path.is_file()
            || path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_none_or(|extension| !extension.eq_ignore_ascii_case("md"))
        {
            continue;
        }
        let mut bytes = Vec::new();
        match fs::File::open(&path)
            .and_then(|file| file.take(1024 * 1024 + 1).read_to_end(&mut bytes))
        {
            Ok(_) => {}
            Err(error) => {
                warnings.push(format!(
                    "{} could not be read: {error}",
                    entry.file_name().to_string_lossy()
                ));
                continue;
            }
        }
        if bytes.len() > 1024 * 1024 {
            warnings.push(format!(
                "{} was ignored because its metadata file is larger than 1 MiB.",
                entry.file_name().to_string_lossy()
            ));
            continue;
        }
        let text = match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(error) => {
                warnings.push(format!(
                    "{} is not valid UTF-8: {error}",
                    entry.file_name().to_string_lossy()
                ));
                continue;
            }
        };
        if let Some(agent) = parse_agent_definition(&text) {
            if !agents
                .iter()
                .any(|found: &CopilotAgent| found.id == agent.id)
            {
                agents.push(agent);
            }
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

fn parse_agent_definition(text: &str) -> Option<CopilotAgent> {
    let lines = frontmatter_lines(text)?;
    let id = frontmatter_value(&lines, "name")?;
    let description = frontmatter_value(&lines, "description")?;
    Some(CopilotAgent {
        name: id.clone(),
        id,
        description,
        model: frontmatter_value(&lines, "model"),
    })
}

fn frontmatter_lines(text: &str) -> Option<Vec<&str>> {
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let mut frontmatter = Vec::new();
    for line in lines {
        if line.trim() == "---" {
            return Some(frontmatter);
        }
        frontmatter.push(line);
    }
    None
}

fn frontmatter_value(lines: &[&str], key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    for (index, line) in lines.iter().enumerate() {
        if line.len() != line.trim_start().len() || !line.starts_with(&prefix) {
            continue;
        }
        let raw = line[prefix.len()..].trim();
        if matches!(raw, ">" | ">-" | "|" | "|-") {
            let mut parts = Vec::new();
            for continuation in lines.iter().skip(index + 1) {
                if continuation.trim().is_empty() {
                    continue;
                }
                if continuation.len() == continuation.trim_start().len() {
                    break;
                }
                parts.push(continuation.trim());
            }
            return nonempty(Some(if raw.starts_with('>') {
                parts.join(" ")
            } else {
                parts.join("\n")
            }));
        }
        return nonempty(Some(unquote_yaml_scalar(raw)));
    }
    None
}

fn unquote_yaml_scalar(value: &str) -> String {
    if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
        return value[1..value.len() - 1].replace("''", "'");
    }
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        return value[1..value.len() - 1].replace("\\\"", "\"");
    }
    value.to_string()
}

pub fn login() -> Result<CopilotStatus, Problem> {
    let output = quiet::command("copilot")
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

fn run_json<const N: usize>(
    args: [&str; N],
    label: &str,
    cwd: &str,
) -> Result<(Value, Option<String>), Problem> {
    let output = quiet::command("copilot")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|error| {
            Problem::with(
                format!("Darbot could not read GitHub Copilot {label}."),
                error.to_string(),
            )
        })?;
    let warning = quiet::said(&output.stderr);
    if !output.status.success() {
        return Err(Problem::with(
            format!("GitHub Copilot could not list {label}."),
            warning,
        ));
    }
    let value = serde_json::from_slice(&output.stdout).map_err(|error| {
        Problem::with(
            format!("GitHub Copilot returned invalid {label} data."),
            error.to_string(),
        )
    })?;
    Ok((value, (!warning.is_empty()).then_some(warning)))
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
            prompt_image: capability_enabled(prompt, "image"),
            prompt_embedded_context: capability_enabled(prompt, "embeddedContext"),
            mcp_http: capability_enabled(mcp, "http"),
            mcp_sse: capability_enabled(mcp, "sse"),
        },
        auth_methods,
        session_count: 0,
        has_more_sessions: false,
        warnings: Vec::new(),
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
        .is_some_and(|value| !value.is_null())
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
        || text.contains("authentication required")
        || text.contains("not authenticated")
        || text.contains("log in")
}

fn nonempty(value: Option<String>) -> Option<String> {
    value.and_then(|value| (!value.trim().is_empty()).then_some(value))
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
        assert!(status.capabilities.prompt_image);
        assert!(status.capabilities.prompt_embedded_context);
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
        assert_eq!(capabilities, json!({"auth": {"terminal": true}}));
        assert!(capabilities.get("fs").is_none());
        assert!(capabilities.get("terminal").is_none());
        assert!(capabilities.get("elicitation").is_none());
        let connected = initialize_params(true);
        assert_eq!(
            connected["clientCapabilities"]["fs"],
            json!({"readTextFile": true, "writeTextFile": true})
        );
        assert!(connected["clientCapabilities"].get("terminal").is_none());
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
}
