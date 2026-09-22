//! One-shot, native-owned consent. Renderer decisions never carry executable operations.

use std::collections::HashMap;
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime};

use crate::copilot::{CopilotPermissionOption, CopilotPermissionOrigin, CopilotPermissionRequest};
use crate::problem::Problem;

const CONSENT_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_PENDING: usize = 32;
const MAX_DETAILS: usize = 32 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsentDecision {
    Allow,
    Reject,
    Cancel,
}

struct PendingConsent {
    owner: String,
    session_id: String,
    sender: Sender<ConsentDecision>,
}

#[derive(Default)]
pub struct ClientConsent {
    pending: Mutex<HashMap<String, PendingConsent>>,
}

impl ClientConsent {
    pub fn ask<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        owner: &str,
        session_id: &str,
        origin: CopilotPermissionOrigin,
        details: Value,
    ) -> Result<ConsentDecision, Problem> {
        self.ask_with(
            owner,
            session_id,
            origin,
            details,
            CONSENT_TIMEOUT,
            |request| {
                app.emit("copilot:permission-request", request)
                    .map_err(|error| {
                        Problem::with(
                            "Darbot could not show the requested permission.",
                            error.to_string(),
                        )
                    })
            },
            |request_id| {
                if let Err(error) = app.emit(
                    "copilot:permission-closed",
                    json!({"requestId": request_id, "sessionId": session_id}),
                ) {
                    eprintln!("Darbot could not close a permission notification: {error}");
                }
            },
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn ask_with(
        &self,
        owner: &str,
        session_id: &str,
        origin: CopilotPermissionOrigin,
        details: Value,
        timeout: Duration,
        publish: impl FnOnce(&CopilotPermissionRequest) -> Result<(), Problem>,
        close: impl FnOnce(&str),
    ) -> Result<ConsentDecision, Problem> {
        if owner.is_empty() || session_id.is_empty() || details.to_string().len() > MAX_DETAILS {
            return Err(Problem::plain(
                "The native permission request has invalid ownership or oversized details.",
            ));
        }
        let request_id = format!("client:{:032x}", rand::random::<u128>());
        let (sender, receiver) = mpsc::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.len() >= MAX_PENDING {
                return Err(Problem::plain(
                    "Too many permission requests are pending. Answer or cancel them first.",
                ));
            }
            pending.insert(
                request_id.clone(),
                PendingConsent {
                    owner: owner.into(),
                    session_id: session_id.into(),
                    sender,
                },
            );
        }
        let request = CopilotPermissionRequest {
            request_id: request_id.clone(),
            session_id: session_id.into(),
            origin,
            tool_call: details,
            options: vec![
                CopilotPermissionOption {
                    option_id: "allow-once".into(),
                    name: "Allow once".into(),
                    kind: "allow_once".into(),
                },
                CopilotPermissionOption {
                    option_id: "reject-once".into(),
                    name: "Reject".into(),
                    kind: "reject_once".into(),
                },
            ],
        };
        let result = publish(&request).and_then(|()| {
            receiver.recv_timeout(timeout).map_err(|error| {
                Problem::with(
                    "The permission request expired or its owner disconnected. No action was approved.",
                    error.to_string(),
                )
            })
        });
        self.pending.lock().unwrap().remove(&request_id);
        close(&request_id);
        result
    }

    pub fn respond(&self, request_id: &str, option_id: Option<&str>) -> Result<(), Problem> {
        let decision = match option_id {
            Some("allow-once") => ConsentDecision::Allow,
            Some("reject-once") => ConsentDecision::Reject,
            None => ConsentDecision::Cancel,
            _ => {
                return Err(Problem::plain(
                    "That decision was not offered by the native permission request.",
                ));
            }
        };
        let pending = self
            .pending
            .lock()
            .unwrap()
            .remove(request_id)
            .ok_or_else(|| {
                Problem::plain("That native permission request is no longer pending.")
            })?;
        pending.sender.send(decision).map_err(|_| {
            Problem::plain("The operation ended before its permission decision arrived.")
        })
    }

    pub fn cancel(&self, owner: &str, session_id: Option<&str>) {
        let mut pending = self.pending.lock().unwrap();
        let ids: Vec<_> = pending
            .iter()
            .filter(|(_, request)| {
                request.owner == owner
                    && session_id.is_none_or(|session| request.session_id == session)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(request) = pending.remove(&id) {
                // An expired receiver already means the operation cannot obtain approval.
                let _ = request.sender.send(ConsentDecision::Cancel);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn consent_validates_options_and_consumes_only_the_answered_request() {
        let consent = Arc::new(ClientConsent::default());
        let (opened, requests) = mpsc::channel();
        let mut workers = Vec::new();
        for session in ["one", "two"] {
            let consent = Arc::clone(&consent);
            let opened = opened.clone();
            workers.push(std::thread::spawn(move || {
                consent.ask_with(
                    "runtime",
                    session,
                    CopilotPermissionOrigin::Conversation,
                    json!({"title": "Read the selected file"}),
                    Duration::from_secs(5),
                    |request| {
                        opened.send(request.clone()).unwrap();
                        Ok(())
                    },
                    |_| {},
                )
            }));
        }
        let first = requests.recv_timeout(Duration::from_secs(5)).unwrap();
        let second = requests.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(consent
            .respond(&first.request_id, Some("allow-always"))
            .is_err());
        assert_eq!(consent.pending.lock().unwrap().len(), 2);
        consent
            .respond(&first.request_id, Some("allow-once"))
            .unwrap();
        assert_eq!(consent.pending.lock().unwrap().len(), 1);
        assert!(consent
            .respond(&first.request_id, Some("allow-once"))
            .is_err());
        consent
            .respond(&second.request_id, Some("reject-once"))
            .unwrap();
        let decisions: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap().unwrap())
            .collect();
        assert!(decisions.contains(&ConsentDecision::Allow));
        assert!(decisions.contains(&ConsentDecision::Reject));
    }

    #[test]
    fn interrupted_requests_are_cancelled_without_affecting_another_owner() {
        let consent = Arc::new(ClientConsent::default());
        let (opened, requests) = mpsc::channel();
        let owned = Arc::clone(&consent);
        let worker = std::thread::spawn(move || {
            owned.ask_with(
                "runtime-one",
                "session",
                CopilotPermissionOrigin::Conversation,
                json!({"title": "Write the selected file"}),
                Duration::from_secs(5),
                |request| {
                    opened.send(request.clone()).unwrap();
                    Ok(())
                },
                |_| {},
            )
        });
        let request = requests.recv_timeout(Duration::from_secs(5)).unwrap();
        consent.cancel("runtime-two", None);
        assert_eq!(consent.pending.lock().unwrap().len(), 1);
        consent.cancel("runtime-one", Some("session"));
        assert_eq!(worker.join().unwrap().unwrap(), ConsentDecision::Cancel);
        assert!(consent
            .respond(&request.request_id, Some("allow-once"))
            .is_err());
    }

    #[test]
    fn expiry_and_display_failure_remove_pending_authority() {
        let consent = ClientConsent::default();
        assert!(consent
            .ask_with(
                "runtime",
                "session",
                CopilotPermissionOrigin::Conversation,
                json!({"title": "Read"}),
                Duration::ZERO,
                |_| Ok(()),
                |_| {},
            )
            .is_err());
        assert!(consent
            .ask_with(
                "runtime",
                "session",
                CopilotPermissionOrigin::Conversation,
                json!({"title": "Read"}),
                Duration::from_secs(5),
                |_| Err(Problem::plain("Window is unavailable.")),
                |_| {},
            )
            .is_err());
        assert!(consent.pending.lock().unwrap().is_empty());
    }
}
