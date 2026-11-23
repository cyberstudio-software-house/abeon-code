use crate::commands::settings::{ensure_shell_env, resolve_shell};
use crate::state::AppState;
use async_trait::async_trait;
use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

#[derive(Debug, Clone, PartialEq)]
pub struct CommandOutput {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RunError {
    NotFound,
    TimedOut,
    Io(String),
}

#[async_trait]
pub trait CommandRunner: Send + Sync {
    async fn run(
        &self,
        program: &str,
        args: &[String],
        timeout: Duration,
    ) -> Result<CommandOutput, RunError>;
}

pub struct SystemRunner {
    env: HashMap<String, String>,
}

impl SystemRunner {
    pub fn new(env: HashMap<String, String>) -> Self {
        Self { env }
    }

    fn resolve(&self, program: &str) -> Option<PathBuf> {
        if program.contains('/') || program.contains(std::path::MAIN_SEPARATOR) {
            return Some(PathBuf::from(program));
        }
        let path_var = self
            .env
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
            .map(|(_, value)| value)?;
        std::env::split_paths(path_var)
            .filter(|dir| !dir.as_os_str().is_empty())
            .flat_map(|dir| executable_candidates(&dir, program))
            .find(|candidate| candidate.is_file())
    }
}

#[cfg(not(windows))]
fn executable_candidates(dir: &Path, program: &str) -> Vec<PathBuf> {
    vec![dir.join(program)]
}

#[cfg(windows)]
fn executable_candidates(dir: &Path, program: &str) -> Vec<PathBuf> {
    ["", ".exe", ".cmd", ".bat"]
        .iter()
        .map(|extension| dir.join(format!("{program}{extension}")))
        .collect()
}

pub fn shell_environment(state: &AppState) -> HashMap<String, String> {
    state
        .db
        .get()
        .ok()
        .map(|conn| resolve_shell(&conn))
        .map(|shell| ensure_shell_env(state, &shell))
        .unwrap_or_else(|| std::env::vars().collect())
}

pub fn shell_runner(state: &AppState) -> SystemRunner {
    SystemRunner::new(shell_environment(state))
}

#[async_trait]
impl CommandRunner for SystemRunner {
    async fn run(
        &self,
        program: &str,
        args: &[String],
        timeout: Duration,
    ) -> Result<CommandOutput, RunError> {
        let resolved = self.resolve(program).unwrap_or_else(|| PathBuf::from(program));
        let mut command = Command::new(resolved);
        command
            .args(args)
            .envs(&self.env)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        match tokio::time::timeout(timeout, command.output()).await {
            Err(_) => Err(RunError::TimedOut),
            Ok(Err(error)) if error.kind() == ErrorKind::NotFound => Err(RunError::NotFound),
            Ok(Err(error)) => Err(RunError::Io(error.to_string())),
            Ok(Ok(output)) => Ok(CommandOutput {
                status: output.status.code(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            }),
        }
    }
}

#[cfg(test)]
pub(crate) use fake::{ok, FakeRunner};

#[cfg(test)]
mod fake {
    use super::{CommandOutput, CommandRunner, RunError};
    use async_trait::async_trait;
    use parking_lot::Mutex;
    use std::time::Duration;

    type Reply = Result<CommandOutput, RunError>;

    pub(crate) fn ok(stdout: &str) -> Reply {
        Ok(CommandOutput { status: Some(0), stdout: stdout.to_string(), stderr: String::new() })
    }

    #[derive(Default)]
    pub(crate) struct FakeRunner {
        rules: Vec<(String, Vec<String>, Reply)>,
        calls: Mutex<Vec<(String, Vec<String>)>>,
    }

    impl FakeRunner {
        pub(crate) fn new() -> Self {
            Self::default()
        }

        pub(crate) fn on(mut self, program: &str, args_prefix: &[&str], reply: Reply) -> Self {
            let prefix = args_prefix.iter().map(|arg| arg.to_string()).collect();
            self.rules.push((program.to_string(), prefix, reply));
            self
        }

        pub(crate) fn calls(&self) -> Vec<(String, Vec<String>)> {
            self.calls.lock().clone()
        }
    }

    #[async_trait]
    impl CommandRunner for FakeRunner {
        async fn run(
            &self,
            program: &str,
            args: &[String],
            _timeout: Duration,
        ) -> Reply {
            self.calls.lock().push((program.to_string(), args.to_vec()));
            self.rules
                .iter()
                .find(|(rule_program, prefix, _)| {
                    rule_program == program && args.starts_with(prefix)
                })
                .map(|(_, _, reply)| reply.clone())
                .unwrap_or_else(|| Err(RunError::Io(format!("no fake reply for {program} {args:?}"))))
        }
    }
}

#[cfg(test)]
mod resolve_tests {
    use super::*;

