use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::cli::installer::CALLER_SESSION_ENV_VARS;
use crate::commands::pty::shell_single_quote;
use crate::commands::settings::{ensure_shell_env, resolve_shell};
use crate::db::{projects_repo, settings_repo};
use crate::domain::supervisor::SupervisorLevel;
use crate::error::AppResult;
use crate::sessions::encoding::encode_project_path;
use crate::state::AppState;
use crate::supervisor::core::SupervisorCore;
use crate::supervisor::settings::SupervisorSettings;
use crate::supervisor::workdir;
use crate::validation::{validate_model, validate_session_id};

const SESSION_ID_KEY: &str = "supervisorSessionId";
const DEFAULT_MODEL_KEY: &str = "defaultModelId";
const PROGRAM: &str = "bash";
const COLUMNS: u16 = 120;
const ROWS: u16 = 40;
const BACKOFF_STEPS: [Duration; 3] = [
    Duration::from_secs(5),
    Duration::from_secs(30),
    Duration::from_secs(120),
];
const BACKOFF_RESET_UPTIME: Duration = Duration::from_secs(10 * 60);
const RESUME_ATTEMPTS: u32 = 2;
const CONVERSATION_MARKERS: [&str; 2] = ["\"type\":\"user\"", "\"type\":\"assistant\""];
const CLAUDE_DIR: &str = ".claude";
const CLAUDE_PROJECTS_DIR: &str = "projects";
const TRANSCRIPT_EXTENSION: &str = "jsonl";
const ERROR_NO_HOME: &str = "home directory unknown";

