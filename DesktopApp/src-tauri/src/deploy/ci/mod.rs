pub mod bitbucket;
pub mod github;

use crate::deploy::runner::{CommandRunner, RunError};
use crate::domain::deploy::{BuildProvider, DeployFlow};
use std::time::Duration;

pub(crate) const CI_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const LOG_TAIL_LINES: usize = 40;

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

pub(crate) async fn call(
    runner: &dyn CommandRunner,
    tool: &str,
    args: Vec<String>,
) -> Result<String, ToolProblem> {
    let problem = |reason: String| ToolProblem { tool: tool.to_string(), reason };
    match runner.run(tool, &args, CI_TIMEOUT).await {
        Err(RunError::NotFound) => Err(problem("nie znaleziono polecenia".to_string())),
        Err(RunError::TimedOut) => Err(problem("przekroczono limit czasu".to_string())),
        Err(RunError::Io(message)) => Err(problem(message)),
        Ok(output) if output.status == Some(0) => Ok(output.stdout),
        Ok(output) => {
            let line = output
                .stderr
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| match output.status {
                    Some(code) => format!("polecenie zakończyło się kodem {code}"),
                    None => "polecenie zostało przerwane".to_string(),
                });
            Err(problem(line))
        }
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