    fn runner_with_key(key: &str, dir: &Path) -> SystemRunner {
        SystemRunner::new(HashMap::from([(key.to_string(), dir.display().to_string())]))
    }

    #[test]
    fn the_path_variable_is_found_whatever_its_case() {
        let dir = tempfile::tempdir().unwrap();
        let tool = dir.path().join(if cfg!(windows) { "abeon-tool.exe" } else { "abeon-tool" });
        std::fs::write(&tool, "").unwrap();
        for key in ["PATH", "Path", "path"] {
            let resolved = runner_with_key(key, dir.path()).resolve("abeon-tool");
            assert_eq!(resolved, Some(dir.path().join(tool.file_name().unwrap())), "{key}");
        }
    }

    #[test]
    fn a_name_that_is_in_no_directory_does_not_resolve() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(runner_with_key("Path", dir.path()).resolve("abeon-tool"), None);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn system_runner() -> SystemRunner {
        SystemRunner::new(std::env::vars().collect())
    }

    fn tool_dir(name: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/bin/sh", dir.path().join(name)).unwrap();
        dir
    }

    fn env_with_path(path: &Path) -> HashMap<String, String> {
        HashMap::from([("PATH".to_string(), path.display().to_string())])
    }

    #[tokio::test]
    async fn a_program_that_exists_only_on_the_supplied_path_is_found() {
        let dir = tool_dir("abeon-only-here");
        let runner = SystemRunner::new(env_with_path(dir.path()));
        let output = runner
            .run("abeon-only-here", &args(&["-c", "echo found"]), Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(output.stdout, "found\n");
    }

    #[tokio::test]
    async fn a_program_outside_the_supplied_path_is_not_found() {
        let dir = tool_dir("abeon-only-here");
        let runner = SystemRunner::new(HashMap::new());
        let result = runner.run("abeon-only-here", &[], Duration::from_secs(5)).await;
        assert_eq!(result, Err(RunError::NotFound));
        drop(dir);
    }

    #[tokio::test]
    async fn without_a_path_in_the_map_the_os_search_still_applies() {
        let runner = SystemRunner::new(HashMap::new());
        let output = runner
            .run("sh", &args(&["-c", "echo os-search"]), Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(output.stdout, "os-search\n");
    }

    #[tokio::test]
    async fn the_supplied_environment_reaches_the_child() {
        let dir = tool_dir("abeon-env-tool");
        let mut env = env_with_path(dir.path());
        env.insert("ABEON_MARKER".to_string(), "from-shell-env".to_string());
        let output = SystemRunner::new(env)
            .run(
                "abeon-env-tool",
                &args(&["-c", "echo \"$ABEON_MARKER\""]),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert_eq!(output.stdout, "from-shell-env\n");
    }

    #[tokio::test]
    async fn the_runner_built_from_app_state_uses_the_cached_shell_environment() {
        let dir = tool_dir("abeon-state-tool");
        let pool = crate::db::init_pool(&PathBuf::from(":memory:")).unwrap();
        let state = AppState::new(pool);
        *state.shell_env.lock() = Some(env_with_path(dir.path()));
        let output = shell_runner(&state)
            .run("abeon-state-tool", &args(&["-c", "echo from-state"]), Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(output.stdout, "from-state\n");
    }

    #[tokio::test]
    async fn captures_output_and_exit_status() {
        let output = system_runner()
            .run("sh", &args(&["-c", "echo out; echo err 1>&2; exit 3"]), Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(output.status, Some(3));
        assert_eq!(output.stdout, "out\n");
        assert_eq!(output.stderr, "err\n");
    }

    #[tokio::test]
    async fn arguments_are_not_interpreted_by_a_shell() {
        let output = system_runner()
            .run("echo", &args(&["$HOME", "a;b", "*"]), Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(output.stdout, "$HOME a;b *\n");
    }

    #[tokio::test]
    async fn a_missing_program_is_not_found() {
        let result = system_runner()
            .run("abeon-definitely-missing-tool", &[], Duration::from_secs(5))
            .await;
        assert_eq!(result, Err(RunError::NotFound));
    }

    #[tokio::test]
    async fn a_slow_program_times_out() {
        let result = system_runner()
            .run("sleep", &args(&["5"]), Duration::from_millis(100))
            .await;
        assert_eq!(result, Err(RunError::TimedOut));
    }
}
