use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, Weak};
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
use crate::db::{projects_repo, settings_repo};
use crate::domain::supervisor::{SessionRebound, SupervisorLevel, SupervisorSnapshot};
use crate::domain::SessionActivity;
use crate::error::AppResult;
use crate::notifications::marker::MarkerFilter;
use crate::notifications::AttentionEvent;
use crate::pty::input_activity::InputActivity;
use crate::pty::session_registry::{SessionClaim, SessionPtyRegistry};
use crate::pty::PtyManager;
use crate::sessions::reader::now_ms;
use crate::state::AppState;
use crate::supervisor::claude_md::WAKE_TEXT;
use crate::supervisor::core::{cap_bytes, SupervisorCore, QUIET_WINDOW};
use crate::supervisor::discord::client::DiscordClient;
use crate::supervisor::discord::files::DiscordFiles;
use crate::supervisor::discord::jobs::{ButtonsHandle, ERROR_BUTTONS_OFFLINE};
use crate::supervisor::discord::poll::{poll_approvals, POLL_INTERVAL};
use crate::supervisor::discord::registry::{KeyAnswer, PostRequest, PostResult};
use crate::supervisor::discord::DiscordLink;
use crate::supervisor::effects::{DiscordSync, Effects, SessionInfo, SessionListing};
use crate::supervisor::process::{claude_home, SupervisorProcess};
use crate::supervisor::settings::{SupervisorSettings, DISCORD_CHAT_ID_KEY};
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
const SESSION_REBOUND_EVENT: &str = "supervisor:session-rebound";
const ATTENTION_REASON: &str = "hook";
const SUBMIT_KEY: &[u8] = b"\r";
const SHORT_ID_CHARS: usize = 8;
#[cfg(unix)]
const SESSION_START_EVENT: &str = "SessionStart";
const ERROR_NOT_A_DIRECTORY: &str =
    "Ścieżka projektu musi być bezwzględną ścieżką istniejącego katalogu";
const ERROR_PROMPT_SIZE: &str = "Polecenie musi być niepuste, bez znaku NUL i mieć najwyżej";
const ERROR_UNREGISTERED_PROJECT: &str =
    "Sesję można otworzyć tylko w projekcie zarejestrowanym w AbeonCode";

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

fn is_registered_project(registered: &[String], project_path: &str) -> bool {
    let wanted = Path::new(project_path);
    registered
        .iter()
        .any(|path| same_directory(Path::new(path), wanted))
}

