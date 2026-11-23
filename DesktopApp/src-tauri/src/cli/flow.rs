use std::io::{IsTerminal, Read};
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::{db_path, deploy_flows_repo, init_pool, projects_repo};
use crate::deploy::detect::detect_flow;
use crate::deploy::proposals;
use crate::deploy::repos::{is_known_repo, normalize, project_repos, repo_for_dir};
use crate::domain::deploy::{BuildProvider, DeployFlow, Delivery, FlowProposal};
use crate::sessions::reader::now_ms;
#[cfg(unix)]
use crate::supervisor::ipc::{request_blocking, socket_path, IpcRequest};

pub const USAGE: &str = "usage: abeon-code flow show | abeon-code flow detect | abeon-code flow propose <<'ABEON_FLOW' … ABEON_FLOW";
const MAX_FLOW_BYTES: u64 = 64 * 1024;

#[derive(Debug, PartialEq)]
pub enum FlowAction {
    Show,
    Detect,
    Propose,
}

#[derive(Debug, PartialEq)]
pub struct FlowCommand {
    pub action: FlowAction,
    pub cwd: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShownFlow {
    repo_path: String,
    flow: Option<DeployFlow>,
    proposal: Option<FlowProposal>,
}

fn enabled_by_default() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FlowInput {
    #[serde(default)]
    repo_path: Option<String>,
    #[serde(default = "enabled_by_default")]
    enabled: bool,
    remote: String,
    build: BuildProvider,
    #[serde(default)]
    build_repo: String,
    production_branch: String,
    delivery: Delivery,
    #[serde(default)]
    namespace: String,
    #[serde(default)]
    workloads: Vec<String>,
    #[serde(default)]
    kube_context: Option<String>,
    #[serde(default, rename = "updatedAt")]
    _updated_at: serde::de::IgnoredAny,
}

enum Target {
    Repo(String),
    Repos(Vec<String>),
}

pub fn parse(args: &[String]) -> Option<Result<FlowCommand, String>> {
    if args.get(1).map(String::as_str) != Some("flow") {
        return None;
    }
    Some(parse_flow_args(&args[2..]))
}

fn parse_flow_args(args: &[String]) -> Result<FlowCommand, String> {
    let usage = || USAGE.to_string();
    let action = match args.first().map(String::as_str) {
        Some("show") => FlowAction::Show,
        Some("detect") => FlowAction::Detect,
        Some("propose") => FlowAction::Propose,
        _ => return Err(usage()),
    };
    let mut cwd = None;
    let mut rest = args[1..].iter();
    while let Some(flag) = rest.next() {
        match flag.as_str() {
            "--cwd" => cwd = Some(PathBuf::from(rest.next().ok_or_else(usage)?)),
            _ => return Err(usage()),
        }
    }
    Ok(FlowCommand { action, cwd })
}

fn outside(dir: &Path) -> String {
    format!("{} is not inside a repository of an AbeonCode project", dir.display())
}

fn target(conn: &Connection, dir: &Path) -> Result<Target, String> {
    let projects = projects_repo::list(conn).map_err(|error| error.to_string())?;
    if let Some(repo) = repo_for_dir(dir).filter(|repo| is_known_repo(&projects, repo)) {
        return Ok(Target::Repo(repo.to_string_lossy().to_string()));
    }
    let wanted = normalize(dir);
    projects
        .iter()
        .find(|project| normalize(Path::new(&project.path)) == wanted)
        .map(|project| {
            Target::Repos(
                project_repos(project)
                    .iter()
                    .map(|repo| repo.to_string_lossy().to_string())
                    .collect(),
            )
        })
        .ok_or_else(|| outside(dir))
}

fn to_json<T: Serialize>(value: &T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

fn shown_flow(conn: &Connection, repo_path: String, pending: &[FlowProposal]) -> Result<ShownFlow, String> {
    Ok(ShownFlow {
        flow: deploy_flows_repo::get(conn, &repo_path).map_err(|error| error.to_string())?,
        proposal: pending
            .iter()
            .find(|proposal| proposal.repo_path == repo_path)
            .cloned(),
        repo_path,
    })
}

pub fn show(conn: &Connection, dir: &Path, now: i64) -> Result<Value, String> {
    let pending = proposals::pending(conn, now).map_err(|error| error.to_string())?;
    match target(conn, dir)? {
        Target::Repo(repo) => to_json(&shown_flow(conn, repo, &pending)?),
        Target::Repos(repos) => to_json(
            &repos
                .into_iter()
                .map(|repo| shown_flow(conn, repo, &pending))
                .collect::<Result<Vec<_>, _>>()?,
        ),
    }
}

pub fn detect(conn: &Connection, dir: &Path) -> Result<Value, String> {
    match target(conn, dir)? {
        Target::Repo(repo) => to_json(&detect_flow(Path::new(&repo))),
        Target::Repos(repos) => to_json(
            &repos
                .iter()
                .map(|repo| detect_flow(Path::new(repo)))
                .collect::<Vec<_>>(),
        ),
    }
}

fn repo_of_input(conn: &Connection, dir: &Path, requested: Option<String>) -> Result<String, String> {
    match requested.map(|path| path.trim().to_string()).filter(|path| !path.is_empty()) {
        Some(path) if Path::new(&path).is_absolute() => Ok(path),
        Some(path) => Ok(dir.join(path).to_string_lossy().to_string()),
        None => match target(conn, dir)? {
            Target::Repo(repo) => Ok(repo),
            Target::Repos(repos) => Err(format!(
                "{} holds several repositories; set repoPath in the flow JSON to one of: {}",
                dir.display(),
                repos.join(", ")
            )),
        },
    }
}

pub fn propose(conn: &Connection, dir: &Path, input: &str, now: i64) -> Result<FlowProposal, String> {
    if input.trim().is_empty() {
        return Err("empty flow on stdin".to_string());
    }
    let input: FlowInput =
        serde_json::from_str(input).map_err(|error| format!("invalid flow JSON: {error}"))?;
    let repo_path = repo_of_input(conn, dir, input.repo_path)?;
    let flow = DeployFlow {
        repo_path,
        enabled: input.enabled,
        remote: input.remote,
        build: input.build,
        build_repo: input.build_repo,
        production_branch: input.production_branch,
        delivery: input.delivery,
        namespace: input.namespace,
        workloads: input.workloads,
        kube_context: input.kube_context,
        updated_at: 0,
    };
    proposals::create(conn, flow, now)
}

fn read_stdin() -> Result<String, String> {
    if std::io::stdin().is_terminal() {
        return Err(USAGE.to_string());
    }
    let mut input = String::new();
    std::io::stdin()
        .take(MAX_FLOW_BYTES + 1)
        .read_to_string(&mut input)
        .map_err(|error| format!("cannot read the flow from stdin: {error}"))?;
    if input.len() as u64 > MAX_FLOW_BYTES {
        return Err(format!("flow too long (max {MAX_FLOW_BYTES} bytes)"));
    }
    Ok(input)
}

fn pretty(value: &Value) -> Result<String, String> {
    serde_json::to_string_pretty(value).map_err(|error| error.to_string())
}

fn run_command(cmd: &FlowCommand) -> Result<String, String> {
    let input = match cmd.action {
        FlowAction::Propose => Some(read_stdin()?),
        FlowAction::Show | FlowAction::Detect => None,
    };
    let dir = match &cmd.cwd {
        Some(dir) => dir.clone(),
        None => std::env::current_dir().map_err(|error| error.to_string())?,
    };
    let path = db_path().map_err(|error| error.to_string())?;
    let pool = init_pool(&path).map_err(|error| error.to_string())?;
    let conn = pool.get().map_err(|error| error.to_string())?;
    match (&cmd.action, input) {
        (FlowAction::Show, _) => pretty(&show(&conn, &dir, now_ms())?),
        (FlowAction::Detect, _) => pretty(&detect(&conn, &dir)?),
        (FlowAction::Propose, input) => {
            let proposal = propose(&conn, &dir, &input.unwrap_or_default(), now_ms())?;
            notify_app(&proposal.repo_path);
            Ok(format!(
                "abeon-code: proposal {} is waiting for the user's confirmation in AbeonCode",
                proposal.id
            ))
        }
    }
}

#[cfg(unix)]
fn notify_app(repo_path: &str) {
    let _ = request_blocking(
        &socket_path(),
        &IpcRequest::DeployChanged {
            repo_path: Some(repo_path.to_string()),
        },
        std::time::Duration::from_secs(2),
    );
}

#[cfg(not(unix))]
fn notify_app(_repo_path: &str) {}

pub fn try_run(args: &[String]) -> Option<i32> {
    let parsed = parse(args)?;
    match parsed.and_then(|cmd| run_command(&cmd)) {
        Ok(output) => {
            println!("{output}");
            Some(0)
        }
        Err(message) => {
            for line in message.lines() {
                eprintln!("abeon-code: {line}");
            }
            Some(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy::test_support::{conn, flow_at, init_repo, write};
    use serde_json::json;
    use tempfile::tempdir;

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|part| part.to_string()).collect()
    }

    fn canonical(path: &Path) -> String {
        path.canonicalize().unwrap().to_string_lossy().to_string()
    }

    const INPUT: &str = r#"{
        "enabled": true,
        "remote": "origin",
        "build": "bitbucket",
        "buildRepo": "cybercode/api",
        "productionBranch": "master",
        "delivery": "image",
        "namespace": "cs-app-api",
        "workloads": ["app"],
        "kubeContext": null,
        "updatedAt": 123
    }"#;

    #[test]
    fn parses_the_three_subcommands_and_rejects_others() {
        assert_eq!(
            parse(&args(&["abeoncode", "flow", "show"])),
            Some(Ok(FlowCommand { action: FlowAction::Show, cwd: None }))
        );
        assert_eq!(
            parse(&args(&["abeoncode", "flow", "detect", "--cwd", "/p"])),
            Some(Ok(FlowCommand { action: FlowAction::Detect, cwd: Some(PathBuf::from("/p")) }))
        );
        assert_eq!(
            parse(&args(&["abeoncode", "flow", "propose", "--cwd", "/p"])),
            Some(Ok(FlowCommand { action: FlowAction::Propose, cwd: Some(PathBuf::from("/p")) }))
        );
        for rejected in [
            &["abeoncode", "flow", "bogus"][..],
            &["abeoncode", "flow"],
            &["abeoncode", "flow", "approve", "ab12cd34"],
            &["abeoncode", "flow", "show", "--cwd"],
            &["abeoncode", "flow", "show", "--force"],
        ] {
            assert_eq!(parse(&args(rejected)), Some(Err(USAGE.to_string())), "{rejected:?}");
        }
        assert_eq!(parse(&args(&["abeoncode", "note", "list"])), None);
        assert_eq!(parse(&args(&["abeoncode"])), None);
    }

    #[test]
    fn show_prints_the_flow_and_the_pending_proposal_of_the_repository() {
        let dir = tempdir().unwrap();
        init_repo(&dir.path().join("api"));
        std::fs::create_dir_all(dir.path().join("api/src")).unwrap();
        let conn = conn();
        projects_repo::insert(&conn, "p", dir.path().to_str().unwrap(), "-p", None).unwrap();
        let repo = canonical(&dir.path().join("api"));

        let empty = show(&conn, &dir.path().join("api/src"), 0).unwrap();
        assert_eq!(empty, json!({ "repoPath": repo, "flow": null, "proposal": null }));

        let saved = deploy_flows_repo::upsert(&conn, &flow_at(&repo)).unwrap();
        let mut proposed = flow_at(&repo);
        proposed.production_branch = "main".to_string();
        let proposal = proposals::create(&conn, proposed, 0).unwrap();
        let shown = show(&conn, &dir.path().join("api"), 1).unwrap();
        assert_eq!(shown["repoPath"], json!(repo));
        assert_eq!(shown["flow"], serde_json::to_value(&saved).unwrap());
        assert_eq!(shown["proposal"]["id"], json!(proposal.id));
        assert_eq!(shown["proposal"]["flow"]["productionBranch"], json!("main"));
    }

    #[test]
    fn show_and_detect_list_every_repository_of_a_folder_project() {
        let dir = tempdir().unwrap();
        init_repo(&dir.path().join("api"));
        init_repo(&dir.path().join("web"));
        write(dir.path().join("web"), "bitbucket-pipelines.yml", "pipelines: {}\n");
        let conn = conn();
        projects_repo::insert(&conn, "p", dir.path().to_str().unwrap(), "-p", None).unwrap();

        let shown = show(&conn, dir.path(), 0).unwrap();
        let paths: Vec<&str> = shown
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["repoPath"].as_str().unwrap())
            .collect();
        let expected = [canonical(&dir.path().join("api")), canonical(&dir.path().join("web"))];
        assert_eq!(paths, expected.iter().map(String::as_str).collect::<Vec<_>>());

        let detected = detect(&conn, dir.path()).unwrap();
        let detected = detected.as_array().unwrap();
        assert_eq!(detected.len(), 2);
        assert_eq!(detected[1]["repoPath"], json!(expected[1]));
        assert_eq!(detected[1]["build"], json!("bitbucket"));
    }

    #[test]
    fn detect_reads_the_repository_of_the_working_directory() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        write(dir.path(), ".github/workflows/deploy.yml", "on: push\n");
        let conn = conn();
        projects_repo::insert(&conn, "p", dir.path().to_str().unwrap(), "-p", None).unwrap();
        let detected = detect(&conn, dir.path()).unwrap();
        assert_eq!(detected["repoPath"], json!(canonical(dir.path())));
        assert_eq!(detected["build"], json!("github"));
    }

