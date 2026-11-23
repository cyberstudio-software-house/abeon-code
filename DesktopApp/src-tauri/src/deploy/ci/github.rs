use super::{call, owned, unexpected_response, CiObservation, CiRun, CiStatus};
use crate::deploy::excerpt::tail_redacted;
use crate::deploy::LOG_EXCERPT_LINES;
use crate::deploy::runner::CommandRunner;
use crate::domain::deploy::DeployFlow;
use serde_json::Value;

const TOOL: &str = "gh";
const FAILING_CONCLUSIONS: [&str; 4] = ["failure", "cancelled", "timed_out", "startup_failure"];

struct Workflow {
    id: i64,
    url: String,
    status: String,
    conclusion: String,
    updated_at: Option<i64>,
}

impl Workflow {
    fn parse(entry: &Value) -> Option<Self> {
        let updated_at = entry["updatedAt"]
            .as_str()
            .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
            .map(|time| time.timestamp_millis());
        Some(Workflow {
            id: entry["databaseId"].as_i64()?,
            url: entry["url"].as_str()?.to_string(),
            status: entry["status"].as_str().unwrap_or_default().to_string(),
            conclusion: entry["conclusion"].as_str().unwrap_or_default().to_string(),
            updated_at,
        })
    }

    fn is_paused(&self) -> bool {
        matches!(self.status.as_str(), "waiting" | "action_required")
            || self.conclusion == "action_required"
    }

    fn is_unfinished(&self) -> bool {
        self.status != "completed"
    }

    fn has_failed(&self) -> bool {
        FAILING_CONCLUSIONS.contains(&self.conclusion.as_str())
    }

    fn into_run(self, status: CiStatus, finished_at: Option<i64>) -> CiRun {
        CiRun {
            id: self.id.to_string(),
            build_number: None,
            url: self.url,
            status,
            finished_at,
        }
    }
}

fn aggregate(runs: Vec<Workflow>) -> CiObservation {
    if runs.is_empty() {
        return CiObservation::NoRun;
    }
    let latest_update = runs.iter().filter_map(|run| run.updated_at).max();
    let position = |predicate: &dyn Fn(&Workflow) -> bool| runs.iter().position(|run| predicate(run));
    let (index, status) = if let Some(index) = position(&Workflow::is_paused) {
        (index, CiStatus::Paused)
    } else if let Some(index) = position(&Workflow::is_unfinished) {
        (index, CiStatus::Running)
    } else if let Some(index) = position(&Workflow::has_failed) {
        (index, CiStatus::Failed)
    } else {
        (0, CiStatus::Succeeded)
    };
    let run = runs.into_iter().nth(index).expect("index comes from the same list");
    let finished_at = match status {
        CiStatus::Succeeded => latest_update,
        CiStatus::Failed => run.updated_at,
        CiStatus::Running | CiStatus::Paused => None,
    };
    CiObservation::Run(run.into_run(status, finished_at))
}

pub(super) async fn observe(
    runner: &dyn CommandRunner,
    flow: &DeployFlow,
    commit: &str,
) -> CiObservation {
    let args = owned(&[
        "run",
        "list",
        "--repo",
        &flow.build_repo,
        "--commit",
        commit,
        "--limit",
        "30",
        "--json",
        "databaseId,status,conclusion,url,headBranch,updatedAt",
    ]);
    let stdout = match call(runner, TOOL, args).await {
        Ok(stdout) => stdout,
        Err(problem) => return CiObservation::Unavailable(problem),
    };
    let Ok(body) = serde_json::from_str::<Value>(&stdout) else {
        return CiObservation::Unavailable(unexpected_response(TOOL));
    };
    let Some(entries) = body.as_array() else {
        return CiObservation::Unavailable(unexpected_response(TOOL));
    };
    let mut runs = Vec::new();
    for entry in entries {
        if entry["headBranch"].as_str() != Some(flow.production_branch.as_str()) {
            continue;
        }
        match Workflow::parse(entry) {
            Some(run) => runs.push(run),
            None => return CiObservation::Unavailable(unexpected_response(TOOL)),
        }
    }
    aggregate(runs)
}

