use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager};

use crate::cli::request::OpenRequest;
use crate::commands::pty::MAX_INITIAL_PROMPT_BYTES;
use crate::commands::sessions::{
    active_sessions_snapshot, history_blocks_for_session, locate_session,
};
use crate::db::supervisor_decisions_repo::{self, NewDecision};
use crate::db::DbPool;
use crate::domain::supervisor::{SupervisorLevel, SupervisorSnapshot};
use crate::domain::SessionActivity;
use crate::pty::input_activity::InputActivity;
use crate::pty::session_registry::SessionPtyRegistry;
use crate::pty::PtyManager;
use crate::sessions::reader::now_ms;
use crate::state::AppState;
use crate::supervisor::core::SupervisorCore;
use crate::supervisor::effects::{Effects, SessionInfo, SessionListing};
use crate::supervisor::settings::SupervisorSettings;
use crate::supervisor::{transcript, workdir};

#[cfg(unix)]
use crate::supervisor::hook_io::HookInput;
#[cfg(unix)]
use crate::supervisor::ipc::{self, HookChannel, IpcHandler, IpcRequest, IpcResponse};
#[cfg(unix)]
use crate::supervisor::tools::handle_tool;
#[cfg(unix)]
use std::future::Future;
#[cfg(unix)]
use std::pin::Pin;

const TICK_INTERVAL: Duration = Duration::from_secs(1);
const SUBMIT_DELAY: Duration = Duration::from_millis(250);
const KNOWN_OWNER_TTL: Duration = Duration::from_secs(60);
const UNKNOWN_OWNER_TTL: Duration = Duration::from_secs(5);
const TRANSCRIPT_CHARS: usize = 20_000;
const DECISION_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const SNAPSHOT_EVENT: &str = "supervisor:snapshot";
const SUBMIT_KEY: &[u8] = b"\r";
const SHORT_ID_CHARS: usize = 8;
const ERROR_NOT_A_DIRECTORY: &str =
    "Ścieżka projektu musi być bezwzględną ścieżką istniejącego katalogu";
const ERROR_PROMPT_SIZE: &str = "Polecenie musi być niepuste, bez znaku NUL i mieć najwyżej";

fn session_label(project_name: &str, title: &str) -> String {
    format!("{project_name} · {title}")
}

fn fallback_label(session_id: &str) -> String {
    format!(
        "Sesja {}",
        session_id.chars().take(SHORT_ID_CHARS).collect::<String>()
    )
}

fn neutralize_controls(text: &str) -> String {
    text.chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect()
}

fn check_open_request(project_path: &str, prompt: &str) -> Result<(), String> {
    let path = Path::new(project_path);
    if !path.is_absolute() || !path.is_dir() {
        return Err(format!("{ERROR_NOT_A_DIRECTORY}: {project_path}"));
    }
    if prompt.trim().is_empty() || prompt.contains('\0') || prompt.len() > MAX_INITIAL_PROMPT_BYTES
    {
        return Err(format!(
            "{ERROR_PROMPT_SIZE} {MAX_INITIAL_PROMPT_BYTES} bajtów"
        ));
    }
    Ok(())
}

fn activity_name(activity: SessionActivity) -> String {
    serde_json::to_value(activity)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default()
}

fn load_settings(db: &DbPool) -> Option<SupervisorSettings> {
    db.get().ok().map(|conn| SupervisorSettings::load(&conn))
}

#[derive(Clone)]
struct SessionOwner {
    label: String,
    project_id: i64,
    project_path: String,
}

struct CachedOwner {
    owner: Option<SessionOwner>,
    resolved: Instant,
}

impl CachedOwner {
    fn fresh(&self, now: Instant) -> bool {
        let ttl = if self.owner.is_some() {
            KNOWN_OWNER_TTL
        } else {
            UNKNOWN_OWNER_TTL
        };
        now.saturating_duration_since(self.resolved) < ttl
    }
}

pub struct AppEffects {
    app: AppHandle,
    db: DbPool,
    pty: Arc<PtyManager>,
    session_pty: Arc<SessionPtyRegistry>,
    input_activity: Arc<InputActivity>,
    settings: Mutex<SupervisorSettings>,
    owners: Mutex<HashMap<String, CachedOwner>>,
}

