use super::{call, owned, unexpected_response, CiObservation, CiRun, CiStatus};
use crate::deploy::excerpt::tail_redacted;
use crate::deploy::LOG_EXCERPT_LINES;
use crate::deploy::runner::CommandRunner;
use crate::domain::deploy::DeployFlow;
use serde_json::Value;

const TOOL: &str = "bkt";

fn matches_flow(entry: &Value, flow: &DeployFlow, commit: &str) -> bool {
    let target = &entry["target"];
    target["commit"]["hash"].as_str() == Some(commit)
        && target["ref_type"].as_str() == Some("branch")
        && target["ref_name"].as_str() == Some(flow.production_branch.as_str())
}

fn status_of(entry: &Value) -> CiStatus {
    let state = &entry["state"];
    if state["name"].as_str() == Some("COMPLETED") {
        return if state["result"]["name"].as_str() == Some("SUCCESSFUL") {
            CiStatus::Succeeded
        } else {
            CiStatus::Failed
        };
    }
    match state["stage"]["name"].as_str() {
        Some("PAUSED") | Some("HALTED") => CiStatus::Paused,
        _ => CiStatus::Running,
    }
}

fn finished_at(entry: &Value, status: CiStatus) -> Option<i64> {
    if !matches!(status, CiStatus::Succeeded | CiStatus::Failed) {
        return None;
    }
    let completed = entry["completed_on"].as_str()?;
    chrono::DateTime::parse_from_rfc3339(completed).ok().map(|time| time.timestamp_millis())
}

fn run_of(entry: &Value, build_repo: &str) -> Option<CiRun> {
    let status = status_of(entry);
    let build_number = entry["build_number"].as_i64();
    let url = match build_number {
        Some(number) => format!("https://bitbucket.org/{build_repo}/pipelines/results/{number}"),
        None => format!("https://bitbucket.org/{build_repo}/pipelines"),
    };
    Some(CiRun {
        id: entry["uuid"].as_str()?.to_string(),
        build_number,
        url,
        status,
        finished_at: finished_at(entry, status),
    })
}

pub(super) async fn observe(
    runner: &dyn CommandRunner,
    flow: &DeployFlow,
    commit: &str,
) -> CiObservation {
    let path = format!("/repositories/{}/pipelines/", flow.build_repo);
    let args = owned(&["api", &path, "-P", "sort=-created_on", "-P", "pagelen=30"]);
    let stdout = match call(runner, TOOL, args).await {
        Ok(stdout) => stdout,
        Err(problem) => return CiObservation::Unavailable(problem),
    };
    let Ok(body) = serde_json::from_str::<Value>(&stdout) else {
        return CiObservation::Unavailable(unexpected_response(TOOL));
    };
    let Some(entries) = body["values"].as_array() else {
        return CiObservation::Unavailable(unexpected_response(TOOL));
    };
    match entries.iter().find(|entry| matches_flow(entry, flow, commit)) {
        None => CiObservation::NoRun,
        Some(entry) => match run_of(entry, &flow.build_repo) {
            Some(run) => CiObservation::Run(run),
            None => CiObservation::Unavailable(unexpected_response(TOOL)),
        },
    }
}