fn now() -> Instant {
    tokio::time::Instant::now().into_std()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SupervisorSessionArg {
    Fresh(String),
    Resume(String),
}

impl SupervisorSessionArg {
    pub fn id(&self) -> &str {
        match self {
            SupervisorSessionArg::Fresh(id) | SupervisorSessionArg::Resume(id) => id,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Exit {
    Stale,
    Stopped,
    Restart {
        delay: Duration,
        token: u64,
        forget_session: bool,
    },
}

pub fn build_supervisor_command(
    session: SupervisorSessionArg,
    model: Option<&str>,
    mcp_json: &Path,
    discord_channel: bool,
) -> String {
    let mut cmd = String::from("claude");
    match session {
        SupervisorSessionArg::Fresh(id) => cmd.push_str(&format!(" --session-id {id}")),
        SupervisorSessionArg::Resume(id) => cmd.push_str(&format!(" --resume {id}")),
    }
    if let Some(model) = model {
        cmd.push_str(&format!(" --model {}", shell_single_quote(model)));
    }
    cmd.push_str(" --permission-mode dontAsk");
    cmd.push_str(&format!(
        " --mcp-config {}",
        shell_single_quote(&mcp_json.to_string_lossy())
    ));
    if discord_channel {
        cmd.push_str(&format!(
            " --channels {}",
            crate::supervisor::discord::CHANNEL_ARG
        ));
    } else {
        cmd.push_str(" --strict-mcp-config");
    }
    cmd
}

pub fn next_backoff(attempts: u32, uptime: Duration) -> (Duration, u32) {
    let attempts = if uptime >= BACKOFF_RESET_UPTIME {
        0
    } else {
        attempts
    };
    let step = (attempts as usize).min(BACKOFF_STEPS.len() - 1);
    (BACKOFF_STEPS[step], attempts.saturating_add(1))
}

pub fn transcript_path(projects_root: &Path, workdir: &Path, session_id: &str) -> PathBuf {
    projects_root
        .join(encode_project_path(workdir))
        .join(format!("{session_id}.{TRANSCRIPT_EXTENSION}"))
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn has_conversation(path: &Path) -> bool {
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    BufReader::new(file)
        .split(b'\n')
        .map_while(Result::ok)
        .any(|line| {
            CONVERSATION_MARKERS
                .iter()
                .any(|marker| contains_bytes(&line, marker.as_bytes()))
        })
}

pub fn choose_session(
    stored: Option<&str>,
    projects_root: &Path,
    workdir: &Path,
) -> SupervisorSessionArg {
    let stored = stored
        .map(str::trim)
        .filter(|id| validate_session_id(id).is_ok());
    match stored {
        Some(id) if has_conversation(&transcript_path(projects_root, workdir, id)) => {
            SupervisorSessionArg::Resume(id.to_string())
        }
        _ => SupervisorSessionArg::Fresh(Uuid::new_v4().to_string()),
    }
}

fn supervisor_env(mut env: HashMap<String, String>) -> HashMap<String, String> {
    env.retain(|key, _| !CALLER_SESSION_ENV_VARS.contains(&key.as_str()));
    env
}

fn claude_home() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(CLAUDE_DIR))
}

fn claude_projects_root() -> Option<PathBuf> {
    claude_home().map(|home| home.join(CLAUDE_PROJECTS_DIR))
}

fn read_roots(conn: &Connection) -> Vec<PathBuf> {
    let projects = projects_repo::list(conn).unwrap_or_else(|error| {
        eprintln!("supervisor: cannot list projects for read access: {error}");
        Vec::new()
    });
    let mut roots: Vec<PathBuf> = Vec::new();
    for root in projects
        .into_iter()
        .map(|project| PathBuf::from(project.path))
        .chain(claude_projects_root())
    {
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    roots
}

fn supervisor_model(conn: &Connection, configured: Option<String>) -> Option<String> {
    let fallback = settings_repo::get(conn, DEFAULT_MODEL_KEY).ok().flatten();
    [configured, fallback]
        .into_iter()
        .flatten()
        .map(|model| model.trim().to_string())
        .find(|model| validate_model(model).is_ok())
}

fn current_settings(app: &AppHandle) -> Option<SupervisorSettings> {
    let state = app.state::<AppState>();
    let conn = state.db.get().ok()?;
    Some(SupervisorSettings::load(&conn))
}

fn level_enabled(app: &AppHandle) -> bool {
    current_settings(app).is_some_and(|settings| settings.level != SupervisorLevel::Off)
}

fn write_workdir(
    app: &AppHandle,
    conn: &Connection,
    level: SupervisorLevel,
) -> Result<PathBuf, String> {
    let dir = workdir::supervisor_dir(app).map_err(|error| error.to_string())?;
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let claude_home = claude_home().ok_or_else(|| ERROR_NO_HOME.to_string())?;
    workdir::write_supervisor_workdir(&dir, &exe, level, &read_roots(conn), &claude_home, None)
        .map_err(|error| error.to_string())?;
    Ok(dir)
}

struct Launch {
    dir: PathBuf,
    command: String,
    env: HashMap<String, String>,
    session: SupervisorSessionArg,
}

fn prepare_launch(app: &AppHandle) -> Result<Option<Launch>, String> {
    let state = app.state::<AppState>();
    let conn = state.db.get().map_err(|error| error.to_string())?;
    let settings = SupervisorSettings::load(&conn);
    if settings.level == SupervisorLevel::Off {
        return Ok(None);
    }
    let dir = write_workdir(app, &conn, settings.level)?;
    let projects_root = claude_projects_root().ok_or_else(|| ERROR_NO_HOME.to_string())?;
    let stored = settings_repo::get(&conn, SESSION_ID_KEY).map_err(|error| error.to_string())?;
    let session = choose_session(stored.as_deref(), &projects_root, &dir);
    if let SupervisorSessionArg::Fresh(id) = &session {
        settings_repo::set(&conn, SESSION_ID_KEY, id).map_err(|error| error.to_string())?;
    }
    let model = supervisor_model(&conn, settings.model_id);
    let command = build_supervisor_command(
        session.clone(),
        model.as_deref(),
        &dir.join(workdir::MCP_CONFIG_FILE),
        false,
    );
    let shell = resolve_shell(&conn);
    drop(conn);
    let env = supervisor_env(ensure_shell_env(&state, &shell));
    Ok(Some(Launch {
        dir,
        command,
        env,
        session,
    }))
}

fn kill_pty(app: &AppHandle, pty_id: &str) {
    if let Err(error) = app.state::<AppState>().pty.kill(pty_id) {
        eprintln!("supervisor: cannot release pty {pty_id}: {error}");
    }
}

fn forget_session_id(app: &AppHandle) -> AppResult<()> {
    let state = app.state::<AppState>();
    let conn = state.db.get()?;
    settings_repo::delete(&conn, SESSION_ID_KEY)
}

#[derive(Default)]
struct ProcessState {
    serving: bool,
    wanted: bool,
    pty_id: Option<String>,
    session: Option<SupervisorSessionArg>,
    ready: bool,
    started: Option<Instant>,
    attempts: u32,
    failed_resumes: u32,
    restart_token: u64,
}

impl ProcessState {
    fn plan_restart(&mut self, uptime: Duration) -> (Duration, u64) {
        let (delay, attempts) = next_backoff(self.attempts, uptime);
        self.attempts = attempts;
        self.restart_token += 1;
        (delay, self.restart_token)
    }
}

pub struct SupervisorProcess {
    core: Arc<SupervisorCore>,
    me: Weak<SupervisorProcess>,
    lifecycle: Mutex<()>,
    state: Mutex<ProcessState>,
}

impl SupervisorProcess {
    pub fn new(core: Arc<SupervisorCore>) -> Arc<SupervisorProcess> {
        Arc::new_cyclic(|me| SupervisorProcess {
            core,
            me: me.clone(),
            lifecycle: Mutex::new(()),
            state: Mutex::new(ProcessState::default()),
        })
    }

    pub fn mark_serving(&self) {
        self.state.lock().serving = true;
    }

    pub fn pty_id(&self) -> Option<String> {
        self.state.lock().pty_id.clone()
    }

    pub fn is_ready(&self) -> bool {
        self.ready_pty().is_some()
    }

    pub fn ready_pty(&self) -> Option<String> {
        let state = self.state.lock();
        state.pty_id.clone().filter(|_| state.ready)
    }

    pub fn session_id(&self) -> Option<String> {
        self.state
            .lock()
            .session
            .as_ref()
            .map(|session| session.id().to_string())
    }

    pub fn mark_ready(&self, session_id: &str) {
        let mut state = self.state.lock();
        let Some(pty_id) = state.pty_id.clone() else {
            return;
        };
        let launched = state.session.as_ref().map(SupervisorSessionArg::id);
        if state.ready || launched != Some(session_id) {
            return;
        }
        state.ready = true;
        state.failed_resumes = 0;
        self.core.set_supervisor_state(true, true, Some(pty_id));
    }

    pub fn ensure_running(&self, app: &AppHandle) {
        let _lifecycle = self.lifecycle.lock();
        if !level_enabled(app) {
            return;
        }
        {
            let mut state = self.state.lock();
            if !state.serving || state.pty_id.is_some() {
                return;
            }
            state.wanted = true;
            state.attempts = 0;
            state.restart_token += 1;
        }
        self.launch(app);
    }

    pub fn stop(&self, app: &AppHandle) {
        let _lifecycle = self.lifecycle.lock();
        if let Some(pty_id) = self.halt() {
            kill_pty(app, &pty_id);
        }
    }

    pub fn restart(&self, app: &AppHandle) {
        let _lifecycle = self.lifecycle.lock();
        self.relaunch(app);
    }

    pub fn new_conversation(&self, app: &AppHandle) -> AppResult<()> {
        let _lifecycle = self.lifecycle.lock();
        forget_session_id(app)?;
        self.relaunch(app);
        Ok(())
    }

    pub fn refresh_instructions(&self, app: &AppHandle) {
        let _lifecycle = self.lifecycle.lock();
        if !self.state.lock().serving {
            return;
        }
        let state = app.state::<AppState>();
        let outcome = state
            .db
            .get()
            .map_err(|error| error.to_string())
            .and_then(|conn| {
                let level = SupervisorSettings::load(&conn).level;
                if level == SupervisorLevel::Off {
                    return Ok(());
                }
                write_workdir(app, &conn, level).map(|_| ())
            });
        if let Err(error) = outcome {
            eprintln!("supervisor: cannot refresh the supervisor instructions: {error}");
        }
    }

    fn relaunch(&self, app: &AppHandle) {
        if let Some(pty_id) = self.halt() {
            kill_pty(app, &pty_id);
        }
        if !level_enabled(app) {
            return;
        }
        {
            let mut state = self.state.lock();
            if !state.serving {
                return;
            }
            state.wanted = true;
        }
        self.launch(app);
    }

    fn launch(&self, app: &AppHandle) {
        let launch = match prepare_launch(app) {
            Ok(Some(launch)) => launch,
            Ok(None) => return,
            Err(error) => {
                eprintln!("supervisor: cannot prepare the supervisor session: {error}");
                self.retry_later(app);
                return;
            }
        };
        let pty = app.state::<AppState>().pty.clone();
        let hook = self.exit_hook(app);
        let mut state = self.state.lock();
        if !state.wanted || state.pty_id.is_some() {
            return;
        }
        let args = ["-c", launch.command.as_str()];
        let spawned = pty.spawn_with_exit_hook(
            app.clone(),
            PROGRAM,
            &args,
            &launch.dir,
            COLUMNS,
            ROWS,
            &launch.env,
            Some(hook),
        );
        match spawned {
            Ok(pty_id) => self.attach_locked(&mut state, pty_id, launch.session),
            Err(error) => {
                eprintln!("supervisor: cannot start the supervisor session: {error}");
                let (delay, token) = state.plan_restart(Duration::ZERO);
                drop(state);
                self.schedule_restart(app, delay, token);
            }
        }
    }

    fn retry_later(&self, app: &AppHandle) {
        let planned = {
            let mut state = self.state.lock();
            state.wanted.then(|| state.plan_restart(Duration::ZERO))
        };
        if let Some((delay, token)) = planned {
            self.schedule_restart(app, delay, token);
        }
    }

    fn exit_hook(&self, app: &AppHandle) -> Arc<dyn Fn(String) + Send + Sync> {
        let me = self.me.clone();
        let app = app.clone();
        Arc::new(move |pty_id: String| {
            if let Some(process) = me.upgrade() {
                process.on_exit(&app, &pty_id);
            }
        })
    }

    fn on_exit(&self, app: &AppHandle, pty_id: &str) {
        match self.detach(pty_id) {
            Exit::Stale => {}
            Exit::Stopped => kill_pty(app, pty_id),
            Exit::Restart {
                delay,
                token,
                forget_session,
            } => {
                kill_pty(app, pty_id);
                if forget_session {
                    if let Err(error) = forget_session_id(app) {
                        eprintln!("supervisor: cannot drop the stale session id: {error}");
                    }
                }
                self.schedule_restart(app, delay, token);
            }
        }
    }

    fn schedule_restart(&self, app: &AppHandle, delay: Duration, token: u64) {
        eprintln!(
            "supervisor: session not running, restart in {} s",
            delay.as_secs()
        );
        let me = self.me.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            let _ = tauri::async_runtime::spawn_blocking(move || {
                if let Some(process) = me.upgrade() {
                    process.restart_due(&app, token);
                }
            })
            .await;
        });
    }

    fn restart_due(&self, app: &AppHandle, token: u64) {
        let _lifecycle = self.lifecycle.lock();
        if self.claim_restart(token) {
            self.launch(app);
        }
    }

    #[cfg(test)]
    pub(crate) fn attach(&self, pty_id: String, session: SupervisorSessionArg) {
        let mut state = self.state.lock();
        self.attach_locked(&mut state, pty_id, session);
    }

    fn attach_locked(
        &self,
        state: &mut ProcessState,
        pty_id: String,
        session: SupervisorSessionArg,
    ) {
        state.pty_id = Some(pty_id.clone());
        state.session = Some(session);
        state.ready = false;
        state.started = Some(now());
        self.core.set_supervisor_state(true, false, Some(pty_id));
    }

    fn detach(&self, pty_id: &str) -> Exit {
        let mut state = self.state.lock();
        if state.pty_id.as_deref() != Some(pty_id) {
            return Exit::Stale;
        }
        let failed_resume =
            !state.ready && matches!(state.session, Some(SupervisorSessionArg::Resume(_)));
        let uptime = state
            .started
            .map(|started| now().saturating_duration_since(started))
            .unwrap_or_default();
        state.pty_id = None;
        state.session = None;
        state.ready = false;
        state.started = None;
        self.core.set_supervisor_state(false, false, None);
        if !state.wanted {
            return Exit::Stopped;
        }
        state.failed_resumes = if failed_resume {
            state.failed_resumes + 1
        } else {
            0
        };
        let forget_session = state.failed_resumes >= RESUME_ATTEMPTS;
        if forget_session {
            state.failed_resumes = 0;
        }
        let (delay, token) = state.plan_restart(uptime);
        Exit::Restart {
            delay,
            token,
            forget_session,
        }
    }

    fn halt(&self) -> Option<String> {
        let mut state = self.state.lock();
        state.wanted = false;
        state.restart_token += 1;
        state.attempts = 0;
        state.ready = false;
        state.session = None;
        state.started = None;
        let previous = state.pty_id.take();
        self.core.set_supervisor_state(false, false, None);
        previous
    }

    fn claim_restart(&self, token: u64) -> bool {
        let state = self.state.lock();
        state.wanted && state.pty_id.is_none() && state.restart_token == token
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::test_support::{setup, SECOND};
    use tokio::time::advance;

    const ID: &str = "11111111-2222-4333-8444-555555555555";
    const WORKDIR: &str = "/home/u/.local/share/pl.cyberstudio.abeoncode/supervisor";
    const ENCODED_WORKDIR: &str = "-home-u--local-share-pl-cyberstudio-abeoncode-supervisor";
    const MINUTE: Duration = Duration::from_secs(60);

    fn fresh() -> SupervisorSessionArg {
        SupervisorSessionArg::Fresh(ID.to_string())
    }

    #[test]
    fn supervisor_command_flags() {
        let cmd = build_supervisor_command(
            fresh(),
            Some("claude-opus-5-5"),
            Path::new("/data/supervisor/mcp.json"),
            false,
        );
        assert!(cmd.contains("--permission-mode dontAsk"));
        assert!(cmd.contains("--strict-mcp-config"));
        assert!(!cmd.contains("--dangerously-skip-permissions"));
    }

    #[test]
    fn supervisor_command_renders_in_full() {
        assert_eq!(
            build_supervisor_command(
                fresh(),
                Some("claude-opus-4-8[1m]"),
                &Path::new(WORKDIR).join("mcp.json"),
                false,
            ),
            format!(
                "claude --session-id {ID} --model 'claude-opus-4-8[1m]' --permission-mode dontAsk \
                 --mcp-config '{WORKDIR}/mcp.json' --strict-mcp-config"
            )
        );
        let resumed = build_supervisor_command(
            SupervisorSessionArg::Resume(ID.to_string()),
            None,
            Path::new("/w/mcp.json"),
            false,
        );
        assert_eq!(
            resumed,
            format!(
                "claude --resume {ID} --permission-mode dontAsk --mcp-config '/w/mcp.json' \
                 --strict-mcp-config"
            )
        );
        assert!(!resumed.contains("--settings"));
        assert!(resumed.ends_with(" --strict-mcp-config"));
    }

    #[test]
    fn discord_command_drops_strict_mcp_and_adds_the_channel() {
        assert_eq!(
            build_supervisor_command(
                fresh(),
                Some("claude-opus-5-5"),
                Path::new("/w/mcp.json"),
                true,
            ),
            format!(
                "claude --session-id {ID} --model 'claude-opus-5-5' --permission-mode dontAsk \
                 --mcp-config '/w/mcp.json' --channels plugin:discord@claude-plugins-official"
            )
        );
    }

    #[cfg(unix)]
    #[test]
    fn supervisor_command_survives_the_shell() {
        let cmd = build_supervisor_command(
            fresh(),
            Some("claude-opus-4-8[1m]"),
            Path::new("/tmp/it's $(id)/mcp.json"),
            false,
        );
        let arguments = cmd.strip_prefix("claude").unwrap();
        let output = std::process::Command::new("bash")
            .arg("-c")
            .arg(format!("printf '%s\\n'{arguments}"))
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!(
                "--session-id\n{ID}\n--model\nclaude-opus-4-8[1m]\n--permission-mode\ndontAsk\n\
                 --mcp-config\n/tmp/it's $(id)/mcp.json\n--strict-mcp-config\n"
            )
        );
    }

    #[test]
    fn backoff_sequence() {
        let mut attempts = 0;
        let mut delays = Vec::new();
        for _ in 0..4 {
            let (delay, next) = next_backoff(attempts, 30 * SECOND);
            delays.push(delay.as_secs());
            attempts = next;
        }
        assert_eq!(delays, vec![5, 30, 120, 120]);
        assert_eq!(
            next_backoff(attempts, 10 * MINUTE - SECOND).0,
            Duration::from_secs(120)
        );
        assert_eq!(
            next_backoff(attempts, 10 * MINUTE),
            (Duration::from_secs(5), 1)
        );
    }

    #[test]
    fn transcript_lives_in_the_encoded_workdir() {
        assert_eq!(
            transcript_path(
                Path::new("/home/u/.claude/projects"),
                Path::new(WORKDIR),
                ID
            ),
            PathBuf::from(format!(
                "/home/u/.claude/projects/{ENCODED_WORKDIR}/{ID}.jsonl"
            ))
        );
    }

    #[test]
    fn resume_requires_an_existing_conversation() {
        let root = tempfile::tempdir().unwrap();
        let workdir = Path::new(WORKDIR);
        let sessions = root.path().join(ENCODED_WORKDIR);
        std::fs::create_dir_all(&sessions).unwrap();
        let fresh_id = |choice: SupervisorSessionArg| match choice {
            SupervisorSessionArg::Fresh(id) => {
                assert!(uuid::Uuid::parse_str(&id).is_ok(), "{id}");
                assert_ne!(id, ID);
                id
            }
            other => panic!("expected a fresh session, got {other:?}"),
        };

        fresh_id(choose_session(None, root.path(), workdir));
        fresh_id(choose_session(Some("  "), root.path(), workdir));
        fresh_id(choose_session(Some(ID), root.path(), workdir));

        let transcript = sessions.join(format!("{ID}.jsonl"));
        std::fs::write(
            &transcript,
            format!("{{\"type\":\"bridge-session\",\"sessionId\":\"{ID}\"}}\n"),
        )
        .unwrap();
        fresh_id(choose_session(Some(ID), root.path(), workdir));

        std::fs::write(
            &transcript,
            format!(
                "{{\"type\":\"bridge-session\",\"sessionId\":\"{ID}\"}}\n\
                 {{\"parentUuid\":null,\"type\":\"user\",\"message\":{{\"role\":\"user\"}}}}\n"
            ),
        )
        .unwrap();
        assert_eq!(
            choose_session(Some(ID), root.path(), workdir),
            SupervisorSessionArg::Resume(ID.to_string())
        );

        let escaping = root.path().join("escape.jsonl");
        std::fs::write(&escaping, "{\"type\":\"user\"}\n").unwrap();
        fresh_id(choose_session(Some("../escape"), root.path(), workdir));
    }

    #[test]
    fn caller_session_variables_are_removed() {
        let env = HashMap::from([
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("CLAUDECODE".to_string(), "1".to_string()),
            ("CLAUDE_CODE_SESSION_ID".to_string(), "abc".to_string()),
            ("AI_AGENT".to_string(), "claude".to_string()),
        ]);
        assert_eq!(
            supervisor_env(env),
            HashMap::from([("PATH".to_string(), "/usr/bin".to_string())])
        );
    }

    #[tokio::test(start_paused = true)]
    async fn readiness_follows_the_session_start_hook() {
        let (_effects, core) = setup();
        core.set_supervisor_state(false, false, None);
        let process = SupervisorProcess::new(core.clone());
        process.mark_ready(ID);
        assert!(!process.is_ready());
        assert!(!core.snapshot().ready);

        process.attach("pty-1".into(), fresh());
        let snapshot = core.snapshot();
        assert!(snapshot.running);
        assert!(!snapshot.ready);
        assert_eq!(snapshot.pty_id.as_deref(), Some("pty-1"));
        assert_eq!(process.pty_id().as_deref(), Some("pty-1"));
        assert!(!process.is_ready());
        assert_eq!(process.ready_pty(), None);

        process.mark_ready(ID);
        assert!(process.is_ready());
        assert!(core.snapshot().ready);
        assert_eq!(process.ready_pty().as_deref(), Some("pty-1"));

        assert_eq!(process.detach("pty-1"), Exit::Stopped);
        let snapshot = core.snapshot();
        assert!(!snapshot.running);
        assert!(!snapshot.ready);
        assert_eq!(snapshot.pty_id, None);
        assert!(!process.is_ready());
        assert_eq!(process.pty_id(), None);
    }

    #[tokio::test(start_paused = true)]
    async fn session_start_from_another_session_is_ignored() {
        let (_effects, core) = setup();
        let process = SupervisorProcess::new(core.clone());
        process.attach("pty-old".into(), fresh());
        assert_eq!(process.session_id().as_deref(), Some(ID));
        process.halt();
        assert_eq!(process.session_id(), None);

        const NEW_ID: &str = "99999999-8888-4777-8666-555555555555";
        process.attach(
            "pty-new".into(),
            SupervisorSessionArg::Resume(NEW_ID.to_string()),
        );
        process.mark_ready(ID);
        assert!(!process.is_ready());
        assert!(!core.snapshot().ready);
        process.mark_ready("");
        assert!(!process.is_ready());
        process.mark_ready(NEW_ID);
        assert!(process.is_ready());
        assert!(core.snapshot().ready);
        assert_eq!(process.session_id().as_deref(), Some(NEW_ID));
    }

    fn restart_delay(exit: Exit) -> u64 {
        match exit {
            Exit::Restart { delay, .. } => delay.as_secs(),
            other => panic!("expected a restart, got {other:?}"),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn exit_restarts_with_backoff_until_stopped() {
        let (_effects, core) = setup();
        let process = SupervisorProcess::new(core.clone());
        process.state.lock().wanted = true;

        let mut delays = Vec::new();
        for index in 0..4 {
            let pty_id = format!("pty-{index}");
            process.attach(pty_id.clone(), fresh());
            process.mark_ready(ID);
            advance(30 * SECOND).await;
            delays.push(restart_delay(process.detach(&pty_id)));
            assert!(!core.snapshot().running);
        }
        assert_eq!(delays, vec![5, 30, 120, 120]);

        process.attach("pty-long".into(), fresh());
        advance(10 * MINUTE).await;
        assert_eq!(restart_delay(process.detach("pty-long")), 5);

        process.attach("pty-current".into(), fresh());
        assert_eq!(process.detach("pty-old"), Exit::Stale);
        assert_eq!(process.pty_id().as_deref(), Some("pty-current"));

        let token = match process.detach("pty-current") {
            Exit::Restart { token, .. } => token,
            other => panic!("expected a restart, got {other:?}"),
        };
        assert!(process.claim_restart(token));
        assert!(!process.claim_restart(token + 1));

        process.attach("pty-stopping".into(), fresh());
        assert_eq!(process.halt().as_deref(), Some("pty-stopping"));
        assert!(!process.claim_restart(token));
        assert!(!core.snapshot().running);
        assert_eq!(process.detach("pty-stopping"), Exit::Stale);

        process.attach("pty-unwanted".into(), fresh());
        assert_eq!(process.detach("pty-unwanted"), Exit::Stopped);
    }

    #[tokio::test(start_paused = true)]
    async fn failed_resumes_fall_back_to_a_fresh_session() {
        let (_effects, core) = setup();
        let process = SupervisorProcess::new(core);
        process.state.lock().wanted = true;
        let resume = || SupervisorSessionArg::Resume(ID.to_string());
        let forgets = |exit: Exit| match exit {
            Exit::Restart { forget_session, .. } => forget_session,
            other => panic!("expected a restart, got {other:?}"),
        };

        process.attach("pty-1".into(), resume());
        assert!(!forgets(process.detach("pty-1")));
        process.attach("pty-2".into(), resume());
        assert!(forgets(process.detach("pty-2")));

        process.attach("pty-3".into(), resume());
        assert!(!forgets(process.detach("pty-3")));
        process.attach("pty-4".into(), resume());
        process.mark_ready(ID);
        assert!(!forgets(process.detach("pty-4")));
        process.attach("pty-5".into(), resume());
        assert!(!forgets(process.detach("pty-5")));

        process.attach("pty-6".into(), fresh());
        assert!(!forgets(process.detach("pty-6")));
        process.attach("pty-7".into(), fresh());
        assert!(!forgets(process.detach("pty-7")));
    }
}