    #[test]
    fn propose_stores_a_proposal_for_the_repository_of_the_working_directory() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        let conn = conn();
        projects_repo::insert(&conn, "p", dir.path().to_str().unwrap(), "-p", None).unwrap();
        let repo = canonical(dir.path());

        let proposal = propose(&conn, &dir.path().join("src"), INPUT, 5).unwrap();

        assert_eq!(proposal.repo_path, repo);
        assert_eq!(proposal.flow.namespace, "cs-app-api");
        assert_eq!(proposal.flow.updated_at, 0);
        assert_eq!(proposal.created_at, 5);
        assert_eq!(deploy_flows_repo::get(&conn, &repo).unwrap(), None);
        assert_eq!(proposals::pending(&conn, 6).unwrap(), vec![proposal]);
    }

    #[test]
    fn propose_rejects_a_directory_outside_registered_projects() {
        let outside = tempdir().unwrap();
        init_repo(outside.path());
        let plain = tempdir().unwrap();
        let conn = conn();
        for dir in [outside.path(), plain.path()] {
            let error = propose(&conn, dir, INPUT, 0).unwrap_err();
            assert_eq!(
                error,
                format!("{} is not inside a repository of an AbeonCode project", dir.display())
            );
        }
        assert!(proposals::pending(&conn, 1).unwrap().is_empty());
    }

    #[test]
    fn propose_takes_an_explicit_repository_path_and_needs_one_in_a_folder_project() {
        let dir = tempdir().unwrap();
        init_repo(&dir.path().join("api"));
        init_repo(&dir.path().join("web"));
        let conn = conn();
        projects_repo::insert(&conn, "p", dir.path().to_str().unwrap(), "-p", None).unwrap();

        let error = propose(&conn, dir.path(), INPUT, 0).unwrap_err();
        assert!(error.contains("set repoPath"), "{error}");
        assert!(error.contains(&canonical(&dir.path().join("web"))), "{error}");

        let mut input: serde_json::Value = serde_json::from_str(INPUT).unwrap();
        input["repoPath"] = json!("web");
        let proposal = propose(&conn, dir.path(), &input.to_string(), 0).unwrap();
        assert_eq!(proposal.repo_path, canonical(&dir.path().join("web")));
    }

    #[test]
    fn propose_lists_validation_errors_one_per_line() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        let conn = conn();
        projects_repo::insert(&conn, "p", dir.path().to_str().unwrap(), "-p", None).unwrap();
        let mut input: serde_json::Value = serde_json::from_str(INPUT).unwrap();
        input["namespace"] = json!("x; rm");
        input["productionBranch"] = json!("-f");
        let error = propose(&conn, dir.path(), &input.to_string(), 0).unwrap_err();
        let lines: Vec<&str> = error.lines().collect();
        assert_eq!(lines.len(), 2, "{error}");
        assert!(lines.iter().any(|line| line.starts_with("namespace: ")));
        assert!(lines.iter().any(|line| line.starts_with("productionBranch: ")));
    }

    #[test]
    fn propose_refuses_malformed_or_unknown_input() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        let conn = conn();
        projects_repo::insert(&conn, "p", dir.path().to_str().unwrap(), "-p", None).unwrap();
        let mut typo: serde_json::Value = serde_json::from_str(INPUT).unwrap();
        typo["namepsace"] = json!("cs-app-api");
        for (input, expected) in [
            ("not json".to_string(), "invalid flow JSON"),
            (typo.to_string(), "namepsace"),
            (r#"{"remote":"origin"}"#.to_string(), "missing field"),
            ("  ".to_string(), "empty flow"),
        ] {
            let error = propose(&conn, dir.path(), &input, 0).unwrap_err();
            assert!(error.contains(expected), "{input}: {error}");
        }
        assert!(proposals::pending(&conn, 1).unwrap().is_empty());
    }

    #[test]
    fn the_flow_defaults_to_tracking_on_with_empty_optional_fields() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        let conn = conn();
        projects_repo::insert(&conn, "p", dir.path().to_str().unwrap(), "-p", None).unwrap();
        let minimal = r#"{"remote":"origin","build":"none","productionBranch":"main","delivery":"none"}"#;
        let proposal = propose(&conn, dir.path(), minimal, 0).unwrap();
        assert!(proposal.flow.enabled);
        assert_eq!(proposal.flow.build_repo, "");
        assert_eq!(proposal.flow.namespace, "");
        assert!(proposal.flow.workloads.is_empty());
        assert_eq!(proposal.flow.kube_context, None);
    }
}
