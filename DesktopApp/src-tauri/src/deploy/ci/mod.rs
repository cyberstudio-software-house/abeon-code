pub mod bitbucket;
pub mod github;

use crate::deploy::excerpt::redact_line;
use crate::deploy::runner::{CommandOutput, CommandRunner, RunError};
use crate::domain::deploy::{BuildProvider, DeployFlow};
use std::time::Duration;

pub(crate) const CI_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CiStatus {
    Running,
    Paused,
    Failed,
    Succeeded,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CiRun {
    pub id: String,
    pub build_number: Option<i64>,
    pub url: String,
    pub status: CiStatus,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolProblem {
    pub tool: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CiObservation {
    NoRun,
    Run(CiRun),
    Unavailable(ToolProblem),
}

pub(crate) fn owned(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| arg.to_string()).collect()
}

pub(crate) fn failure_reason(output: &CommandOutput) -> String {
    output
        .stderr
        .lines()
        .map(|line| redact_line(line.trim()))
        .map(|line| line.trim().to_string())
        .find(|line| !line.is_empty())
        .unwrap_or_else(|| match output.status {
            Some(code) => format!("polecenie zakończyło się kodem {code}"),
            None => "polecenie zostało przerwane".to_string(),
        })
}

pub(crate) fn run_error_problem(tool: &str, error: RunError) -> ToolProblem {
    let reason = match error {
        RunError::NotFound => "nie znaleziono polecenia".to_string(),
        RunError::TimedOut => "przekroczono limit czasu".to_string(),
        RunError::Io(message) => message,
    };
    ToolProblem { tool: tool.to_string(), reason }
}

pub(crate) async fn call(
    runner: &dyn CommandRunner,
    tool: &str,
    args: Vec<String>,
) -> Result<String, ToolProblem> {
    match runner.run(tool, &args, CI_TIMEOUT).await {
        Err(error) => Err(run_error_problem(tool, error)),
        Ok(output) if output.status == Some(0) => Ok(output.stdout),
        Ok(output) => Err(ToolProblem { tool: tool.to_string(), reason: failure_reason(&output) }),
    }
}

pub(crate) fn unexpected_response(tool: &str) -> ToolProblem {
    ToolProblem { tool: tool.to_string(), reason: "nieoczekiwana odpowiedź".to_string() }
}

pub async fn observe(runner: &dyn CommandRunner, flow: &DeployFlow, commit: &str) -> CiObservation {
    match flow.build {
        BuildProvider::Bitbucket => bitbucket::observe(runner, flow, commit).await,
        BuildProvider::Github => github::observe(runner, flow, commit).await,
        BuildProvider::None => CiObservation::NoRun,
    }
}

pub async fn failure_log(
    runner: &dyn CommandRunner,
    flow: &DeployFlow,
    run: &CiRun,
) -> Option<String> {
    match flow.build {
        BuildProvider::Bitbucket => bitbucket::failure_log(runner, flow, run).await,
        BuildProvider::Github => github::failure_log(runner, flow, run).await,
        BuildProvider::None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy::runner::{ok, CommandOutput, FakeRunner};
    use crate::deploy::test_support::flow;

    #[tokio::test]
    async fn a_missing_tool_is_unavailable_not_a_failure() {
        let runner = FakeRunner::new().on("bkt", &["api"], Err(RunError::NotFound));
        let observation = observe(&runner, &flow(), "abc").await;
        assert_eq!(
            observation,
            CiObservation::Unavailable(ToolProblem {
                tool: "bkt".to_string(),
                reason: "nie znaleziono polecenia".to_string()
            })
        );
    }

    #[tokio::test]
    async fn a_failing_command_reports_the_first_non_empty_stderr_line() {
        let runner = FakeRunner::new().on(
            "bkt",
            &["api"],
            Ok(CommandOutput {
                status: Some(1),
                stdout: String::new(),
                stderr: "\n  not logged in\nsecond line\n".to_string(),
            }),
        );
        let CiObservation::Unavailable(problem) = observe(&runner, &flow(), "abc").await else {
            panic!("expected unavailable")
        };
        assert_eq!(problem.reason, "not logged in");
    }

    #[tokio::test]
    async fn the_stderr_reason_is_redacted_and_capped() {
        let stderr = format!(
            "\u{1b}[31merror: bad credentials for https://bob:hunter2@bitbucket.org token=abc123 {}\nignored",
            "z".repeat(600)
        );
        let runner = FakeRunner::new().on(
            "bkt",
            &["api"],
            Ok(CommandOutput { status: Some(1), stdout: String::new(), stderr }),
        );
        let CiObservation::Unavailable(problem) = observe(&runner, &flow(), "abc").await else {
            panic!("expected unavailable")
        };
        assert!(!problem.reason.contains("hunter2"), "{}", problem.reason);
        assert!(!problem.reason.contains("abc123"), "{}", problem.reason);
        assert!(!problem.reason.contains('\u{1b}'));
        assert!(problem.reason.starts_with("error: bad credentials for https://***@bitbucket.org"));
        assert_eq!(problem.reason.chars().count(), 400);
    }

    async fn reason_for(status: i32, stderr: &str) -> String {
        let runner = FakeRunner::new().on(
            "bkt",
            &["api"],
            Ok(CommandOutput {
                status: Some(status),
                stdout: String::new(),
                stderr: stderr.to_string(),
            }),
        );
        let CiObservation::Unavailable(problem) = observe(&runner, &flow(), "abc").await else {
            panic!("expected unavailable")
        };
        problem.reason
    }

    #[tokio::test]
    async fn lines_made_only_of_escape_codes_are_skipped() {
        let stderr = "\u{1b}[0m\r\n\u{1b}[2K\u{1b}[1G\n  \r\nreal error\n";
        assert_eq!(reason_for(1, stderr).await, "real error");
    }

    #[tokio::test]
    async fn an_escape_only_stderr_falls_back_to_the_exit_code() {
        let stderr = "\u{1b}[31m\u{1b}[0m\n\r\n";
        assert_eq!(reason_for(3, stderr).await, "polecenie zakończyło się kodem 3");
    }

    #[tokio::test]
    async fn a_timeout_is_unavailable() {
        let runner = FakeRunner::new().on("bkt", &["api"], Err(RunError::TimedOut));
        let CiObservation::Unavailable(problem) = observe(&runner, &flow(), "abc").await else {
            panic!("expected unavailable")
        };
        assert_eq!(problem.reason, "przekroczono limit czasu");
    }

    #[tokio::test]
    async fn unparsable_json_is_an_unexpected_response() {
        let runner = FakeRunner::new().on("bkt", &["api"], ok("<html>"));
        let CiObservation::Unavailable(problem) = observe(&runner, &flow(), "abc").await else {
            panic!("expected unavailable")
        };
        assert_eq!(problem.tool, "bkt");
        assert_eq!(problem.reason, "nieoczekiwana odpowiedź");
    }

    #[tokio::test]
    async fn the_provider_selects_the_tool() {
        let mut github_flow = flow();
        github_flow.build = BuildProvider::Github;
        let runner = FakeRunner::new().on("gh", &["run", "list"], ok("[]"));
        assert_eq!(observe(&runner, &github_flow, "abc").await, CiObservation::NoRun);
        assert_eq!(runner.calls()[0].0, "gh");
    }

    #[tokio::test]
    async fn without_a_provider_nothing_is_run() {
        let mut none_flow = flow();
        none_flow.build = BuildProvider::None;
        let runner = FakeRunner::new();
        assert_eq!(observe(&runner, &none_flow, "abc").await, CiObservation::NoRun);
        assert!(runner.calls().is_empty());
    }
}