impl AppEffects {
    fn new(app: AppHandle, state: &AppState) -> AppEffects {
        AppEffects {
            settings: Mutex::new(load_settings(&state.db).unwrap_or_default()),
            db: state.db.clone(),
            pty: state.pty.clone(),
            session_pty: state.session_pty.clone(),
            input_activity: state.input_activity.clone(),
            owners: Mutex::new(HashMap::new()),
            app,
        }
    }

    fn reload_settings(&self) -> SupervisorSettings {
        if let Some(settings) = load_settings(&self.db) {
            *self.settings.lock() = settings;
        }
        self.settings()
    }

    fn owner(&self, session_id: &str) -> Option<SessionOwner> {
        let now = Instant::now();
        if let Some(cached) = self
            .owners
            .lock()
            .get(session_id)
            .filter(|cached| cached.fresh(now))
        {
            return cached.owner.clone();
        }
        let owner = self.db.get().ok().and_then(|conn| {
            locate_session(&conn, session_id).map(|found| SessionOwner {
                label: session_label(&found.project.name, &found.title),
                project_id: found.project.id,
                project_path: found.project.path,
            })
        });
        let mut owners = self.owners.lock();
        owners.retain(|_, cached| cached.fresh(now));
        owners.insert(
            session_id.to_string(),
            CachedOwner {
                owner: owner.clone(),
                resolved: now,
            },
        );
        owner
    }
}

impl Effects for AppEffects {
    fn settings(&self) -> SupervisorSettings {
        self.settings.lock().clone()
    }

    fn session_info(&self, session_id: &str) -> Option<SessionInfo> {
        let pty_id = self.session_pty.pty_for(session_id);
        let owner = self.owner(session_id);
        if pty_id.is_none() && owner.is_none() {
            return None;
        }
        Some(match owner {
            Some(owner) => SessionInfo {
                label: owner.label,
                project_id: Some(owner.project_id),
                project_path: Some(owner.project_path),
                pty_id,
            },
            None => SessionInfo {
                label: fallback_label(session_id),
                project_id: None,
                project_path: None,
                pty_id,
            },
        })
    }

    fn type_into_pty(&self, pty_id: &str, text: &str) -> Result<(), String> {
        self.pty
            .write(pty_id, neutralize_controls(text).as_bytes())
            .map_err(|error| error.to_string())?;
        let pty = self.pty.clone();
        let pty_id = pty_id.to_string();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(SUBMIT_DELAY).await;
            if let Err(error) = pty.write(&pty_id, SUBMIT_KEY) {
                eprintln!("supervisor: submit keystroke for pty {pty_id} failed: {error}");
            }
        });
        Ok(())
    }

    fn input_quiet(&self, pty_id: &str, window: Duration) -> bool {
        self.input_activity.quiet_for(pty_id, window)
    }

    fn submitted_recently(&self, pty_id: &str, window: Duration) -> bool {
        self.input_activity.submitted_within(pty_id, window)
    }

    fn current_branch(&self, cwd: &Path) -> Option<String> {
        let repository = git2::Repository::discover(cwd).ok()?;
        let head = repository.head().ok()?;
        head.shorthand().map(str::to_string)
    }

    fn wake_supervisor(&self) -> bool {
        false
    }

    fn publish_snapshot(&self, snapshot: SupervisorSnapshot) {
        if let Err(error) = self.app.emit(SNAPSHOT_EVENT, snapshot) {
            eprintln!("supervisor: snapshot emit failed: {error}");
        }
    }

    fn notify_desktop(&self, session_id: &str, title: &str, body: &str) {
        crate::notifications::desktop::show_attention_notification(
            &self.app,
            session_id.to_string(),
            title.to_string(),
            body.to_string(),
        );
    }

    fn log_decision(&self, entry: NewDecision) {
        let outcome = self
            .db
            .get()
            .map_err(|error| error.to_string())
            .and_then(|conn| {
                supervisor_decisions_repo::insert(&conn, &entry).map_err(|error| error.to_string())
            });
        if let Err(error) = outcome {
            eprintln!("supervisor: decision log insert failed: {error}");
        }
    }

    fn list_sessions(&self) -> Vec<SessionListing> {
        let Ok(conn) = self.db.get() else {
            return Vec::new();
        };
        let Ok(active) = active_sessions_snapshot(&conn) else {
            return Vec::new();
        };
        active
            .into_iter()
            .map(|session| SessionListing {
                controllable: self.session_pty.pty_for(&session.session_id).is_some(),
                label: session_label(&session.project_name, &session.title),
                provider: session.provider.id().to_string(),
                activity: activity_name(session.activity),
                session_id: session.session_id,
                pending_question_id: None,
            })
            .collect()
    }

    fn read_session(&self, session_id: &str, max_blocks: usize) -> Option<String> {
        let conn = self.db.get().ok()?;
        let blocks = history_blocks_for_session(&conn, session_id);
        if blocks.is_empty() {
            return None;
        }
        Some(transcript::render(&blocks, max_blocks, TRANSCRIPT_CHARS))
    }

    fn open_session(&self, project_path: &str, prompt: &str) -> Result<(), String> {
        check_open_request(project_path, prompt)?;
        crate::cli::dispatch_open(
            &self.app,
            OpenRequest {
                path: project_path.to_string(),
                initial_prompt: Some(prompt.to_string()),
                background: true,
            },
        );
        Ok(())
    }
}

