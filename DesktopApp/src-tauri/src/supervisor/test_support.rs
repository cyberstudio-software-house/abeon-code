use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::task::JoinHandle;

use crate::db::supervisor_decisions_repo::NewDecision;
use crate::domain::supervisor::{SupervisorLevel, SupervisorSnapshot};
use crate::supervisor::core::SupervisorCore;
use crate::supervisor::effects::{Effects, SessionInfo, SessionListing};
use crate::supervisor::events::SupervisorEvent;
use crate::supervisor::hook_io::{HookInput, HookReply};
use crate::supervisor::settings::SupervisorSettings;

pub(crate) const SECOND: Duration = Duration::from_secs(1);
pub(crate) const COLOR_QUESTION: &str = "Which color do you prefer?";

pub(crate) struct FakeEffects {
    pub(crate) settings: Mutex<SupervisorSettings>,
    pub(crate) sessions: Mutex<HashMap<String, SessionInfo>>,
    pub(crate) live_ptys: Mutex<HashSet<String>>,
    pub(crate) quiet: AtomicBool,
    pub(crate) keystrokes: Mutex<HashMap<String, Instant>>,
    pub(crate) submits: Mutex<HashMap<String, Instant>>,
    pub(crate) type_fails: AtomicBool,
    pub(crate) wake_accepts: AtomicBool,
    pub(crate) wakes: AtomicUsize,
    pub(crate) typed: Mutex<Vec<(String, String)>>,
    pub(crate) snapshots: Mutex<Vec<SupervisorSnapshot>>,
    pub(crate) notifications: Mutex<Vec<(String, String, String)>>,
    pub(crate) decisions: Mutex<Vec<NewDecision>>,
    pub(crate) branch: Mutex<Option<String>>,
    pub(crate) branch_lookups: Mutex<Vec<PathBuf>>,
    pub(crate) listings: Mutex<Vec<SessionListing>>,
    pub(crate) transcripts: Mutex<HashMap<String, String>>,
    pub(crate) reads: Mutex<Vec<(String, usize)>>,
    pub(crate) opened: Mutex<Vec<(String, String)>>,
    pub(crate) open_error: Mutex<Option<String>>,
}

impl FakeEffects {
    pub(crate) fn new() -> Arc<FakeEffects> {
        let sessions = ["s1", "s2"]
            .iter()
            .enumerate()
            .map(|(index, id)| {
                let info = SessionInfo {
                    label: format!("projekt · {id}"),
                    project_id: Some(index as i64 + 1),
                    project_path: Some(format!("/projects/{id}")),
                    pty_id: Some(format!("pty-{id}")),
                };
                (id.to_string(), info)
            })
            .collect();
        Arc::new(FakeEffects {
            settings: Mutex::new(SupervisorSettings {
                level: SupervisorLevel::Assistant,
                grace: Duration::from_secs(60),
                presence: Duration::from_secs(300),
                model_id: None,
                extra_rules: Vec::new(),
            }),
            sessions: Mutex::new(sessions),
            live_ptys: Mutex::new(HashSet::from(["pty-s1".to_string(), "pty-s2".to_string()])),
            quiet: AtomicBool::new(true),
            keystrokes: Mutex::default(),
            submits: Mutex::default(),
            type_fails: AtomicBool::new(false),
            wake_accepts: AtomicBool::new(true),
            wakes: AtomicUsize::new(0),
            typed: Mutex::default(),
            snapshots: Mutex::default(),
            notifications: Mutex::default(),
            decisions: Mutex::default(),
            branch: Mutex::default(),
            branch_lookups: Mutex::default(),
            listings: Mutex::default(),
            transcripts: Mutex::default(),
            reads: Mutex::default(),
            opened: Mutex::default(),
            open_error: Mutex::default(),
        })
    }

    pub(crate) fn keystroke(&self, pty_id: &str) {
        self.keystrokes
            .lock()
            .insert(pty_id.to_string(), tokio::time::Instant::now().into_std());
    }

    pub(crate) fn submit(&self, pty_id: &str) {
        self.keystroke(pty_id);
        self.submits
            .lock()
            .insert(pty_id.to_string(), tokio::time::Instant::now().into_std());
    }

    pub(crate) fn wakes(&self) -> usize {
        self.wakes.load(Ordering::SeqCst)
    }

    pub(crate) fn typed(&self) -> Vec<(String, String)> {
        self.typed.lock().clone()
    }

    pub(crate) fn kinds(&self) -> Vec<&'static str> {
        self.decisions
            .lock()
            .iter()
            .map(|entry| entry.kind)
            .collect()
    }

    pub(crate) fn notifications(&self) -> Vec<(String, String, String)> {
        self.notifications.lock().clone()
    }

    pub(crate) fn last_snapshot(&self) -> Option<SupervisorSnapshot> {
        self.snapshots.lock().last().cloned()
    }
}

impl Effects for FakeEffects {
    fn settings(&self) -> SupervisorSettings {
        self.settings.lock().clone()
    }

    fn session_info(&self, session_id: &str) -> Option<SessionInfo> {
        self.sessions.lock().get(session_id).cloned()
    }

    fn bind_session(&self, session_id: &str, pty_id: &str) -> Vec<String> {
        if !self.live_ptys.lock().contains(pty_id) {
            return Vec::new();
        }
        let mut sessions = self.sessions.lock();
        let displaced: Vec<String> = sessions
            .iter()
            .filter(|(id, info)| {
                id.as_str() != session_id && info.pty_id.as_deref() == Some(pty_id)
            })
            .map(|(id, _)| id.clone())
            .collect();
        let template = displaced.first().and_then(|id| sessions.get(id).cloned());
        for id in &displaced {
            if let Some(info) = sessions.get_mut(id) {
                info.pty_id = None;
            }
        }
        sessions
            .entry(session_id.to_string())
            .and_modify(|info| info.pty_id = Some(pty_id.to_string()))
            .or_insert_with(|| SessionInfo {
                label: format!("projekt · {session_id}"),
                project_id: template.as_ref().and_then(|info| info.project_id),
                project_path: template.and_then(|info| info.project_path),
                pty_id: Some(pty_id.to_string()),
            });
        displaced
    }