fn typed_text(text: &str) -> String {
    cap_bytes(&neutralize_controls(text), MAX_INITIAL_PROMPT_BYTES)
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
    process: OnceLock<Weak<SupervisorProcess>>,
    buttons: OnceLock<ButtonsHandle>,
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
            process: OnceLock::new(),
            buttons: OnceLock::new(),
            app,
        }
    }

    pub fn set_buttons(&self, handle: ButtonsHandle) {
        let _ = self.buttons.set(handle);
    }

    fn supervisor_process(&self) -> Option<Arc<SupervisorProcess>> {
        self.process.get().and_then(Weak::upgrade)
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

    fn bind_session(&self, session_id: &str, pty_id: &str, submitted: bool) -> SessionClaim {
        if crate::validation::validate_session_id(session_id).is_err() || !self.pty.contains(pty_id)
        {
            return SessionClaim::Refused;
        }
        self.session_pty.claim(session_id, pty_id, submitted)
    }

    fn session_rebound(&self, rebound: SessionRebound) {
        if let Err(error) = self.app.emit(SESSION_REBOUND_EVENT, rebound) {
            eprintln!("supervisor: session rebound emit failed: {error}");
        }
    }

    fn type_into_pty(&self, pty_id: &str, text: &str) -> Result<(), String> {
        self.pty
            .write(pty_id, typed_text(text).as_bytes())
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
        let Some(pty_id) = self
            .supervisor_process()
            .and_then(|process| process.ready_pty())
        else {
            return false;
        };
        if !self.input_quiet(&pty_id, QUIET_WINDOW) {
            return false;
        }
        match self.type_into_pty(&pty_id, WAKE_TEXT) {
            Ok(()) => true,
            Err(error) => {
                eprintln!("supervisor: wake-up for pty {pty_id} failed: {error}");
                false
            }
        }
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

    fn attention(&self, session_id: &str, message: &str) {
        crate::notifications::emit_attention(
            &self.app,
            AttentionEvent {
                session_id: session_id.to_string(),
                reason: ATTENTION_REASON.to_string(),
                message: Some(message.to_string()),
            },
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
        let registered: Vec<String> = self
            .db
            .get()
            .map_err(|error| error.to_string())
            .and_then(|conn| projects_repo::list(&conn).map_err(|error| error.to_string()))?
            .into_iter()
            .map(|project| project.path)
            .collect();
        if !is_registered_project(&registered, project_path) {
            return Err(format!("{ERROR_UNREGISTERED_PROJECT}: {project_path}"));
        }
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

    fn discord_sync(&self, change: DiscordSync) {
        if let Some(buttons) = self.buttons.get() {
            buttons.sync(change);
        }
    }

    fn discord_post(&self, request: PostRequest) -> Result<PostResult, String> {
        match self.buttons.get() {
            Some(buttons) => buttons.post(request),
            None => Err(ERROR_BUTTONS_OFFLINE.to_string()),
        }
    }

    fn discord_answered(&self, answers: Vec<KeyAnswer>) -> Result<Vec<String>, String> {
        match self.buttons.get() {
            Some(buttons) => buttons.answered(answers),
            None => Err(ERROR_BUTTONS_OFFLINE.to_string()),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct AppliedSettings {
    level: SupervisorLevel,
    discord_enabled: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Transition {
    Unchanged,
    Start,
    Stop,
    Restart,
    Refresh,
}

impl AppliedSettings {
    fn of(settings: &SupervisorSettings) -> AppliedSettings {
        AppliedSettings {
            level: settings.level,
            discord_enabled: settings.discord_enabled,
        }
    }
}

fn transition(previous: AppliedSettings, next: AppliedSettings) -> Transition {
    let was_on = previous.level != SupervisorLevel::Off;
    let is_on = next.level != SupervisorLevel::Off;
    match (was_on, is_on) {
        (false, true) => Transition::Start,
        (true, false) => Transition::Stop,
        (true, true) if previous.discord_enabled != next.discord_enabled => Transition::Restart,
        (true, true) if previous.level != next.level => Transition::Refresh,
        _ => Transition::Unchanged,
    }
}

pub struct SupervisorRuntime {
    effects: Arc<AppEffects>,
    process: Arc<SupervisorProcess>,
    active: AtomicBool,
    applied: Mutex<AppliedSettings>,
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

    fn apply_settings(&self, app: &AppHandle, core: &SupervisorCore) {
        let mut last = self.applied.lock();
        let next = AppliedSettings::of(&self.effects.reload_settings());
        let previous = std::mem::replace(&mut *last, next);
        if next.discord_enabled && !previous.discord_enabled {
            link_discord_chat(app);
        }
        match transition(previous, next) {
            Transition::Unchanged => return,
            Transition::Stop => {
                core.level_changed();
                self.process.stop(app);
                return;
            }
            Transition::Start => self.process.ensure_running(app),
            Transition::Refresh => self.process.refresh_instructions(app),
            Transition::Restart => self.process.restart(app),
        }
        if previous.level != next.level {
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
    let process = SupervisorProcess::new(core.clone());
    let _ = effects.process.set(Arc::downgrade(&process));
    let runtime = Arc::new(SupervisorRuntime {
        applied: Mutex::new(AppliedSettings::of(&effects.settings())),
        effects,
        process,
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
    link_discord_chat(&app);
    #[cfg(unix)]
    spawn_ipc(app, runtime.clone(), core.clone());
    spawn_ticks(runtime.clone(), core.clone());
    spawn_discord_approvals(runtime, core);
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

fn spawn_discord_approvals(runtime: Arc<SupervisorRuntime>, core: Arc<SupervisorCore>) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(POLL_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if !runtime.is_active() {
                break;
            }
            if core.pending_approval_codes().is_empty() {
                continue;
            }
            let settings = runtime.effects.reload_settings();
            let Some(chat_id) = settings
                .discord_chat_id
                .filter(|_| settings.discord_enabled)
            else {
                continue;
            };
            let Some(claude_home) = claude_home() else {
                continue;
            };
            let files = DiscordFiles::for_claude_home(&claude_home);
            let Some(token) = files.token() else {
                continue;
            };
            let allow_from = files.access().allow_from;
            if allow_from.is_empty() {
                continue;
            }
            let client = DiscordClient::new(token);
            if let Err(error) = poll_approvals(&client, &chat_id, &allow_from, &core).await {
                eprintln!("supervisor: discord poll failed: {error}");
            }
        }
    });
}

#[cfg(unix)]
fn spawn_ipc(app: AppHandle, runtime: Arc<SupervisorRuntime>, core: Arc<SupervisorCore>) {
    let handler: Arc<dyn IpcHandler> = Arc::new(IpcRouter {
        core,
        process: runtime.process.clone(),
    });
    tauri::async_runtime::spawn(async move {
        let listener = match ipc::bind(&ipc::socket_path()) {
            Ok(listener) => listener,
            Err(error) => {
                runtime.deactivate();
                if error.kind() == std::io::ErrorKind::AddrInUse {
                    eprintln!("supervisor: socket in use, supervisor disabled for this instance");
                } else {
                    eprintln!(
                        "supervisor: socket server failed, supervisor disabled for this instance: {error}"
                    );
                }
                return;
            }
        };
        runtime.process.mark_serving();
        let process = runtime.process.clone();
        tauri::async_runtime::spawn_blocking(move || process.ensure_running(&app));
        ipc::serve_listener(listener, handler).await;
    });
}

pub fn settings_changed(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (Some(runtime), Some(core)) = (runtime(&app), core(&app)) else {
            return;
        };
        let _ =
            tauri::async_runtime::spawn_blocking(move || runtime.apply_settings(&app, &core)).await;
    });
}

pub fn restart_supervisor(app: &AppHandle) -> AppResult<()> {
    if let Some(runtime) = runtime(app) {
        runtime.process.restart(app);
    }
    Ok(())
}

pub fn discord_link(app: &AppHandle) -> DiscordLink {
    runtime(app)
        .map(|runtime| runtime.process.discord_link())
        .unwrap_or_default()
}

pub fn new_conversation(app: &AppHandle) -> AppResult<()> {
    match runtime(app) {
        Some(runtime) => runtime.process.new_conversation(app),
        None => Ok(()),
    }
}

#[derive(PartialEq, Eq)]
struct ChatLinkRequest {
    token: String,
    recipient: String,
}

impl std::fmt::Debug for ChatLinkRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ChatLinkRequest")
            .field("token", &"***")
            .field("recipient", &self.recipient)
            .finish()
    }
}

fn chat_link_request(
    settings: &SupervisorSettings,
    files: &DiscordFiles,
) -> Option<ChatLinkRequest> {
    if !settings.discord_enabled || settings.discord_chat_id.is_some() {
        return None;
    }
    let recipient = files.access().allow_from.into_iter().next()?;
    let token = files.token()?;
    Some(ChatLinkRequest { token, recipient })
}

fn store_chat_id(db: &DbPool, chat_id: &str) -> Result<bool, String> {
    let conn = db.get().map_err(|error| error.to_string())?;
    if SupervisorSettings::load(&conn).discord_chat_id.is_some() {
        return Ok(false);
    }
    settings_repo::set(&conn, DISCORD_CHAT_ID_KEY, chat_id).map_err(|error| error.to_string())?;
    Ok(true)
}

pub fn link_discord_chat(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let db = app.state::<AppState>().db.clone();
        let reader = db.clone();
        let request = tauri::async_runtime::spawn_blocking(move || {
            let settings = load_settings(&reader)?;
            let claude_home = claude_home()?;
            chat_link_request(&settings, &DiscordFiles::for_claude_home(&claude_home))
        })
        .await
        .ok()
        .flatten();
        let Some(request) = request else {
            return;
        };
        let chat_id = match DiscordClient::new(request.token)
            .open_dm(&request.recipient)
            .await
        {
            Ok(chat_id) => chat_id,
            Err(error) => {
                eprintln!("supervisor: cannot link the Discord chat: {error}");
                return;
            }
        };
        let _ = tauri::async_runtime::spawn_blocking(move || match store_chat_id(&db, &chat_id) {
            Ok(true) => {
                let _ = restart_supervisor(&app);
            }
            Ok(false) => {}
            Err(error) => eprintln!("supervisor: cannot store the Discord chat: {error}"),
        })
        .await;
    });
}

fn same_directory(left: &Path, right: &Path) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn is_supervisor_marker(
    session_id: &str,
    cwd: Option<&Path>,
    workdir: Option<&Path>,
    supervisor_session: Option<&str>,
) -> bool {
    if supervisor_session == Some(session_id) {
        return true;
    }
    matches!((cwd, workdir), (Some(cwd), Some(workdir)) if same_directory(cwd, workdir))
}

pub fn attention_filter(app: &AppHandle) -> MarkerFilter {
    let app = app.clone();
    let workdir = workdir::supervisor_dir(&app).ok();
    Arc::new(move |session_id: &str, cwd: Option<&Path>| {
        let supervisor_session = runtime(&app).and_then(|runtime| runtime.process.session_id());
        is_supervisor_marker(
            session_id,
            cwd,
            workdir.as_deref(),
            supervisor_session.as_deref(),
        )
    })
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
    process: Arc<SupervisorProcess>,
}

#[cfg(unix)]
impl IpcHandler for IpcRouter {
    fn handle(&self, req: IpcRequest) -> Pin<Box<dyn Future<Output = IpcResponse> + Send>> {
        Box::pin(route(self.core.clone(), self.process.clone(), req))
    }
}

#[cfg(unix)]
async fn route(
    core: Arc<SupervisorCore>,
    process: Arc<SupervisorProcess>,
    req: IpcRequest,
) -> IpcResponse {
    match req {
        IpcRequest::Hook {
            channel: HookChannel::Session,
            input,
            pty_id,
        } => {
            let stdout = match serde_json::from_value::<HookInput>(input) {
                Ok(input) => core
                    .on_session_hook(HookInput { pty_id, ..input })
                    .await
                    .to_stdout(),
                Err(_) => None,
            };
            IpcResponse::Hook { stdout }
        }
        IpcRequest::Hook {
            channel: HookChannel::Supervisor,
            input,
            ..
        } => {
            let field = |name: &str| input.get(name).and_then(serde_json::Value::as_str);
            if field("hook_event_name") == Some(SESSION_START_EVENT) {
                if let Some(session_id) = field("session_id") {
                    process.mark_ready(session_id);
                }
            }
            IpcResponse::Hook { stdout: None }
        }
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
    fn only_registered_project_directories_can_be_opened() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("app");
        let nested = project.join("src");
        let other = root.path().join("other");
        for dir in [&nested, &other] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let registered = vec![project.to_string_lossy().to_string()];
        let path = |dir: &Path| dir.to_string_lossy().to_string();
        assert!(is_registered_project(&registered, &path(&project)));
        assert!(is_registered_project(
            &registered,
            &format!("{}/", path(&project))
        ));
        assert!(is_registered_project(
            &registered,
            &path(&nested.join(".."))
        ));
        assert!(!is_registered_project(&registered, &path(&nested)));
        assert!(!is_registered_project(&registered, &path(&other)));
        assert!(!is_registered_project(&[], &path(&project)));
        #[cfg(unix)]
        {
            let link = root.path().join("link");
            std::os::unix::fs::symlink(&project, &link).unwrap();
            assert!(is_registered_project(&registered, &path(&link)));
        }
    }

    #[test]
    fn typed_text_is_capped_without_control_characters() {
        let typed = typed_text(&format!("a\r{}", "ż".repeat(MAX_INITIAL_PROMPT_BYTES)));
        assert!(typed.len() <= MAX_INITIAL_PROMPT_BYTES);
        assert!(typed.starts_with("a ż"));
        assert!(typed.ends_with('…'));
        assert_eq!(typed_text("tak\x1b[A"), "tak [A");
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
    fn supervisor_markers_are_recognised_by_session_or_workdir() {
        let root = tempfile::tempdir().unwrap();
        let workdir = root.path().join("supervisor");
        std::fs::create_dir_all(&workdir).unwrap();
        let other = root.path().join("project");
        std::fs::create_dir_all(&other).unwrap();
        let dotted = root.path().join("project").join("..").join("supervisor");

        assert!(is_supervisor_marker(
            "sup",
            None,
            Some(&workdir),
            Some("sup")
        ));
        assert!(is_supervisor_marker(
            "cleared",
            Some(&dotted),
            Some(&workdir),
            Some("sup")
        ));
        assert!(is_supervisor_marker(
            "cleared",
            Some(&workdir),
            Some(&workdir),
            None
        ));
        assert!(!is_supervisor_marker(
            "worker",
            Some(&other),
            Some(&workdir),
            Some("sup")
        ));
        assert!(!is_supervisor_marker(
            "worker",
            None,
            Some(&workdir),
            Some("sup")
        ));
        assert!(!is_supervisor_marker("worker", Some(&workdir), None, None));
        assert!(!is_supervisor_marker(
            "worker",
            Some(&other),
            Some(&workdir),
            None
        ));

        #[cfg(unix)]
        {
            let link = root.path().join("link");
            std::os::unix::fs::symlink(&workdir, &link).unwrap();
            assert!(is_supervisor_marker(
                "worker",
                Some(&link),
                Some(&workdir),
                None
            ));
        }
        let missing = root.path().join("gone");
        assert!(is_supervisor_marker(
            "worker",
            Some(&missing),
            Some(&missing),
            None
        ));
    }

    fn applied(level: SupervisorLevel, discord_enabled: bool) -> AppliedSettings {
        AppliedSettings {
            level,
            discord_enabled,
        }
    }

    #[test]
    fn transition_starts_and_stops_with_the_level() {
        use SupervisorLevel::{Assistant, Off, Relay};
        assert_eq!(
            transition(applied(Off, false), applied(Assistant, false)),
            Transition::Start
        );
        assert_eq!(
            transition(applied(Off, false), applied(Relay, true)),
            Transition::Start
        );
        assert_eq!(
            transition(applied(Assistant, false), applied(Off, false)),
            Transition::Stop
        );
        assert_eq!(
            transition(applied(Relay, false), applied(Off, true)),
            Transition::Stop
        );
    }

    #[test]
    fn transition_restarts_when_discord_toggles() {
        use SupervisorLevel::{Assistant, Autonomous};
        assert_eq!(
            transition(applied(Assistant, false), applied(Assistant, true)),
            Transition::Restart
        );
        assert_eq!(
            transition(applied(Assistant, true), applied(Assistant, false)),
            Transition::Restart
        );
        assert_eq!(
            transition(applied(Assistant, false), applied(Autonomous, true)),
            Transition::Restart
        );
    }

    #[test]
    fn transition_refreshes_on_level_change_only() {
        use SupervisorLevel::{Assistant, Relay};
        assert_eq!(
            transition(applied(Assistant, false), applied(Relay, false)),
            Transition::Refresh
        );
        assert_eq!(
            transition(applied(Assistant, true), applied(Relay, true)),
            Transition::Refresh
        );
    }

    #[test]
    fn transition_ignores_unrelated_changes() {
        use SupervisorLevel::{Assistant, Off};
        assert_eq!(
            transition(applied(Assistant, true), applied(Assistant, true)),
            Transition::Unchanged
        );
        assert_eq!(
            transition(applied(Off, false), applied(Off, false)),
            Transition::Unchanged
        );
        assert_eq!(
            transition(applied(Off, false), applied(Off, true)),
            Transition::Unchanged
        );
    }

    fn link_settings(enabled: bool, chat_id: Option<&str>) -> SupervisorSettings {
        SupervisorSettings {
            discord_enabled: enabled,
            discord_chat_id: chat_id.map(str::to_string),
            ..SupervisorSettings::default()
        }
    }

    #[test]
    fn chat_link_needs_discord_on_a_paired_user_a_token_and_no_chat() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("discord");
        std::fs::create_dir_all(&dir).unwrap();
        let files = DiscordFiles::new(dir.clone());
        let ready = link_settings(true, None);
        assert_eq!(chat_link_request(&ready, &files), None);

        std::fs::write(
            dir.join("access.json"),
            r#"{"dmPolicy":"allowlist","allowFrom":["user-1","user-2"],"pending":{}}"#,
        )
        .unwrap();
        assert_eq!(chat_link_request(&ready, &files), None);

        std::fs::write(dir.join(".env"), "DISCORD_BOT_TOKEN=secret\n").unwrap();
        assert_eq!(
            chat_link_request(&ready, &files),
            Some(ChatLinkRequest {
                token: "secret".to_string(),
                recipient: "user-1".to_string(),
            })
        );
        assert_eq!(chat_link_request(&link_settings(false, None), &files), None);
        assert_eq!(
            chat_link_request(&link_settings(true, Some("dm-1")), &files),
            None
        );

        std::fs::write(dir.join("access.json"), r#"{"allowFrom":[]}"#).unwrap();
        assert_eq!(chat_link_request(&ready, &files), None);
    }

    #[test]
    fn chat_link_request_debug_hides_the_token() {
        let request = ChatLinkRequest {
            token: "secret-bot-token".to_string(),
            recipient: "user-1".to_string(),
        };
        let printed = format!("{request:?}");
        assert!(!printed.contains("secret-bot-token"), "{printed}");
        assert!(printed.contains("***"), "{printed}");
        assert!(printed.contains("user-1"), "{printed}");
    }

    #[test]
    fn chat_id_is_stored_once() {
        let root = tempfile::tempdir().unwrap();
        let db = crate::db::init_pool(&root.path().join("abeoncode.db")).unwrap();
        assert_eq!(store_chat_id(&db, "dm-1"), Ok(true));
        assert_eq!(store_chat_id(&db, "dm-2"), Ok(false));
        let conn = db.get().unwrap();
        assert_eq!(
            SupervisorSettings::load(&conn).discord_chat_id.as_deref(),
            Some("dm-1")
        );
    }

    #[test]
    fn activity_names_match_the_frontend() {
        assert_eq!(activity_name(SessionActivity::WaitingUser), "waitingUser");
        assert_eq!(activity_name(SessionActivity::Running), "running");
    }

    #[cfg(unix)]
    mod ipc_router {
        use super::super::*;
        use crate::supervisor::process::SupervisorSessionArg;
        use crate::supervisor::test_support::{setup, FakeEffects};
        use serde_json::{json, Value};

        async fn route_to(core: &Arc<SupervisorCore>, req: IpcRequest) -> IpcResponse {
            route(core.clone(), SupervisorProcess::new(core.clone()), req).await
        }

        fn supervisor_hook(event: &str) -> IpcRequest {
            IpcRequest::Hook {
                channel: HookChannel::Supervisor,
                input: json!({ "hook_event_name": event, "session_id": "sup" }),
                pty_id: None,
            }
        }

        fn hook(input: Value) -> IpcRequest {
            IpcRequest::Hook {
                channel: HookChannel::Session,
                input,
                pty_id: None,
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
            match route_to(core, hook(input)).await {
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
        async fn session_hooks_bind_the_reported_terminal() {
            let (effects, core) = setup();
            effects.submit("pty-s1");
            let request = IpcRequest::Hook {
                channel: HookChannel::Session,
                input: json!({
                    "session_id": "s3",
                    "hook_event_name": "SessionStart",
                    "pty_id": "pty-forged",
                }),
                pty_id: Some("pty-s1".into()),
            };
            assert_eq!(
                route_to(&core, request).await,
                IpcResponse::Hook { stdout: None }
            );
            assert_eq!(
                effects.session_info("s3").and_then(|info| info.pty_id),
                Some("pty-s1".to_string())
            );
            assert_eq!(
                effects.session_info("s1").and_then(|info| info.pty_id),
                None
            );
        }

        #[tokio::test]
        async fn supervisor_session_start_marks_ready_and_replies_empty() {
            let (_effects, core) = setup();
            core.set_supervisor_state(false, false, None);
            let process = SupervisorProcess::new(core.clone());
            let response = route(
                core.clone(),
                process.clone(),
                supervisor_hook("SessionStart"),
            )
            .await;
            assert_eq!(response, IpcResponse::Hook { stdout: None });
            assert!(!core.snapshot().ready);

            process.attach(
                "pty-supervisor".into(),
                SupervisorSessionArg::Fresh("sup".into()),
            );
            let foreign = IpcRequest::Hook {
                channel: HookChannel::Supervisor,
                input: json!({ "hook_event_name": "SessionStart", "session_id": "killed" }),
                pty_id: None,
            };
            let response = route(core.clone(), process.clone(), foreign).await;
            assert_eq!(response, IpcResponse::Hook { stdout: None });
            assert!(!process.is_ready());
            let anonymous = IpcRequest::Hook {
                channel: HookChannel::Supervisor,
                input: json!({ "hook_event_name": "SessionStart" }),
                pty_id: None,
            };
            route(core.clone(), process.clone(), anonymous).await;
            assert!(!process.is_ready());
            let response = route(core.clone(), process.clone(), supervisor_hook("Stop")).await;
            assert_eq!(response, IpcResponse::Hook { stdout: None });
            assert!(!process.is_ready());
            assert!(!core.snapshot().ready);

            let response = route(
                core.clone(),
                process.clone(),
                supervisor_hook("SessionStart"),
            )
            .await;
            assert_eq!(response, IpcResponse::Hook { stdout: None });
            assert!(process.is_ready());
            let snapshot = core.snapshot();
            assert!(snapshot.running && snapshot.ready);
            assert_eq!(snapshot.pty_id.as_deref(), Some("pty-supervisor"));
        }

        #[tokio::test]
        async fn tools_run_and_report_errors_as_text() {
            let (_effects, core) = setup();
            let listed = route_to(
                &core,
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
            let unknown = route_to(
                &core,
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