pub struct SupervisorRuntime {
    effects: Arc<AppEffects>,
    active: AtomicBool,
    level: Mutex<SupervisorLevel>,
    session_hooks: Mutex<Option<PathBuf>>,
}

impl SupervisorRuntime {
    fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    #[cfg(unix)]
    fn deactivate(&self) {
        self.active.store(false, Ordering::SeqCst);
    }

    fn session_hooks(&self, app: &AppHandle) -> Option<PathBuf> {
        let mut written = self.session_hooks.lock();
        if written.is_none() {
            *written = write_session_hooks(app);
        }
        written.clone()
    }

    fn apply_settings(&self, core: &SupervisorCore) {
        let level_changed = {
            let mut last = self.level.lock();
            let level = self.effects.reload_settings().level;
            std::mem::replace(&mut *last, level) != level
        };
        if level_changed {
            core.level_changed();
        }
    }
}

fn write_session_hooks(app: &AppHandle) -> Option<PathBuf> {
    let outcome = workdir::supervisor_dir(app)
        .map_err(|error| error.to_string())
        .and_then(|dir| {
            let exe = std::env::current_exe().map_err(|error| error.to_string())?;
            workdir::write_session_hooks(&dir, &exe).map_err(|error| error.to_string())
        });
    match outcome {
        Ok(path) => Some(path),
        Err(error) => {
            eprintln!("supervisor: cannot write session hooks: {error}");
            None
        }
    }
}

fn runtime(app: &AppHandle) -> Option<Arc<SupervisorRuntime>> {
    app.try_state::<Arc<SupervisorRuntime>>()
        .map(|runtime| runtime.inner().clone())
}

fn core(app: &AppHandle) -> Option<Arc<SupervisorCore>> {
    let state = app.try_state::<AppState>()?;
    let core = state.supervisor.lock().clone();
    core
}

pub fn start(app: AppHandle) {
    let state = app.state::<AppState>();
    let effects = Arc::new(AppEffects::new(app.clone(), &state));
    let core = SupervisorCore::new(effects.clone());
    *state.supervisor.lock() = Some(core.clone());
    let runtime = Arc::new(SupervisorRuntime {
        level: Mutex::new(effects.settings().level),
        effects,
        active: AtomicBool::new(cfg!(unix)),
        session_hooks: Mutex::new(None),
    });
    app.manage(runtime.clone());
    spawn_prune(state.db.clone());
    if !runtime.is_active() {
        return;
    }
    let hooks_runtime = runtime.clone();
    let hooks_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        hooks_runtime.session_hooks(&hooks_app);
    });
    #[cfg(unix)]
    spawn_ipc(runtime.clone(), core.clone());
    spawn_ticks(runtime, core);
}

