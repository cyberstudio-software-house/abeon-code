use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use crate::db::supervisor_decisions_repo::NewDecision;
use crate::domain::supervisor::{SessionRebound, SupervisorSnapshot};
use crate::pty::session_registry::SessionClaim;
use crate::supervisor::settings::SupervisorSettings;

#[derive(Clone, Debug, PartialEq)]
pub struct SessionInfo {
    pub label: String,
    pub project_id: Option<i64>,
    pub project_path: Option<String>,
    pub pty_id: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SessionListing {
    pub session_id: String,
    pub label: String,
    pub provider: String,
    pub activity: String,
    pub controllable: bool,
    pub pending_question_id: Option<String>,
}

pub trait Effects: Send + Sync + 'static {
    fn settings(&self) -> SupervisorSettings;
    fn session_info(&self, session_id: &str) -> Option<SessionInfo>;
    fn bind_session(&self, session_id: &str, pty_id: &str, submitted: bool) -> SessionClaim;
    fn session_rebound(&self, rebound: SessionRebound);
    fn type_into_pty(&self, pty_id: &str, text: &str) -> Result<(), String>;
    fn input_quiet(&self, pty_id: &str, window: Duration) -> bool;
    fn submitted_recently(&self, pty_id: &str, window: Duration) -> bool;
    fn current_branch(&self, cwd: &Path) -> Option<String>;
    fn wake_supervisor(&self) -> bool;
    fn publish_snapshot(&self, snapshot: SupervisorSnapshot);
    fn notify_desktop(&self, session_id: &str, title: &str, body: &str);
    fn attention(&self, session_id: &str, message: &str);
    fn log_decision(&self, entry: NewDecision);
    fn list_sessions(&self) -> Vec<SessionListing>;
    fn read_session(&self, session_id: &str, max_blocks: usize) -> Option<String>;
    fn open_session(&self, project_path: &str, prompt: &str) -> Result<(), String>;
}