pub(super) async fn failure_log(
    runner: &dyn CommandRunner,
    flow: &DeployFlow,
    run: &CiRun,
) -> Option<String> {
    let build_number = run.build_number?;
    let (workspace, repo) = flow.build_repo.split_once('/')?;
    let steps_path = format!("/repositories/{}/pipelines/{}/steps/", flow.build_repo, run.id);
    let steps_args = owned(&["api", &steps_path, "-P", "pagelen=100"]);
    let steps_body = call(runner, TOOL, steps_args).await.ok()?;
    let steps: Value = serde_json::from_str(&steps_body).ok()?;
    let step_id = steps["values"]
        .as_array()?
        .iter()
        .find(|step| {
            matches!(step["state"]["result"]["name"].as_str(), Some("FAILED") | Some("ERROR"))
        })?["uuid"]
        .as_str()?
        .to_string();
    let args = owned(&[
        "pipeline",
        "logs",
        &build_number.to_string(),
        "--workspace",
        workspace,
        "--repo",
        repo,
        "--step",
        &step_id,
    ]);
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
    use crate::deploy::test_support::flow;
    use serde_json::json;

    const HASH: &str = "0b3b32f909976eecc82a02a13a1e336d6e429991";
    const OTHER_HASH: &str = "ffffffffffffffffffffffffffffffffffffffff";

    fn branch_target(hash: &str, branch: &str) -> Value {
        json!({
            "type": "pipeline_ref_target",
            "ref_type": "branch",
            "ref_name": branch,
            "selector": { "type": "branches", "pattern": branch },
            "commit": { "type": "commit", "hash": hash }
        })
    }

    fn pull_request_target(hash: &str) -> Value {
        json!({
            "type": "pipeline_pullrequest_target",
            "commit": { "type": "commit", "hash": hash }
        })
    }

    fn pipeline(build: i64, target: Value, state: Value, completed_on: Option<&str>) -> Value {
        let mut entry = json!({
            "uuid": format!("{{uuid-{build}}}"),
            "build_number": build,
            "state": state,
            "target": target,
            "created_on": "2026-11-23T11:05:16.374642169Z"
        });
        if let Some(completed) = completed_on {
            entry["completed_on"] = json!(completed);
        }
        entry
    }

    fn completed(result: &str) -> Value {
        json!({
            "name": "COMPLETED",
            "type": "pipeline_state_completed",
            "result": { "name": result, "type": "pipeline_state_completed_result" }
        })
    }

    fn list(entries: Vec<Value>) -> String {
        json!({ "values": entries }).to_string()
    }

    fn runner_with(entries: Vec<Value>) -> FakeRunner {
        FakeRunner::new().on("bkt", &["api"], ok(&list(entries)))
    }

    #[tokio::test]
    async fn bitbucket_follows_only_the_run_on_the_production_branch() {
        let runner = runner_with(vec![
            pipeline(
                308,
                pull_request_target(HASH),
                json!({ "name": "IN_PROGRESS", "stage": { "name": "RUNNING" } }),
                None,
            ),
            pipeline(
                307,
                branch_target(HASH, "master"),
                completed("SUCCESSFUL"),
                Some("2026-11-23T11:26:47.605337643Z"),
            ),
        ]);
        let CiObservation::Run(run) = observe(&runner, &flow(), HASH).await else { panic!() };
        assert_eq!(run.id, "{uuid-307}");
        assert_eq!(run.build_number, Some(307));
        assert_eq!(run.url, "https://bitbucket.org/cybercode/hr-management/pipelines/results/307");
        assert_eq!(run.status, CiStatus::Succeeded);
        assert_eq!(run.finished_at, Some(1_795_433_207_605));
    }

    #[tokio::test]
    async fn a_run_on_another_branch_of_the_same_commit_is_ignored() {
        let runner = runner_with(vec![pipeline(
            5,
            branch_target(HASH, "feature/x"),
            completed("SUCCESSFUL"),
            None,
        )]);
        assert_eq!(observe(&runner, &flow(), HASH).await, CiObservation::NoRun);
    }

    #[tokio::test]
    async fn the_newest_matching_run_wins() {
        let runner = runner_with(vec![
            pipeline(
                9,
                branch_target(HASH, "master"),
                json!({ "name": "IN_PROGRESS", "stage": { "name": "RUNNING" } }),
                None,
            ),
            pipeline(8, branch_target(HASH, "master"), completed("FAILED"), None),
        ]);
        let CiObservation::Run(run) = observe(&runner, &flow(), HASH).await else { panic!() };
        assert_eq!(run.build_number, Some(9));
        assert_eq!(run.status, CiStatus::Running);
    }

    #[tokio::test]
    async fn bitbucket_maps_paused_failed_and_running() {
        let cases = [
            ("PAUSED", "IN_PROGRESS", None, CiStatus::Paused),
            ("HALTED", "IN_PROGRESS", None, CiStatus::Paused),
            ("RUNNING", "IN_PROGRESS", None, CiStatus::Running),
            ("", "PENDING", None, CiStatus::Running),
            ("", "COMPLETED", Some("SUCCESSFUL"), CiStatus::Succeeded),
            ("", "COMPLETED", Some("FAILED"), CiStatus::Failed),
            ("", "COMPLETED", Some("ERROR"), CiStatus::Failed),
            ("", "COMPLETED", Some("STOPPED"), CiStatus::Failed),
            ("", "COMPLETED", Some("EXPIRED"), CiStatus::Failed),
        ];
        for (stage, state_name, result, expected) in cases {
            let mut state = json!({ "name": state_name });
            if !stage.is_empty() {
                state["stage"] = json!({ "name": stage });
            }
            if let Some(result) = result {
                state["result"] = json!({ "name": result });
            }
            let runner =
                runner_with(vec![pipeline(1, branch_target(HASH, "master"), state, None)]);
            let CiObservation::Run(run) = observe(&runner, &flow(), HASH).await else {
                panic!("no run for {stage} {state_name}")
            };
            assert_eq!(run.status, expected, "{stage} {state_name} {result:?}");
        }
    }

    #[tokio::test]
    async fn only_finished_runs_carry_a_finish_time() {
        let running = pipeline(
            1,
            branch_target(HASH, "master"),
            json!({ "name": "IN_PROGRESS", "stage": { "name": "RUNNING" } }),
            None,
        );
        let CiObservation::Run(run) = observe(&runner_with(vec![running]), &flow(), HASH).await
        else {
            panic!()
        };
        assert_eq!(run.finished_at, None);
        let failed = pipeline(
            2,
            branch_target(HASH, "master"),
            completed("FAILED"),
            Some("2026-11-23T11:26:47Z"),
        );
        let CiObservation::Run(run) = observe(&runner_with(vec![failed]), &flow(), HASH).await
        else {
            panic!()
        };
        assert_eq!(run.finished_at, Some(1_795_433_207_000));
    }

    #[tokio::test]
    async fn no_matching_commit_is_no_run() {
        let runner = runner_with(vec![pipeline(
            1,
            branch_target(OTHER_HASH, "master"),
            completed("SUCCESSFUL"),
            None,
        )]);
        assert_eq!(observe(&runner, &flow(), HASH).await, CiObservation::NoRun);
    }

    #[tokio::test]
    async fn a_short_hash_does_not_match_a_full_hash() {
        let runner = runner_with(vec![pipeline(
            1,
            branch_target(HASH, "master"),
            completed("SUCCESSFUL"),
            None,
        )]);
        assert_eq!(observe(&runner, &flow(), &HASH[..7]).await, CiObservation::NoRun);
    }

    #[tokio::test]
    async fn a_response_without_values_is_unexpected() {
        let runner = FakeRunner::new().on("bkt", &["api"], ok("{\"error\":{}}"));
        assert!(matches!(
            observe(&runner, &flow(), HASH).await,
            CiObservation::Unavailable(problem) if problem.reason == "nieoczekiwana odpowiedź"
        ));
    }

    #[tokio::test]
    async fn arguments_are_passed_as_separate_values() {
        let runner = FakeRunner::new().on("bkt", &["api"], ok("{\"values\":[]}"));
        observe(&runner, &flow(), "abc").await;
        let (program, args) = &runner.calls()[0];
        assert_eq!(program, "bkt");
        assert_eq!(
            args,
            &[
                "api",
                "/repositories/cybercode/hr-management/pipelines/",
                "-P",
                "sort=-created_on",
                "-P",
                "pagelen=30"
            ]
        );
    }

    fn failed_run() -> CiRun {
        CiRun {
            id: "{uuid-307}".to_string(),
            build_number: Some(307),
            url: String::new(),
            status: CiStatus::Failed,
            finished_at: None,
        }
    }

    const STEPS: &str = r#"{"values":[
        {"uuid":"{step-1}","state":{"name":"COMPLETED","result":{"name":"SUCCESSFUL"}}},
        {"uuid":"{step-2}","state":{"name":"COMPLETED","result":{"name":"FAILED"}}},
        {"uuid":"{step-3}","state":{"name":"COMPLETED","result":{"name":"ERROR"}}}
    ]}"#;

    #[tokio::test]
    async fn the_failure_log_comes_from_the_first_failed_step() {
        let runner = FakeRunner::new()
            .on(
                "bkt",
                &["api", "/repositories/cybercode/hr-management/pipelines/{uuid-307}/steps/"],
                ok(STEPS),
            )
            .on("bkt", &["pipeline", "logs"], ok("building\nDOCKER_PASSWORD=hunter2\nboom\n"));
        let log = failure_log(&runner, &flow(), &failed_run()).await.unwrap();
        assert_eq!(log, "building\nDOCKER_PASSWORD=***\nboom");
        let calls = runner.calls();
        assert_eq!(
            calls[0].1,
            [
                "api",
                "/repositories/cybercode/hr-management/pipelines/{uuid-307}/steps/",
                "-P",
                "pagelen=100"
            ]
        );
        assert_eq!(
            calls[1].1,
            [
                "pipeline",
                "logs",
                "307",
                "--workspace",
                "cybercode",
                "--repo",
                "hr-management",
                "--step",
                "{step-2}"
            ]
        );
    }

    #[tokio::test]
    async fn the_failure_log_keeps_the_last_sixty_lines() {
        let log: Vec<String> = (1..=100).map(|line| format!("line {line}")).collect();
        let runner = FakeRunner::new()
            .on("bkt", &["api"], ok(STEPS))
            .on("bkt", &["pipeline", "logs"], ok(&log.join("\n")));
        let excerpt = failure_log(&runner, &flow(), &failed_run()).await.unwrap();
        let lines: Vec<&str> = excerpt.lines().collect();
        assert_eq!(lines.len(), 60);
        assert_eq!(lines[0], "line 41");
        assert_eq!(lines[59], "line 100");
    }

    #[tokio::test]
    async fn no_failed_step_means_no_log() {
        let steps = r#"{"values":[{"uuid":"{s}","state":{"result":{"name":"SUCCESSFUL"}}}]}"#;
        let runner = FakeRunner::new().on("bkt", &["api"], ok(steps));
        assert_eq!(failure_log(&runner, &flow(), &failed_run()).await, None);
        assert_eq!(runner.calls().len(), 1);
    }

    #[tokio::test]
    async fn a_missing_tool_means_no_log() {
        let runner = FakeRunner::new().on("bkt", &["api"], Err(crate::deploy::runner::RunError::NotFound));
        assert_eq!(failure_log(&runner, &flow(), &failed_run()).await, None);
    }
}