fn spawn_prune(db: DbPool) {
    tauri::async_runtime::spawn_blocking(move || {
        let cutoff = now_ms() - DECISION_RETENTION_MS;
        let outcome = db
            .get()
            .map_err(|error| error.to_string())
            .and_then(|conn| {
                supervisor_decisions_repo::prune_older_than(&conn, cutoff)
                    .map_err(|error| error.to_string())
            });
        if let Err(error) = outcome {
            eprintln!("supervisor: decision log prune failed: {error}");
        }
    });
}

fn spawn_ticks(runtime: Arc<SupervisorRuntime>, core: Arc<SupervisorCore>) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(TICK_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if !runtime.is_active() {
                break;
            }
            let core = core.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || core.tick()).await;
        }
    });
}

#[cfg(unix)]
fn spawn_ipc(runtime: Arc<SupervisorRuntime>, core: Arc<SupervisorCore>) {
    let handler: Arc<dyn IpcHandler> = Arc::new(IpcRouter { core });
    tauri::async_runtime::spawn(async move {
        let Err(error) = ipc::serve(ipc::socket_path(), handler).await else {
            return;
        };
        runtime.deactivate();
        if error.kind() == std::io::ErrorKind::AddrInUse {
            eprintln!("supervisor: socket in use, supervisor disabled for this instance");
        } else {
            eprintln!(
                "supervisor: socket server failed, supervisor disabled for this instance: {error}"
            );
        }
    });
}

pub fn settings_changed(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (Some(runtime), Some(core)) = (runtime(&app), core(&app)) else {
            return;
        };
        let _ = tauri::async_runtime::spawn_blocking(move || runtime.apply_settings(&core)).await;
    });
}

pub fn session_hooks_path(app: &AppHandle) -> Option<PathBuf> {
    let runtime = runtime(app)?;
    if !runtime.is_active() || runtime.effects.settings().level == SupervisorLevel::Off {
        return None;
    }
    runtime.session_hooks(app)
}

#[cfg(unix)]
struct IpcRouter {
    core: Arc<SupervisorCore>,
}

#[cfg(unix)]
impl IpcHandler for IpcRouter {
    fn handle(&self, req: IpcRequest) -> Pin<Box<dyn Future<Output = IpcResponse> + Send>> {
        Box::pin(route(self.core.clone(), req))
    }
}

