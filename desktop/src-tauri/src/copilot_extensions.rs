//! Versioned SDK operations in a separately owned background workspace, never an ACP session.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use github_copilot_sdk::handler::{PermissionHandler, PermissionResult};
use github_copilot_sdk::rpc::{
    FleetStartRequest, InstalledPluginInfo, PluginsDisableRequest, PluginsEnableRequest,
    RemoteSessionMetadataValue, SessionSource, SessionsListRequest, TasksCancelRequest,
    TasksSendMessageRequest, TasksStartAgentRequest,
};
use github_copilot_sdk::session::Session;
use github_copilot_sdk::{
    CliProgram, Client, ClientInfo, ClientOptions, MemoryConfiguration, PermissionRequestData,
    PermissionRequestKind, RequestId, SessionConfig, SessionId, Transport,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

use crate::copilot::{self, CopilotAgent, CopilotPermissionOrigin};
use crate::copilot_client::{ClientConsent, ConsentDecision};
use crate::problem::Problem;

pub const SCHEMA_VERSION: u8 = 1;
const SDK_VERSION: &str = "1.0.14";
const RPC_TIMEOUT: Duration = Duration::from_secs(60);
const OPEN_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_ROWS: usize = 200;
const MAX_TEXT: usize = 16_000;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum Feature<T> {
    Available { data: T },
    Unavailable { problem: Problem },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionPlugin {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub version: Option<String>,
    pub can_toggle: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionTask {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub title: String,
    pub output: Option<String>,
    pub output_truncated: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskMetadata {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    status: String,
    description: Option<String>,
    display_name: Option<String>,
    result: Option<String>,
    latest_response: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSession {
    pub id: String,
    pub title: String,
    pub modified_at: String,
    pub state: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSnapshot {
    pub schema_version: u8,
    pub sdk_version: String,
    pub runtime_version: String,
    pub protocol_version: u32,
    pub connection_id: String,
    pub session_id: String,
    pub cwd: String,
    pub memory_enabled: bool,
    pub agents: Feature<Vec<CopilotAgent>>,
    pub tasks: Feature<Vec<ExtensionTask>>,
    pub plugins: Feature<Vec<ExtensionPlugin>>,
    pub remote_sessions: Option<Feature<Vec<RemoteSession>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionRequest {
    pub schema_version: u8,
    pub action: ExtensionAction,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ExtensionAction {
    Connect {
        cwd: String,
        memory_enabled: bool,
    },
    Disconnect {
        connection_id: String,
    },
    Refresh {
        connection_id: String,
    },
    StartTask {
        connection_id: String,
        agent_id: String,
        name: String,
        prompt: String,
    },
    CancelTask {
        connection_id: String,
        task_id: String,
    },
    SendTaskMessage {
        connection_id: String,
        task_id: String,
        message: String,
    },
    StartFleet {
        connection_id: String,
        prompt: String,
    },
    SetPluginEnabled {
        connection_id: String,
        plugin_id: String,
        enabled: bool,
    },
    ListRemote {
        connection_id: String,
    },
}

struct Workspace {
    client: Client,
    session: Session,
    id: String,
    cwd: String,
    memory_enabled: bool,
    version: String,
    protocol: u32,
    closed: Arc<AtomicBool>,
    consent: Arc<ClientConsent>,
    remote: Mutex<Option<Feature<Vec<RemoteSession>>>>,
    cached: Mutex<Option<ExtensionSnapshot>>,
}

impl Workspace {
    fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.consent.cancel(&self.id, None);
        self.client.force_stop();
    }

    async fn rpc<T>(
        &self,
        operation: &str,
        mutation: bool,
        future: impl std::future::Future<Output = Result<T, github_copilot_sdk::Error>>,
    ) -> Result<T, Problem> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(Problem::plain(
                "The SDK background workspace is disconnected.",
            ));
        }
        let result = match tokio::time::timeout(RPC_TIMEOUT, future).await {
            Ok(Ok(value)) => return Ok(value),
            Ok(Err(error)) => sdk_problem(operation, error),
            Err(_) => Problem::plain(format!("SDK {operation} exceeded its one-minute deadline.")),
        };
        if mutation {
            self.shutdown();
            return Err(Problem::with(
                format!("{} The SDK workspace was stopped to avoid leaving untracked background work. ACP conversations were not changed.", result.said),
                result.detail.unwrap_or_default(),
            ));
        }
        Err(result)
    }

    async fn tasks(&self) -> Result<Vec<ExtensionTask>, Problem> {
        let list = self
            .rpc("task listing", false, self.session.rpc().tasks().list())
            .await?;
        if list.tasks.len() > MAX_ROWS {
            return Err(Problem::plain("The SDK returned more than 200 background tasks; the list was not silently truncated."));
        }
        list.tasks.into_iter().map(project_task).collect()
    }

    async fn plugins(&self) -> Result<Vec<InstalledPluginInfo>, Problem> {
        let list = self
            .rpc("plugin listing", false, self.client.rpc().plugins().list())
            .await?;
        if list.plugins.len() > MAX_ROWS {
            return Err(Problem::plain("The SDK returned more than 200 plugins."));
        }
        Ok(list.plugins)
    }

    async fn agents(&self) -> Result<Vec<CopilotAgent>, Problem> {
        let list = self
            .rpc("agent listing", false, self.session.rpc().agent().list())
            .await?;
        if list.agents.len() > MAX_ROWS {
            return Err(Problem::plain("The SDK returned more than 200 agents."));
        }
        list.agents
            .into_iter()
            .map(|agent| {
                bounded(&agent.id, 512, "agent identifier")?;
                Ok(CopilotAgent {
                    id: agent.id,
                    name: bounded(&agent.display_name, 512, "agent name")?,
                    description: bounded(&agent.description, MAX_TEXT, "agent description")?,
                    model: None,
                })
            })
            .collect()
    }

    async fn snapshot(&self) -> ExtensionSnapshot {
        let snapshot = ExtensionSnapshot {
            schema_version: SCHEMA_VERSION,
            sdk_version: SDK_VERSION.into(),
            runtime_version: self.version.clone(),
            protocol_version: self.protocol,
            connection_id: self.id.clone(),
            session_id: self.session.id().to_string(),
            cwd: self.cwd.clone(),
            memory_enabled: self.memory_enabled,
            agents: feature(self.agents().await),
            tasks: feature(self.tasks().await),
            plugins: feature(
                self.plugins()
                    .await
                    .and_then(|plugins| plugins.into_iter().map(project_plugin).collect()),
            ),
            remote_sessions: self.remote.lock().unwrap().clone(),
        };
        *self.cached.lock().unwrap() = Some(snapshot.clone());
        snapshot
    }

    async fn approve<R: Runtime>(&self, app: &AppHandle<R>, details: Value) -> Result<(), Problem> {
        let app = app.clone();
        let consent = Arc::clone(&self.consent);
        let owner = self.id.clone();
        let session = self.session.id().to_string();
        let decision = tauri::async_runtime::spawn_blocking(move || {
            consent.ask(
                &app,
                &owner,
                &session,
                CopilotPermissionOrigin::Background,
                details,
            )
        })
        .await
        .map_err(|error| Problem::with("The approval operation stopped.", error.to_string()))??;
        if decision != ConsentDecision::Allow {
            return Err(Problem::plain("The SDK action was not approved."));
        }
        if self.closed.load(Ordering::SeqCst) {
            return Err(Problem::plain("The SDK workspace closed during approval."));
        }
        Ok(())
    }
}

#[derive(Default)]
pub struct ExtensionState {
    workspace: Mutex<Option<Arc<Workspace>>>,
    opening: tauri::async_runtime::Mutex<()>,
}

impl ExtensionState {
    pub fn shutdown(&self) {
        if let Some(workspace) = self.workspace.lock().unwrap().take() {
            workspace.shutdown();
        }
    }

    pub fn status(&self) -> Option<ExtensionSnapshot> {
        let workspace = self.workspace.lock().unwrap().clone();
        match workspace {
            Some(workspace) if !workspace.closed.load(Ordering::SeqCst) => {
                workspace.cached.lock().unwrap().clone()
            }
            _ => None,
        }
    }

    fn current(&self, id: &str) -> Result<Arc<Workspace>, Problem> {
        self.workspace.lock().unwrap().as_ref()
            .filter(|workspace| workspace.id == id && !workspace.closed.load(Ordering::SeqCst))
            .cloned().ok_or_else(|| Problem::plain("That SDK workspace is no longer active. Reconnect explicitly; ACP is still available."))
    }

    async fn connect<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        consent: Arc<ClientConsent>,
        cwd: String,
        memory_enabled: bool,
    ) -> Result<ExtensionSnapshot, Problem> {
        let _opening = self.opening.lock().await;
        if self
            .workspace
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|workspace| !workspace.closed.load(Ordering::SeqCst))
        {
            return Err(Problem::plain(
                "Disconnect the current SDK workspace before selecting another.",
            ));
        }
        let cwd = copilot::workspace(Some(cwd))?.cwd;
        let client = Client::start(client_options(Path::new(&cwd)))
            .await
            .map_err(|error| sdk_problem("startup", error))?;
        let id = format!("sdk-{:032x}", rand::random::<u128>());
        let closed = Arc::new(AtomicBool::new(false));
        let prepared = async {
            let status = tokio::time::timeout(RPC_TIMEOUT, client.get_status()).await
                .map_err(|_| Problem::plain("SDK status timed out."))?
                .map_err(|error| sdk_problem("status", error))?;
            let auth = tokio::time::timeout(RPC_TIMEOUT, client.get_auth_status()).await
                .map_err(|_| Problem::plain("SDK authentication status timed out."))?
                .map_err(|error| sdk_problem("authentication status", error))?;
            if !auth.is_authenticated {
                return Err(Problem::plain("Sign in through Copilot CLI before starting an SDK workspace. Darbot does not collect its tokens."));
            }
            let permissions = NativePermissions {
                app: app.clone(),
                consent: Arc::clone(&consent),
                owner: id.clone(),
                closed: Arc::clone(&closed),
            };
            let config = SessionConfig::default()
                .with_working_directory(&cwd)
                .with_memory(MemoryConfiguration::disabled().with_enabled(memory_enabled))
                .with_permission_handler(Arc::new(permissions));
            let session = tokio::time::timeout(OPEN_TIMEOUT, client.create_session(config)).await
                .map_err(|_| Problem::plain("Opening the SDK workspace exceeded five minutes."))?
                .map_err(|error| sdk_problem("workspace creation", error))?;
            Ok(Arc::new(Workspace {
                client: client.clone(),
                session,
                id: id.clone(),
                cwd,
                memory_enabled,
                version: status.version,
                protocol: status.protocol_version,
                closed: Arc::clone(&closed),
                consent: Arc::clone(&consent),
                remote: Mutex::new(None),
                cached: Mutex::new(None),
            }))
        }.await;
        match prepared {
            Ok(workspace) => {
                *self.workspace.lock().unwrap() = Some(Arc::clone(&workspace));
                Ok(workspace.snapshot().await)
            }
            Err(problem) => {
                closed.store(true, Ordering::SeqCst);
                consent.cancel(&id, None);
                client.force_stop();
                Err(problem)
            }
        }
    }

    pub async fn execute<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        consent: Arc<ClientConsent>,
        request: ExtensionRequest,
    ) -> Result<Option<ExtensionSnapshot>, Problem> {
        if request.schema_version != SCHEMA_VERSION {
            return Err(Problem::plain("Unsupported SDK extension schema version."));
        }
        if let ExtensionAction::Connect {
            cwd,
            memory_enabled,
        } = request.action
        {
            return self
                .connect(app, consent, cwd, memory_enabled)
                .await
                .map(Some);
        }
        let id = match &request.action {
            ExtensionAction::Disconnect { connection_id }
            | ExtensionAction::Refresh { connection_id }
            | ExtensionAction::StartTask { connection_id, .. }
            | ExtensionAction::CancelTask { connection_id, .. }
            | ExtensionAction::SendTaskMessage { connection_id, .. }
            | ExtensionAction::StartFleet { connection_id, .. }
            | ExtensionAction::SetPluginEnabled { connection_id, .. }
            | ExtensionAction::ListRemote { connection_id } => connection_id,
            ExtensionAction::Connect { .. } => unreachable!(),
        };
        let workspace = self.current(id)?;
        match request.action {
            ExtensionAction::Disconnect { .. } => {
                workspace.approve(app, json!({"title": "Disconnect the SDK background workspace", "workingDirectory": workspace.cwd, "effect": "Stops only this SDK workspace and its owned background tasks; ACP conversations remain connected."})).await?;
                workspace.shutdown();
                self.workspace.lock().unwrap().take();
                return Ok(None);
            }
            ExtensionAction::StartTask {
                agent_id,
                name,
                prompt,
                ..
            } => {
                let name = required(&name, 128, "task name")?;
                let prompt = required(&prompt, MAX_TEXT, "task prompt")?;
                if !workspace
                    .agents()
                    .await?
                    .iter()
                    .any(|agent| agent.id == agent_id)
                {
                    return Err(Problem::plain(
                        "That agent was not offered by this SDK workspace.",
                    ));
                }
                workspace.approve(app, json!({"title":"Start one background agent", "agent":agent_id, "name":name, "prompt":prompt, "workingDirectory":workspace.cwd, "notice":"This uses Copilot credits. Native approval remains required for tool actions."})).await?;
                workspace
                    .rpc(
                        "starting a background agent",
                        true,
                        workspace
                            .session
                            .rpc()
                            .tasks()
                            .start_agent(TasksStartAgentRequest {
                                agent_type: agent_id,
                                name,
                                prompt,
                                description: None,
                                model: None,
                            }),
                    )
                    .await?;
            }
            ExtensionAction::CancelTask { task_id, .. } => {
                require_task(&workspace, &task_id).await?;
                workspace
                    .approve(
                        app,
                        json!({"title":"Cancel a background task", "taskId":task_id}),
                    )
                    .await?;
                let result = workspace
                    .rpc(
                        "task cancellation",
                        true,
                        workspace
                            .session
                            .rpc()
                            .tasks()
                            .cancel(TasksCancelRequest { id: task_id }),
                    )
                    .await?;
                if !result.cancelled {
                    return Err(Problem::plain(
                        "The runtime did not cancel that task; refresh its current state.",
                    ));
                }
            }
            ExtensionAction::SendTaskMessage {
                task_id, message, ..
            } => {
                require_task(&workspace, &task_id).await?;
                let message = required(&message, MAX_TEXT, "task message")?;
                workspace.approve(app, json!({"title":"Send a background task another message", "taskId":task_id, "message":message})).await?;
                let result = workspace
                    .rpc(
                        "task message",
                        true,
                        workspace
                            .session
                            .rpc()
                            .tasks()
                            .send_message(TasksSendMessageRequest {
                                id: task_id,
                                message,
                                from_agent_id: None,
                            }),
                    )
                    .await?;
                if !result.sent {
                    return Err(Problem::with(
                        "The task message was not delivered.",
                        result
                            .error
                            .unwrap_or_else(|| "The runtime returned sent=false.".into()),
                    ));
                }
            }
            ExtensionAction::StartFleet { prompt, .. } => {
                let prompt = required(&prompt, MAX_TEXT, "fleet prompt")?;
                workspace.approve(app, json!({"title":"Start Copilot fleet orchestration", "prompt":prompt, "workingDirectory":workspace.cwd, "notice":"This can launch multiple agents and consume substantial Copilot credits. It is separate from the current ACP chat."})).await?;
                let mut request = FleetStartRequest::default();
                request.prompt = Some(prompt);
                request.wait = Some(false);
                let result = workspace
                    .rpc(
                        "fleet start",
                        true,
                        workspace.session.rpc().fleet().start(request),
                    )
                    .await?;
                if !result.started {
                    return Err(Problem::plain(
                        "The runtime did not start fleet orchestration.",
                    ));
                }
            }
            ExtensionAction::SetPluginEnabled {
                plugin_id, enabled, ..
            } => {
                let plugin = workspace
                    .plugins()
                    .await?
                    .into_iter()
                    .map(project_plugin)
                    .collect::<Result<Vec<_>, _>>()?
                    .into_iter()
                    .find(|plugin| plugin.id == plugin_id && plugin.can_toggle)
                    .ok_or_else(|| {
                        Problem::plain("That plugin cannot be toggled through this SDK workspace.")
                    })?;
                workspace.approve(app, json!({"title": if enabled {"Enable a Copilot plugin"} else {"Disable a Copilot plugin"}, "plugin":plugin.name, "workingDirectory":workspace.cwd, "notice":"Changes CLI-owned plugin settings. Disabling can stop that plugin's MCP servers in active CLI sessions."})).await?;
                if enabled {
                    workspace
                        .rpc(
                            "plugin enable",
                            true,
                            workspace
                                .client
                                .rpc()
                                .plugins()
                                .enable(PluginsEnableRequest {
                                    names: vec![plugin_id],
                                    working_directory: Some(workspace.cwd.clone()),
                                }),
                        )
                        .await?;
                } else {
                    workspace
                        .rpc(
                            "plugin disable",
                            true,
                            workspace
                                .client
                                .rpc()
                                .plugins()
                                .disable(PluginsDisableRequest {
                                    names: vec![plugin_id],
                                    working_directory: Some(workspace.cwd.clone()),
                                }),
                        )
                        .await?;
                }
            }
            ExtensionAction::ListRemote { .. } => {
                let result =
                    workspace
                        .rpc(
                            "remote session discovery",
                            false,
                            workspace.client.rpc().sessions().list_with_params(
                                SessionsListRequest {
                                    source: Some(SessionSource::Remote),
                                    throw_on_error: Some(true),
                                    metadata_limit: Some(0),
                                    include_detached: Some(false),
                                    filter: None,
                                },
                            ),
                        )
                        .await
                        .and_then(|list| {
                            if list.sessions.len() > MAX_ROWS {
                                return Err(Problem::plain(
                                    "More than 200 remote sessions were returned.",
                                ));
                            }
                            list.sessions.into_iter().map(project_remote).collect()
                        });
                *workspace.remote.lock().unwrap() = Some(feature(result));
            }
            ExtensionAction::Refresh { .. } => {}
            ExtensionAction::Connect { .. } => unreachable!(),
        }
        Ok(Some(workspace.snapshot().await))
    }
}

struct NativePermissions<R: Runtime> {
    app: AppHandle<R>,
    consent: Arc<ClientConsent>,
    owner: String,
    closed: Arc<AtomicBool>,
}

#[async_trait]
impl<R: Runtime> PermissionHandler for NativePermissions<R> {
    async fn handle(
        &self,
        session_id: SessionId,
        _request_id: RequestId,
        data: PermissionRequestData,
    ) -> PermissionResult {
        if self.closed.load(Ordering::SeqCst) {
            return PermissionResult::user_not_available();
        }
        let details = match permission_details(&data) {
            Ok(details) => details,
            Err(problem) => return PermissionResult::reject(Some(problem.said)),
        };
        let app = self.app.clone();
        let consent = Arc::clone(&self.consent);
        let owner = self.owner.clone();
        let decision = tauri::async_runtime::spawn_blocking(move || {
            consent.ask(
                &app,
                &owner,
                session_id.as_str(),
                CopilotPermissionOrigin::Background,
                details,
            )
        })
        .await;
        match decision {
            Ok(Ok(ConsentDecision::Allow)) if !self.closed.load(Ordering::SeqCst) => {
                PermissionResult::approve_once()
            }
            Ok(Ok(ConsentDecision::Reject)) => PermissionResult::reject(None),
            Ok(Ok(_)) => PermissionResult::user_not_available(),
            Ok(Err(problem)) => PermissionResult::reject(Some(problem.said)),
            Err(error) => PermissionResult::reject(Some(format!(
                "Native permission handling failed: {error}"
            ))),
        }
    }
}

fn client_options(cwd: &Path) -> ClientOptions {
    ClientOptions::new()
        .with_program(CliProgram::Path(PathBuf::from("copilot")))
        .with_transport(Transport::Stdio)
        .with_cwd(cwd)
        .with_extra_args(["--no-auto-update"])
        .with_use_logged_in_user(true)
        .with_client_info(
            ClientInfo::new()
                .with_application_name("Darbot")
                .with_application_version(env!("CARGO_PKG_VERSION"))
                .with_integration_name("native-sdk-extensions")
                .with_integration_version(SCHEMA_VERSION.to_string()),
        )
}

fn permission_details(data: &PermissionRequestData) -> Result<Value, Problem> {
    let kind = data
        .kind
        .ok_or_else(|| Problem::plain("The SDK permission has no action category."))?;
    if matches!(kind, PermissionRequestKind::Unknown) {
        return Err(Problem::plain(
            "This SDK permission category is not supported by Darbot.",
        ));
    }
    validate_details(&data.extra, 0)?;
    if !data.extra.is_object() || data.extra.as_object().is_some_and(|map| map.is_empty()) {
        return Err(Problem::plain(
            "The SDK supplied no action details to review.",
        ));
    }
    let details = json!({"title":format!("Background SDK {kind:?} action"), "request":data.extra});
    if details.to_string().len() > 30 * 1024 {
        return Err(Problem::plain(
            "The SDK permission details are too large to review safely.",
        ));
    }
    Ok(details)
}

fn validate_details(value: &Value, depth: usize) -> Result<(), Problem> {
    if depth > 8 {
        return Err(Problem::plain(
            "The SDK action details exceed the nesting limit.",
        ));
    }
    match value {
        Value::Object(fields) => {
            if fields.len() > 64 {
                return Err(Problem::plain("Too many SDK action fields."));
            }
            for (key, value) in fields {
                let key: String = key
                    .chars()
                    .filter(char::is_ascii_alphanumeric)
                    .flat_map(char::to_lowercase)
                    .collect();
                if [
                    "token",
                    "accesstoken",
                    "refreshtoken",
                    "idtoken",
                    "apikey",
                    "password",
                    "clientsecret",
                    "privatekey",
                ]
                .contains(&key.as_str())
                {
                    return Err(Problem::plain(
                        "Credential-bearing SDK action details cannot be sent to the renderer.",
                    ));
                }
                validate_details(value, depth + 1)?;
            }
        }
        Value::Array(items) => {
            if items.len() > 128 {
                return Err(Problem::plain("Too many SDK action detail items."));
            }
            for item in items {
                validate_details(item, depth + 1)?;
            }
        }
        Value::String(text) if text.len() > MAX_TEXT => {
            return Err(Problem::plain(
                "An SDK action detail exceeds the text limit.",
            ))
        }
        _ => {}
    }
    Ok(())
}

fn sdk_problem(operation: &str, error: github_copilot_sdk::Error) -> Problem {
    Problem::with(
        format!("Copilot SDK {operation} failed. ACP remains available."),
        error.to_string(),
    )
}

fn feature<T>(result: Result<T, Problem>) -> Feature<T> {
    match result {
        Ok(data) => Feature::Available { data },
        Err(problem) => Feature::Unavailable { problem },
    }
}

fn bounded(value: &str, limit: usize, label: &str) -> Result<String, Problem> {
    if value.len() > limit || value.contains('\0') {
        return Err(Problem::plain(format!(
            "The SDK {label} is invalid or exceeds {limit} bytes."
        )));
    }
    Ok(value.into())
}

fn required(value: &str, limit: usize, label: &str) -> Result<String, Problem> {
    if value.trim().is_empty() {
        return Err(Problem::plain(format!("A nonempty {label} is required.")));
    }
    bounded(value, limit, label)
}

fn project_plugin(plugin: InstalledPluginInfo) -> Result<ExtensionPlugin, Problem> {
    let name = required(&plugin.name, 256, "plugin name")?;
    let marketplace = bounded(&plugin.marketplace, 256, "plugin marketplace")?;
    let can_toggle = !marketplace.is_empty()
        && plugin.source.as_deref() != Some("builtin")
        && plugin.direct_source_id.is_none();
    let id = if marketplace.is_empty() {
        format!(
            "direct:{}",
            plugin.direct_source_id.as_deref().unwrap_or(&name)
        )
    } else {
        format!("{name}@{marketplace}")
    };
    Ok(ExtensionPlugin {
        id,
        name,
        enabled: plugin.enabled,
        version: plugin.version,
        can_toggle,
    })
}

fn project_task(value: Value) -> Result<ExtensionTask, Problem> {
    let task: TaskMetadata = serde_json::from_value(value).map_err(|error| {
        Problem::with("The SDK returned invalid task metadata.", error.to_string())
    })?;
    let output = task.error.or(task.latest_response).or(task.result);
    let output_truncated = output.as_ref().is_some_and(|text| text.len() > MAX_TEXT);
    let output = output.map(|mut text| {
        if text.len() > MAX_TEXT {
            let mut end = MAX_TEXT;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
        }
        text
    });
    Ok(ExtensionTask {
        id: required(&task.id, 512, "task identifier")?,
        kind: required(&task.kind, 64, "task kind")?,
        status: required(&task.status, 64, "task status")?,
        title: bounded(
            &task
                .display_name
                .or(task.description)
                .unwrap_or_else(|| task.id.clone()),
            1024,
            "task title",
        )?,
        output,
        output_truncated,
    })
}

fn project_remote(value: Value) -> Result<RemoteSession, Problem> {
    let session: RemoteSessionMetadataValue = serde_json::from_value(value).map_err(|error| {
        Problem::with(
            "The SDK returned invalid remote session metadata.",
            error.to_string(),
        )
    })?;
    if !session.is_remote {
        return Err(Problem::plain(
            "A local session was returned in the remote-only listing.",
        ));
    }
    Ok(RemoteSession {
        id: required(
            session.session_id.as_str(),
            512,
            "remote session identifier",
        )?,
        title: bounded(
            &session
                .name
                .or(session.summary)
                .unwrap_or_else(|| session.session_id.to_string()),
            1024,
            "remote session title",
        )?,
        modified_at: bounded(&session.modified_time, 128, "remote modification time")?,
        state: session.state,
    })
}

async fn require_task(workspace: &Workspace, id: &str) -> Result<(), Problem> {
    required(id, 512, "task identifier")?;
    if !workspace.tasks().await?.iter().any(|task| task.id == id) {
        return Err(Problem::plain(
            "That task does not belong to the current SDK workspace.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_contract_refuses_unknown_operations_and_credential_fields() {
        assert!(serde_json::from_value::<ExtensionRequest>(
            json!({"schemaVersion":1,"action":{"kind":"shell","command":"anything"}})
        )
        .is_err());
        assert!(serde_json::from_value::<ExtensionRequest>(json!({"schemaVersion":1,"action":{"kind":"connect","cwd":"C:\\project","memoryEnabled":false,"apiKey":"not-a-real-key"}})).is_err());
        let request: ExtensionRequest = serde_json::from_value(json!({"schemaVersion":1,"action":{"kind":"connect","cwd":"C:\\project","memoryEnabled":false}})).unwrap();
        assert_eq!(request.schema_version, SCHEMA_VERSION);
        assert!(
            validate_details(&json!({"nested":{"accessToken":"not-a-real-token"}}), 0).is_err()
        );
    }

    #[test]
    fn explicit_installed_stdio_runtime_keeps_authentication_and_remote_export_cli_owned() {
        let options = client_options(Path::new("C:\\project"));
        assert!(
            matches!(options.program, CliProgram::Path(ref path) if path == Path::new("copilot"))
        );
        assert!(matches!(options.transport, Transport::Stdio));
        assert!(options.github_token.is_none());
        assert!(!options.enable_remote_sessions);
        assert_eq!(options.use_logged_in_user, Some(true));
        assert_eq!(options.extra_args, ["--no-auto-update"]);
        const { assert!(!github_copilot_sdk::HAS_BUNDLED_CLI) };
    }

    #[test]
    fn task_projection_bounds_output_and_does_not_copy_extra_metadata() {
        let task = project_task(json!({"id":"task-one","type":"agent","status":"completed","displayName":"One task","latestResponse":"x".repeat(MAX_TEXT+5),"accessToken":"must-not-leave-native"})).unwrap();
        assert!(task.output_truncated);
        assert_eq!(task.output.as_ref().unwrap().len(), MAX_TEXT);
        assert!(!serde_json::to_string(&task)
            .unwrap()
            .contains("must-not-leave-native"));
        assert!(project_task(json!({"type":"agent"})).is_err());
    }

    #[test]
    #[ignore = "Requires the installed real Copilot CLI; reads status only, never starts a session or changes authentication."]
    fn installed_sdk_transport_handshake() {
        tauri::async_runtime::block_on(async {
            let cwd = std::env::current_dir().unwrap();
            let client = Client::start(client_options(&cwd))
                .await
                .expect("installed CLI SDK startup");
            let result = tokio::time::timeout(RPC_TIMEOUT, client.get_status()).await;
            client.force_stop();
            let status = result
                .expect("bounded SDK status")
                .expect("real SDK status");
            assert!(!status.version.is_empty());
            assert!(status.protocol_version >= 3);
            println!(
                "Installed CLI SDK handshake: version {}, protocol {}.",
                status.version, status.protocol_version
            );
        });
    }
}