pub(super) async fn failure_log(
    runner: &dyn CommandRunner,
    flow: &DeployFlow,
    run: &CiRun,
) -> Option<String> {
    let args = owned(&["run", "view", &run.id, "--repo", &flow.build_repo, "--log-failed"]);
    let log = call(runner, TOOL, args).await.ok()?;
    let excerpt = tail_redacted(&log, LOG_EXCERPT_LINES);
    if excerpt.trim().is_empty() {
        None
    } else {
        Some(excerpt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy::runner::{ok, FakeRunner};
    use crate::deploy::test_support::flow_with;
    use serde_json::json;

    const SHA: &str = "0b3b32f909976eecc82a02a13a1e336d6e429991";

    fn github_flow() -> DeployFlow {
        let mut flow = flow_with("buildRepo", "owner/repo");
        flow.build = crate::domain::deploy::BuildProvider::Github;
        flow.production_branch = "main".to_string();
        flow
    }

    fn run(id: i64, branch: &str, status: &str, conclusion: &str, updated: &str) -> Value {
        json!({
            "conclusion": conclusion,
            "databaseId": id,
            "headBranch": branch,
            "status": status,
            "updatedAt": updated,
            "url": format!("https://github.com/owner/repo/actions/runs/{id}")
        })
    }

    fn runner_with(runs: Vec<Value>) -> FakeRunner {
        FakeRunner::new().on("gh", &["run", "list"], ok(&Value::Array(runs).to_string()))
    }

    async fn observed(runs: Vec<Value>) -> CiObservation {
        observe(&runner_with(runs), &github_flow(), SHA).await
    }

    #[tokio::test]
    async fn a_single_successful_run_succeeds_with_its_update_time() {
        let CiObservation::Run(found) =
            observed(vec![run(1, "main", "completed", "success", "2026-11-18T10:00:00Z")]).await
        else {
            panic!()
        };
        assert_eq!(found.id, "1");
        assert_eq!(found.build_number, None);
        assert_eq!(found.url, "https://github.com/owner/repo/actions/runs/1");
        assert_eq!(found.status, CiStatus::Succeeded);
        assert_eq!(found.finished_at, Some(chrono_millis("2026-11-18T10:00:00Z")));
    }

    #[tokio::test]
    async fn a_waiting_workflow_pauses_the_commit() {
        let CiObservation::Run(found) = observed(vec![
            run(1, "main", "completed", "success", "2026-11-18T10:00:00Z"),
            run(2, "main", "waiting", "", "2026-11-18T10:01:00Z"),
        ])
        .await
        else {
            panic!()
        };
        assert_eq!(found.status, CiStatus::Paused);
        assert_eq!(found.id, "2");
        assert_eq!(found.url, "https://github.com/owner/repo/actions/runs/2");
        assert_eq!(found.finished_at, None);
    }

    #[tokio::test]
    async fn action_required_pauses_the_commit() {
        for (status, conclusion) in [("action_required", ""), ("completed", "action_required")] {
            let CiObservation::Run(found) =
                observed(vec![run(7, "main", status, conclusion, "2026-11-18T10:00:00Z")]).await
            else {
                panic!()
            };
            assert_eq!(found.status, CiStatus::Paused, "{status} {conclusion}");
        }
    }

    #[tokio::test]
    async fn a_failing_workflow_fails_the_commit_with_its_own_id() {
        let CiObservation::Run(found) = observed(vec![
            run(1, "main", "completed", "success", "2026-11-18T10:00:00Z"),
            run(2, "main", "completed", "failure", "2026-11-18T10:05:00Z"),
        ])
        .await
        else {
            panic!()
        };
        assert_eq!(found.status, CiStatus::Failed);
        assert_eq!(found.id, "2");
        assert_eq!(found.finished_at, Some(chrono_millis("2026-11-18T10:05:00Z")));
    }

    #[tokio::test]
    async fn every_failing_conclusion_counts() {
        for conclusion in ["failure", "cancelled", "timed_out", "startup_failure"] {
            let CiObservation::Run(found) =
                observed(vec![run(3, "main", "completed", conclusion, "2026-11-18T10:00:00Z")])
                    .await
            else {
                panic!()
            };
            assert_eq!(found.status, CiStatus::Failed, "{conclusion}");
        }
    }

    #[tokio::test]
    async fn an_unfinished_workflow_keeps_the_commit_running() {
        let CiObservation::Run(found) = observed(vec![
            run(1, "main", "completed", "failure", "2026-11-18T10:00:00Z"),
            run(2, "main", "in_progress", "", "2026-11-18T10:01:00Z"),
        ])
        .await
        else {
            panic!()
        };
        assert_eq!(found.status, CiStatus::Running);
        assert_eq!(found.id, "2");
        assert_eq!(found.finished_at, None);
    }

    #[tokio::test]
    async fn success_reports_the_latest_update_of_all_runs() {
        let CiObservation::Run(found) = observed(vec![
            run(2, "main", "completed", "success", "2026-11-18T10:00:00Z"),
            run(1, "main", "completed", "skipped", "2026-11-18T10:09:00Z"),
        ])
        .await
        else {
            panic!()
        };
        assert_eq!(found.status, CiStatus::Succeeded);
        assert_eq!(found.id, "2");
        assert_eq!(found.finished_at, Some(chrono_millis("2026-11-18T10:09:00Z")));
    }

    #[tokio::test]
    async fn runs_on_another_branch_are_ignored() {
        let observation =
            observed(vec![run(1, "feature", "completed", "failure", "2026-11-18T10:00:00Z")]).await;
        assert_eq!(observation, CiObservation::NoRun);
    }

    #[tokio::test]
    async fn a_failure_on_another_branch_does_not_taint_the_production_run() {
        let CiObservation::Run(found) = observed(vec![
            run(1, "feature", "completed", "failure", "2026-11-18T10:00:00Z"),
            run(2, "main", "completed", "success", "2026-11-18T10:01:00Z"),
        ])
        .await
        else {
            panic!()
        };
        assert_eq!(found.status, CiStatus::Succeeded);
        assert_eq!(found.id, "2");
    }

    #[tokio::test]
    async fn no_runs_is_no_run() {
        assert_eq!(observed(vec![]).await, CiObservation::NoRun);
    }

    #[tokio::test]
    async fn a_non_array_response_is_unexpected() {
        let runner = FakeRunner::new().on("gh", &["run", "list"], ok("{\"message\":\"x\"}"));
        assert!(matches!(
            observe(&runner, &github_flow(), SHA).await,
            CiObservation::Unavailable(problem)
                if problem.tool == "gh" && problem.reason == "nieoczekiwana odpowiedź"
        ));
    }

    #[tokio::test]
    async fn arguments_are_passed_as_separate_values() {
        let runner = runner_with(vec![]);
        observe(&runner, &github_flow(), SHA).await;
        let (program, args) = &runner.calls()[0];
        assert_eq!(program, "gh");
        assert_eq!(
            args,
            &[
                "run",
                "list",
                "--repo",
                "owner/repo",
                "--commit",
                SHA,
                "--limit",
                "30",
                "--json",
                "databaseId,status,conclusion,url,headBranch,updatedAt"
            ]
        );
    }

    #[tokio::test]
    async fn the_failure_log_is_the_redacted_tail_of_the_failed_steps() {
        let runner = FakeRunner::new().on(
            "gh",
            &["run", "view"],
            ok("step\n\u{1b}[31mGITHUB_TOKEN=abc\u{1b}[0m\nboom\n"),
        );
        let failed = CiRun {
            id: "44".to_string(),
            build_number: None,
            url: String::new(),
            status: CiStatus::Failed,
            finished_at: None,
        };
        let log = failure_log(&runner, &github_flow(), &failed).await.unwrap();
        assert_eq!(log, "step\nGITHUB_TOKEN=***\nboom");
        assert_eq!(
            runner.calls()[0].1,
            ["run", "view", "44", "--repo", "owner/repo", "--log-failed"]
        );
    }

    #[tokio::test]
    async fn the_failure_log_keeps_the_last_sixty_lines() {
        let log: Vec<String> = (1..=100).map(|line| format!("line {line}")).collect();
        let runner = FakeRunner::new().on("gh", &["run", "view"], ok(&log.join("\n")));
        let failed = CiRun {
            id: "44".to_string(),
            build_number: None,
            url: String::new(),
            status: CiStatus::Failed,
            finished_at: None,
        };
        let excerpt = failure_log(&runner, &github_flow(), &failed).await.unwrap();
        let lines: Vec<&str> = excerpt.lines().collect();
        assert_eq!(lines.len(), 60);
        assert_eq!(lines[0], "line 41");
        assert_eq!(lines[59], "line 100");
    }

    #[tokio::test]
    async fn an_empty_failure_log_is_none() {
        let runner = FakeRunner::new().on("gh", &["run", "view"], ok("\n"));
        let failed = CiRun {
            id: "44".to_string(),
            build_number: None,
            url: String::new(),
            status: CiStatus::Failed,
            finished_at: None,
        };
        assert_eq!(failure_log(&runner, &github_flow(), &failed).await, None);
    }

    fn chrono_millis(text: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(text).unwrap().timestamp_millis()
    }
}