#[cfg(unix)]
async fn route(core: Arc<SupervisorCore>, req: IpcRequest) -> IpcResponse {
    match req {
        IpcRequest::Hook {
            channel: HookChannel::Session,
            input,
        } => {
            let stdout = match serde_json::from_value::<HookInput>(input) {
                Ok(input) => core.on_session_hook(input).await.to_stdout(),
                Err(_) => None,
            };
            IpcResponse::Hook { stdout }
        }
        IpcRequest::Hook {
            channel: HookChannel::Supervisor,
            ..
        } => IpcResponse::Hook { stdout: None },
        IpcRequest::Tool { name, args } => {
            let outcome = tokio::task::spawn_blocking(move || handle_tool(&core, &name, args))
                .await
                .unwrap_or_else(|error| Err(error.to_string()));
            match outcome {
                Ok(result) => IpcResponse::Tool { ok: true, result },
                Err(error) => IpcResponse::Tool {
                    ok: false,
                    result: serde_json::Value::String(error),
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_join_project_and_title() {
        assert_eq!(
            session_label("AbeonCode", "Napraw hooki"),
            "AbeonCode · Napraw hooki"
        );
        assert_eq!(fallback_label("0123456789abcdef"), "Sesja 01234567");
        assert_eq!(fallback_label("abc"), "Sesja abc");
    }

    #[test]
    fn typed_text_has_no_control_characters() {
        assert_eq!(
            neutralize_controls("tak\r\nnie\x1b[A\tkoniec\u{7f}"),
            "tak  nie [A koniec "
        );
        assert_eq!(
            neutralize_controls("zażółć gęślą jaźń"),
            "zażółć gęślą jaźń"
        );
    }

    #[test]
    fn open_request_needs_an_absolute_directory_and_a_bounded_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let dir_path = dir.path().to_str().unwrap();
        let file = dir.path().join("file.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(check_open_request(dir_path, "zrób to").is_ok());
        assert!(check_open_request(dir_path, &"a".repeat(MAX_INITIAL_PROMPT_BYTES)).is_ok());
        assert!(check_open_request(dir_path, &"a".repeat(MAX_INITIAL_PROMPT_BYTES + 1)).is_err());
        assert!(check_open_request(dir_path, "  \n").is_err());
        assert!(check_open_request(dir_path, "a\0b").is_err());
        assert!(check_open_request(file.to_str().unwrap(), "zrób to").is_err());
        assert!(check_open_request("relative/dir", "zrób to").is_err());
        assert!(check_open_request(&dir.path().join("missing").to_string_lossy(), "x").is_err());
    }

    #[test]
    fn activity_names_match_the_frontend() {
        assert_eq!(activity_name(SessionActivity::WaitingUser), "waitingUser");
        assert_eq!(activity_name(SessionActivity::Running), "running");
    }

    #[cfg(unix)]
    mod ipc_router {
        use super::super::*;
        use crate::supervisor::test_support::{setup, FakeEffects};
        use serde_json::{json, Value};

        fn hook(input: Value) -> IpcRequest {
            IpcRequest::Hook {
                channel: HookChannel::Session,
                input,
            }
        }

        fn session_hook(event: &str, extra: Value) -> Value {
            let mut input = json!({
                "session_id": "s1",
                "hook_event_name": event,
                "cwd": "/projects/s1",
            });
            for (key, value) in extra.as_object().unwrap() {
                input[key] = value.clone();
            }
            input
        }

        async fn hook_stdout(core: &Arc<SupervisorCore>, input: Value) -> Option<String> {
            match route(core.clone(), hook(input)).await {
                IpcResponse::Hook { stdout } => stdout,
                other => panic!("expected a hook response, got {other:?}"),
            }
        }

        #[tokio::test]
        async fn session_hooks_reach_the_core() {
            let (_effects, core): (Arc<FakeEffects>, _) = setup();
            assert_eq!(
                hook_stdout(&core, json!({ "unexpected": true })).await,
                None
            );
            let prompt = session_hook("UserPromptSubmit", json!({ "prompt": "wypchnij zmiany" }));
            assert_eq!(hook_stdout(&core, prompt).await, None);
            let push = session_hook(
                "PreToolUse",
                json!({ "tool_name": "Bash", "tool_input": { "command": "git push origin main" } }),
            );
            let stdout = hook_stdout(&core, push).await.expect("guard reply");
            let reply: Value = serde_json::from_str(&stdout).unwrap();
            assert_eq!(reply["hookSpecificOutput"]["permissionDecision"], "deny");
        }

        #[tokio::test]
        async fn supervisor_channel_replies_empty() {
            let (_effects, core) = setup();
            let response = route(
                core,
                IpcRequest::Hook {
                    channel: HookChannel::Supervisor,
                    input: json!({ "hook_event_name": "SessionStart" }),
                },
            )
            .await;
            assert_eq!(response, IpcResponse::Hook { stdout: None });
        }

        #[tokio::test]
        async fn tools_run_and_report_errors_as_text() {
            let (_effects, core) = setup();
            let listed = route(
                core.clone(),
                IpcRequest::Tool {
                    name: "list_sessions".into(),
                    args: json!({}),
                },
            )
            .await;
            assert_eq!(
                listed,
                IpcResponse::Tool {
                    ok: true,
                    result: json!({ "sessions": [] })
                }
            );
            let unknown = route(
                core,
                IpcRequest::Tool {
                    name: "drop_tables".into(),
                    args: json!({}),
                },
            )
            .await;
            match unknown {
                IpcResponse::Tool {
                    ok: false,
                    result: Value::String(error),
                } => assert!(error.contains("drop_tables"), "{error}"),
                other => panic!("expected a tool error, got {other:?}"),
            }
        }
    }
}