    fn type_into_pty(&self, pty_id: &str, text: &str) -> Result<(), String> {
        if self.type_fails.load(Ordering::SeqCst) {
            return Err("pty closed".into());
        }
        self.typed
            .lock()
            .push((pty_id.to_string(), format!("{text}\r")));
        Ok(())
    }

    fn input_quiet(&self, pty_id: &str, window: Duration) -> bool {
        if !self.quiet.load(Ordering::SeqCst) {
            return false;
        }
        let now = tokio::time::Instant::now().into_std();
        self.keystrokes
            .lock()
            .get(pty_id)
            .is_none_or(|last| now.saturating_duration_since(*last) >= window)
    }

    fn submitted_recently(&self, pty_id: &str, window: Duration) -> bool {
        let now = tokio::time::Instant::now().into_std();
        self.submits
            .lock()
            .get(pty_id)
            .is_some_and(|last| now.saturating_duration_since(*last) < window)
    }

    fn current_branch(&self, cwd: &Path) -> Option<String> {
        self.branch_lookups.lock().push(cwd.to_path_buf());
        self.branch.lock().clone()
    }

    fn wake_supervisor(&self) -> bool {
        self.wakes.fetch_add(1, Ordering::SeqCst);
        self.wake_accepts.load(Ordering::SeqCst)
    }

    fn publish_snapshot(&self, snapshot: SupervisorSnapshot) {
        self.snapshots.lock().push(snapshot);
    }

    fn notify_desktop(&self, session_id: &str, title: &str, body: &str) {
        self.notifications.lock().push((
            session_id.to_string(),
            title.to_string(),
            body.to_string(),
        ));
    }

    fn log_decision(&self, entry: NewDecision) {
        self.decisions.lock().push(entry);
    }

    fn list_sessions(&self) -> Vec<SessionListing> {
        self.listings.lock().clone()
    }

    fn read_session(&self, session_id: &str, max_blocks: usize) -> Option<String> {
        self.reads.lock().push((session_id.to_string(), max_blocks));
        self.transcripts.lock().get(session_id).cloned()
    }

    fn open_session(&self, project_path: &str, prompt: &str) -> Result<(), String> {
        if let Some(error) = self.open_error.lock().clone() {
            return Err(error);
        }
        self.opened
            .lock()
            .push((project_path.to_string(), prompt.to_string()));
        Ok(())
    }
}

pub(crate) fn setup() -> (Arc<FakeEffects>, Arc<SupervisorCore>) {
    let effects = FakeEffects::new();
    let core = SupervisorCore::new(effects.clone());
    core.set_supervisor_state(true, true, Some("pty-supervisor".into()));
    (effects, core)
}

pub(crate) fn hook(session_id: &str, event: &str) -> HookInput {
    HookInput {
        session_id: session_id.to_string(),
        hook_event_name: event.to_string(),
        cwd: Some("/projects".into()),
        prompt: None,
        last_assistant_message: None,
        tool_name: None,
        tool_input: None,
        source: None,
        stop_hook_active: None,
        pty_id: None,
    }
}

pub(crate) fn stop(session_id: &str, text: &str) -> HookInput {
    HookInput {
        last_assistant_message: Some(text.to_string()),
        ..hook(session_id, "Stop")
    }
}

pub(crate) fn prompt(session_id: &str, text: &str) -> HookInput {
    HookInput {
        prompt: Some(text.to_string()),
        ..hook(session_id, "UserPromptSubmit")
    }
}

pub(crate) fn bash(session_id: &str, command: &str) -> HookInput {
    HookInput {
        tool_name: Some("Bash".into()),
        tool_input: Some(json!({ "command": command })),
        ..hook(session_id, "PreToolUse")
    }
}

pub(crate) fn menu_tool_input() -> Value {
    json!({"questions": [{
        "question": COLOR_QUESTION,
        "header": "Color",
        "multiSelect": false,
        "options": [{"label": "Red", "description": ""}, {"label": "Green", "description": ""}]
    }]})
}

pub(crate) fn menu(session_id: &str) -> HookInput {
    HookInput {
        tool_name: Some("AskUserQuestion".into()),
        tool_input: Some(menu_tool_input()),
        ..hook(session_id, "PreToolUse")
    }
}

pub(crate) async fn settle() {
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}

pub(crate) async fn spawn_menu(
    core: &Arc<SupervisorCore>,
    session_id: &str,
) -> JoinHandle<HookReply> {
    let core = core.clone();
    let input = menu(session_id);
    let handle = tokio::spawn(async move { core.on_session_hook(input).await });
    settle().await;
    handle
}

pub(crate) async fn reply_of(handle: JoinHandle<HookReply>) -> HookReply {
    settle().await;
    assert!(handle.is_finished(), "the held hook has not been released");
    handle.await.unwrap()
}

pub(crate) fn only_question_id(events: Vec<SupervisorEvent>) -> String {
    match events.as_slice() {
        [SupervisorEvent::Question { question_id, .. }] => question_id.clone(),
        other => panic!("expected one question event, got {other:?}"),
    }
}

pub(crate) fn answer(question: &str, label: &str) -> HashMap<String, String> {
    HashMap::from([(question.to_string(), label.to_string())])
}
