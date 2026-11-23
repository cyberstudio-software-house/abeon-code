use async_trait::async_trait;
use std::io::ErrorKind;
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

pub struct SystemRunner;

#[async_trait]
impl CommandRunner for SystemRunner {
    async fn run(
        &self,
        program: &str,
        args: &[String],
        timeout: Duration,
    ) -> Result<CommandOutput, RunError> {
        let mut command = Command::new(program);
        command.args(args).stdin(Stdio::null()).kill_on_drop(true);
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[tokio::test]
    async fn captures_output_and_exit_status() {
        let output = SystemRunner
            .run("sh", &args(&["-c", "echo out; echo err 1>&2; exit 3"]), Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(output.status, Some(3));
        assert_eq!(output.stdout, "out\n");
        assert_eq!(output.stderr, "err\n");
    }

    #[tokio::test]
    async fn arguments_are_not_interpreted_by_a_shell() {
        let output = SystemRunner
            .run("echo", &args(&["$HOME", "a;b", "*"]), Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(output.stdout, "$HOME a;b *\n");
    }

    #[tokio::test]
    async fn a_missing_program_is_not_found() {
        let result = SystemRunner
            .run("abeon-definitely-missing-tool", &[], Duration::from_secs(5))
            .await;
        assert_eq!(result, Err(RunError::NotFound));
    }

    #[tokio::test]
    async fn a_slow_program_times_out() {
        let result = SystemRunner
            .run("sleep", &args(&["5"]), Duration::from_millis(100))
            .await;
        assert_eq!(result, Err(RunError::TimedOut));
    }
}
