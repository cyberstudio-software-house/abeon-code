use crate::db::{deploy_flows_repo, deploy_trackings_repo, projects_repo, settings_repo};
use crate::deploy::detect::detect_flow;
use crate::deploy::proposals::{self, AnnouncedProposals, Resolution};
use crate::deploy::repos::{is_known_repo, normalize, project_repos, projects_of_repo, repo_label};
use crate::deploy::runner::{shell_runner, CommandOutput, CommandRunner, RunError};
use crate::deploy::tracker::DeployTracker;
use crate::deploy::validate::validate_flow;
use crate::deploy::{vpn, DEPLOY_CHANGED_EVENT, TRACKING_HISTORY, VPN_SETTING_KEY};
use crate::domain::deploy::{
    DeployChangedEvent, DeployFlow, DeploySettings, FlowProposal, ProposalView, RepoFlow,
    ToolStatus, Tracking, TrackingView,
};
use crate::domain::Project;
use crate::error::{AppError, AppResult};
use crate::sessions::reader::now_ms;
use crate::state::AppState;
use git2::Repository;
use regex::Regex;
use rusqlite::Connection;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const TOOL_TIMEOUT: Duration = Duration::from_secs(5);
const TOOL_DETAIL_LIMIT: usize = 120;
const TOOL_MISSING: &str = "nie znaleziono";
const VPN_NAME_INVALID: &str = "Nazwa połączenia zawiera niedozwolone znaki";

fn vpn_name_pattern() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    CELL.get_or_init(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9 ._-]*$").unwrap())
}

fn limit_detail(text: &str) -> String {
    text.chars().take(TOOL_DETAIL_LIMIT).collect()
}

fn first_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).find(|line| !line.is_empty())
}

fn tool_status(tool: &str, result: Result<CommandOutput, RunError>) -> ToolStatus {
    let (found, detail) = match result {
        Ok(output) => {
            let line = first_line(&output.stdout).or_else(|| first_line(&output.stderr));
            let found = output.status == Some(0) || line.is_some();
            let detail = match (line, output.status) {
                (Some(line), _) => limit_detail(line),
                (None, Some(0)) => String::new(),
                (None, Some(code)) => format!("polecenie zakończyło się kodem {code}"),
                (None, None) => "polecenie zostało przerwane".to_string(),
            };
            (found, detail)
        }
        Err(RunError::NotFound) => (false, TOOL_MISSING.to_string()),
        Err(RunError::TimedOut) => (false, "przekroczono czas oczekiwania".to_string()),
        Err(RunError::Io(message)) => (false, limit_detail(&message)),
    };
    ToolStatus { tool: tool.to_string(), found, detail }
}

async fn check_tools(runner: &dyn CommandRunner, include_nmcli: bool) -> Vec<ToolStatus> {
    let mut checks: Vec<(&str, &[&str])> = vec![
        ("bkt", &["--version"]),
        ("gh", &["--version"]),
        ("kubectl", &["version", "--client"]),
    ];
    if include_nmcli {
        checks.push(("nmcli", &["--version"]));
    }
    futures_util::future::join_all(checks.into_iter().map(|(tool, args)| async move {
        let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
        tool_status(tool, runner.run(tool, &args, TOOL_TIMEOUT).await)
    }))
    .await
}

fn normalize_vpn_connection(name: Option<String>) -> AppResult<Option<String>> {
    let Some(name) = name.map(|name| name.trim().to_string()).filter(|name| !name.is_empty()) else {
        return Ok(None);
    };
    if vpn_name_pattern().is_match(&name) {
        Ok(Some(name))
    } else {
        Err(AppError::Other(VPN_NAME_INVALID.to_string()))
    }
}

fn store_vpn_connection(conn: &Connection, name: Option<String>) -> AppResult<()> {
    match normalize_vpn_connection(name)? {
        Some(name) => settings_repo::set(conn, VPN_SETTING_KEY, &name),
        None => settings_repo::delete(conn, VPN_SETTING_KEY),
    }
}

fn load_deploy_settings(conn: &Connection) -> AppResult<DeploySettings> {
    Ok(DeploySettings {
        vpn_connection: settings_repo::get(conn, VPN_SETTING_KEY)?,
        vpn_supported: vpn::supported(),
    })
}

fn remote_names(repo_path: &Path) -> Vec<String> {
    let Ok(repo) = Repository::open(repo_path) else { return Vec::new() };
    let mut names: Vec<String> = repo
        .remotes()
        .map(|list| list.iter().flatten().map(String::from).collect())
        .unwrap_or_default();
    names.sort();
    names
}

fn repo_flows(conn: &Connection, project: &Project) -> AppResult<Vec<RepoFlow>> {
    let pending = proposals::pending(conn, now_ms())?;
    project_repos(project)
        .into_iter()
        .map(|repo| {
            let repo_path = repo.to_string_lossy().to_string();
            let label = repo_label(&repo);
            Ok(RepoFlow {
                flow: deploy_flows_repo::get(conn, &repo_path)?,
                remotes: remote_names(&repo),
                proposal: pending
                    .iter()
                    .find(|proposal| proposal.repo_path == repo_path)
                    .cloned(),
                repo_path,
                label,
            })
        })
        .collect()
}

fn proposal_views(conn: &Connection, pending: Vec<FlowProposal>) -> AppResult<Vec<ProposalView>> {
    let projects = projects_repo::list(conn)?;
    pending
        .into_iter()
        .map(|proposal| {
            let repo = Path::new(&proposal.repo_path);
            let current = deploy_flows_repo::get(conn, &proposal.repo_path)?;
            Ok(ProposalView {
                changes: proposals::diff(current.as_ref(), &proposal.flow),
                project_ids: projects_of_repo(&projects, repo),
                repo_label: repo_label(repo),
                proposal,
            })
        })
        .collect()
}

pub(crate) fn normalize_flow(flow: DeployFlow) -> DeployFlow {
    DeployFlow {
        repo_path: flow.repo_path.trim().to_string(),
        remote: flow.remote.trim().to_string(),
        build_repo: flow.build_repo.trim().to_string(),
        production_branch: flow.production_branch.trim().to_string(),
        namespace: flow.namespace.trim().to_string(),
        workloads: flow
            .workloads
            .iter()
            .map(|workload| workload.trim().to_string())
            .filter(|workload| !workload.is_empty())
            .collect(),
        kube_context: flow
            .kube_context
            .map(|context| context.trim().to_string())
            .filter(|context| !context.is_empty()),
        ..flow
    }
}

fn persist_flow(conn: &Connection, flow: DeployFlow) -> AppResult<DeployFlow> {
    let flow = normalize_flow(flow);
    if let Err(errors) = validate_flow(&flow) {
        let message = errors
            .iter()
            .map(|error| error.message.as_str())
            .collect::<Vec<_>>()
            .join("; ");
        return Err(AppError::Other(message));
    }
    deploy_flows_repo::upsert(conn, &flow)
}

pub(crate) fn known_repo_path(conn: &Connection, repo_path: &str) -> AppResult<String> {
    let projects = projects_repo::list(conn)?;
    let path = Path::new(repo_path.trim());
    if is_known_repo(&projects, path) {
        Ok(normalize(path).to_string_lossy().to_string())
    } else {
        Err(AppError::InvalidPath {
            path: repo_path.to_string(),
            reason: "not a repository of any project".to_string(),
        })
    }
}

fn announce_change(app: &AppHandle, repo_path: &str) {
    let event = DeployChangedEvent { repo_path: Some(repo_path.to_string()) };
    if let Err(error) = app.emit(DEPLOY_CHANGED_EVENT, event) {
        eprintln!("deploy: change event failed: {error}");
    }
}

fn tracking_views(conn: &Connection, trackings: Vec<Tracking>) -> AppResult<Vec<TrackingView>> {
    let projects = projects_repo::list(conn)?;
    Ok(trackings
        .into_iter()
        .map(|tracking| {
            let repo = Path::new(&tracking.repo_path);
            TrackingView {
                project_ids: projects_of_repo(&projects, repo),
                repo_label: repo_label(repo),
                tracking,
            }
        })
        .collect())
}

fn known_tracking(conn: &Connection, tracking_id: i64) -> AppResult<Tracking> {
    let tracking = deploy_trackings_repo::get(conn, tracking_id)?;
    known_repo_path(conn, &tracking.repo_path)?;
    Ok(tracking)
}

fn dismiss_tracking(conn: &Connection, tracking_id: i64) -> AppResult<Tracking> {
    let mut tracking = known_tracking(conn, tracking_id)?;
    if tracking.is_open() {
        return Err(AppError::InvalidInput(format!(
            "deploy tracking {tracking_id} is still running"
        )));
    }
    tracking.dismissed = true;
    deploy_trackings_repo::update(conn, &tracking)?;
    Ok(tracking)
}

#[tauri::command(async)]
pub fn deploy_list_repo_flows(state: State<AppState>, project_id: i64) -> AppResult<Vec<RepoFlow>> {
    let conn = state.db.get()?;
    let project = projects_repo::list(&conn)?
        .into_iter()
        .find(|project| project.id == project_id)
        .ok_or_else(|| AppError::NotFound(format!("project {project_id}")))?;
    repo_flows(&conn, &project)
}

fn detect_repo_flow(conn: &Connection, repo_path: &str) -> AppResult<DeployFlow> {
    let canonical = known_repo_path(conn, repo_path)?;
    Ok(detect_flow(Path::new(&canonical)))
}

pub(crate) fn save_flow(conn: &Connection, flow: DeployFlow) -> AppResult<DeployFlow> {
    let repo_path = known_repo_path(conn, &flow.repo_path)?;
    persist_flow(conn, DeployFlow { repo_path, ..flow })
}

fn delete_flow(conn: &Connection, repo_path: &str) -> AppResult<String> {
    let canonical = known_repo_path(conn, repo_path)?;
    deploy_flows_repo::delete(conn, &canonical)?;
    Ok(canonical)
}

fn repo_history(conn: &Connection, repo_path: &str) -> AppResult<Vec<TrackingView>> {
    let canonical = known_repo_path(conn, repo_path)?;
    let history = deploy_trackings_repo::history(conn, &canonical, TRACKING_HISTORY)?;
    tracking_views(conn, history)
}

#[tauri::command(async)]
pub fn deploy_detect_flow(state: State<AppState>, repo_path: String) -> AppResult<DeployFlow> {
    let conn = state.db.get()?;
    detect_repo_flow(&conn, &repo_path)
}

#[tauri::command(async)]
pub fn deploy_save_flow(
    app: AppHandle,
    state: State<AppState>,
    tracker: State<Arc<DeployTracker>>,
    flow: DeployFlow,
) -> AppResult<DeployFlow> {
    let conn = state.db.get()?;
    let saved = save_flow(&conn, flow)?;
    tracker.flows_changed();
    announce_change(&app, &saved.repo_path);
    Ok(saved)
}

#[tauri::command(async)]
pub fn deploy_delete_flow(
    app: AppHandle,
    state: State<AppState>,
    tracker: State<Arc<DeployTracker>>,
    repo_path: String,
) -> AppResult<()> {
    let conn = state.db.get()?;
    let canonical = delete_flow(&conn, &repo_path)?;
    tracker.flows_changed();
    announce_change(&app, &canonical);
    Ok(())
}

#[tauri::command(async)]
pub fn deploy_list_trackings(state: State<AppState>) -> AppResult<Vec<TrackingView>> {
    let conn = state.db.get()?;
    let latest = deploy_trackings_repo::latest_per_repo(&conn)?;
    tracking_views(&conn, latest)
}

#[tauri::command(async)]
pub fn deploy_tracking_history(
    state: State<AppState>,
    repo_path: String,
) -> AppResult<Vec<TrackingView>> {
    let conn = state.db.get()?;
    repo_history(&conn, &repo_path)
}

#[tauri::command(async)]
pub fn deploy_retry(
    state: State<AppState>,
    tracker: State<Arc<DeployTracker>>,
    tracking_id: i64,
) -> AppResult<()> {
    let conn = state.db.get()?;
    let tracking = known_tracking(&conn, tracking_id)?;
    if tracking.is_open() {
        tracker.retry(tracking.id);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn deploy_dismiss(app: AppHandle, state: State<AppState>, tracking_id: i64) -> AppResult<()> {
    let conn = state.db.get()?;
    let tracking = dismiss_tracking(&conn, tracking_id)?;
    announce_change(&app, &tracking.repo_path);
    Ok(())
}

#[tauri::command(async)]
pub fn deploy_list_proposals(state: State<AppState>) -> AppResult<Vec<ProposalView>> {
    let conn = state.db.get()?;
    let pending = proposals::pending(&conn, now_ms())?;
    proposal_views(&conn, pending)
}

pub fn resolve_proposal(
    app: &AppHandle,
    proposal_id: &str,
    approve: bool,
) -> AppResult<Option<Resolution>> {
    let resolution = {
        let conn = app.state::<AppState>().db.get()?;
        proposals::resolve(&conn, proposal_id, approve, now_ms())?
    };
    if let Some(resolution) = &resolution {
        if let Some(tracker) = app.try_state::<Arc<DeployTracker>>() {
            tracker.flows_changed();
        }
        announce_change(app, resolution.repo_path());
    }
    Ok(resolution)
}

#[tauri::command(async)]
pub fn deploy_resolve_proposal(app: AppHandle, proposal_id: String, approve: bool) -> AppResult<()> {
    match resolve_proposal(&app, &proposal_id, approve)? {
        Some(_) => Ok(()),
        None => Err(AppError::Other(proposals::EXPIRED_TEXT.to_string())),
    }
}

fn new_proposals(app: &AppHandle) -> AppResult<Vec<ProposalView>> {
    let conn = app.state::<AppState>().db.get()?;
    let pending = proposals::pending(&conn, now_ms())?;
    let fresh = match app.try_state::<AnnouncedProposals>() {
        Some(announced) => announced.take_new(&pending),
        None => Vec::new(),
    };
    proposal_views(&conn, fresh)
}

pub fn proposals_changed(app: &AppHandle, repo_path: Option<String>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let reader = app.clone();
        let fresh = tauri::async_runtime::spawn_blocking(move || new_proposals(&reader))
            .await
            .map_err(|error| AppError::Other(error.to_string()))
            .and_then(|views| views);
        if let Err(error) = app.emit(DEPLOY_CHANGED_EVENT, DeployChangedEvent { repo_path }) {
            eprintln!("deploy: change event failed: {error}");
        }
        let views = match fresh {
            Ok(views) => views,
            Err(error) => {
                eprintln!("deploy: reading flow proposals failed: {error}");
                return;
            }
        };
        for view in views {
            let notice = proposals::discord_notice(&view);
            let outcome = match crate::supervisor::runtime::post_discord_notice(&app, notice).await {
                Ok(()) => "sent to Discord".to_string(),
                Err(reason) => format!("not sent to Discord ({reason})"),
            };
            eprintln!(
                "deploy: flow proposal {} for {}: {outcome}",
                view.proposal.id, view.repo_label
            );
        }
    });
}

#[tauri::command(async)]
pub async fn deploy_tools_status(app: AppHandle) -> AppResult<Vec<ToolStatus>> {
    let runner = tauri::async_runtime::spawn_blocking(move || shell_runner(&app.state::<AppState>()))
        .await
        .map_err(|error| AppError::Other(error.to_string()))?;
    Ok(check_tools(&runner, vpn::supported()).await)
}

#[tauri::command(async)]
pub fn deploy_get_settings(state: State<AppState>) -> AppResult<DeploySettings> {
    let conn = state.db.get()?;
    load_deploy_settings(&conn)
}

#[tauri::command(async)]
pub fn deploy_set_vpn_connection(state: State<AppState>, name: Option<String>) -> AppResult<()> {
    let conn = state.db.get()?;
    store_vpn_connection(&conn, name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy::runner::{ok, FakeRunner};
    use crate::deploy::test_support::{conn, flow, flow_at, init_repo, project};
    use crate::domain::deploy::{FlowChange, TrackingState};
    use tempfile::tempdir;

    #[test]
    fn lists_every_repository_of_the_project_with_its_saved_flow() {
        let dir = tempdir().unwrap();
        init_repo(&dir.path().join("api"));
        init_repo(&dir.path().join("web"));
        git2::Repository::open(dir.path().join("web"))
            .unwrap()
            .remote("origin", "git@bitbucket.org:cybercode/web.git")
            .unwrap();
        let root = dir.path().canonicalize().unwrap();
        let connection = conn();
        let saved = flow_at(root.join("api").to_str().unwrap());
        deploy_flows_repo::upsert(&connection, &saved).unwrap();

        let entries = repo_flows(&connection, &project(1, dir.path().to_str().unwrap())).unwrap();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].label, "api");
        assert_eq!(entries[1].label, "web");
        assert_eq!(entries[0].flow.as_ref().map(|f| f.namespace.as_str()), Some("cs-app-hs"));
        assert!(entries[1].flow.is_none());
        assert!(entries[0].remotes.is_empty());
        assert_eq!(entries[1].remotes, vec!["origin".to_string()]);
        assert!(entries.iter().all(|entry| entry.proposal.is_none()));
    }

    #[test]
    fn normalizes_text_workloads_and_a_blank_kube_context() {
        let mut dirty = flow();
        dirty.remote = " origin ".to_string();
        dirty.build_repo = " cybercode/hr-management ".to_string();
        dirty.production_branch = "\tmaster\n".to_string();
        dirty.namespace = " cs-app-hs ".to_string();
        dirty.workloads = vec![" app ".to_string(), "  ".to_string(), String::new(), "worker".to_string()];
        dirty.kube_context = Some("   ".to_string());

        let clean = normalize_flow(dirty);

        assert_eq!(clean.remote, "origin");
        assert_eq!(clean.build_repo, "cybercode/hr-management");
        assert_eq!(clean.production_branch, "master");
        assert_eq!(clean.namespace, "cs-app-hs");
        assert_eq!(clean.workloads, vec!["app".to_string(), "worker".to_string()]);
        assert_eq!(clean.kube_context, None);
    }

    #[test]
    fn keeps_a_trimmed_kube_context() {
        let mut with_context = flow();
        with_context.kube_context = Some(" prod-cluster ".to_string());
        assert_eq!(normalize_flow(with_context).kube_context, Some("prod-cluster".to_string()));
    }

    #[test]
    fn persists_a_normalized_flow() {
        let connection = conn();
        let mut dirty = flow();
        dirty.namespace = " cs-app-hs ".to_string();
        dirty.workloads = vec![" app ".to_string(), String::new()];
        dirty.kube_context = Some(String::new());

        let saved = persist_flow(&connection, dirty).unwrap();

        assert_eq!(saved.namespace, "cs-app-hs");
        assert_eq!(saved.workloads, vec!["app".to_string()]);
        let stored = deploy_flows_repo::get(&connection, &saved.repo_path).unwrap().unwrap();
        assert_eq!(stored.kube_context, None);
    }

    #[test]
    fn joins_validation_messages_and_stores_nothing() {
        let connection = conn();
        let mut invalid = flow();
        invalid.namespace = "x; rm -rf ~".to_string();
        invalid.production_branch = String::new();

        let error = persist_flow(&connection, invalid).unwrap_err();

        let AppError::Other(message) = error else { panic!("expected AppError::Other") };
        assert!(message.contains("Gałąź produkcyjna"));
        assert!(message.contains("Pole „Namespace” zawiera niedozwolone znaki"));
        assert!(message.contains("; "));
        assert!(deploy_flows_repo::get(&connection, "/r/a").unwrap().is_none());
    }

    #[test]
    fn rejects_a_path_that_belongs_to_no_project() {
        let connection = conn();
        let dir = tempdir().unwrap();
        init_repo(&dir.path().join("api"));
        let error = known_repo_path(&connection, dir.path().join("api").to_str().unwrap()).unwrap_err();
        assert!(matches!(error, AppError::InvalidPath { .. }));
    }

    fn registered_repo(connection: &Connection) -> (tempfile::TempDir, String, i64) {
        let dir = tempdir().unwrap();
        init_repo(&dir.path().join("api"));
        let project = projects_repo::insert(connection, "p", dir.path().to_str().unwrap(), "-p", None).unwrap();
        let repo = dir.path().join("api").to_str().unwrap().to_string();
        (dir, repo, project.id)
    }

    fn stored(connection: &Connection, repo: &str, state: TrackingState) -> Tracking {
        let mut tracking = Tracking::new(&flow_at(repo), "abc", 1_000);
        tracking.state = state;
        if !tracking.is_open() {
            tracking.finished_at = Some(2_000);
        }
        deploy_trackings_repo::insert(connection, &tracking).unwrap()
    }

    #[test]
    fn tracking_views_carry_the_projects_and_the_directory_name() {
        let connection = conn();
        let (_dir, repo, project_id) = registered_repo(&connection);
        let tracking = stored(&connection, &repo, TrackingState::Building);

        let views = tracking_views(&connection, vec![tracking.clone()]).unwrap();

        assert_eq!(
            views,
            vec![TrackingView { tracking, project_ids: vec![project_id], repo_label: "api".to_string() }]
        );
    }

    #[test]
    fn only_a_closed_tracking_of_a_known_repository_is_dismissed() {
        let connection = conn();
        let (_dir, repo, _) = registered_repo(&connection);
        let open = stored(&connection, &repo, TrackingState::Delivering);
        let closed = stored(&connection, &repo, TrackingState::Failed);

        assert!(matches!(dismiss_tracking(&connection, open.id), Err(AppError::InvalidInput(_))));
        assert!(!deploy_trackings_repo::get(&connection, open.id).unwrap().dismissed);

        let dismissed = dismiss_tracking(&connection, closed.id).unwrap();
        assert!(dismissed.dismissed);
        assert_eq!(deploy_trackings_repo::get(&connection, closed.id).unwrap(), dismissed);
        assert!(matches!(dismiss_tracking(&connection, 999), Err(AppError::NotFound(_))));
    }

    #[test]
    fn a_tracking_of_an_unknown_repository_is_refused() {
        let connection = conn();
        let outside = tempdir().unwrap();
        init_repo(outside.path());
        let tracking = stored(&connection, outside.path().to_str().unwrap(), TrackingState::Failed);

        assert!(matches!(known_tracking(&connection, tracking.id), Err(AppError::InvalidPath { .. })));
        assert!(matches!(dismiss_tracking(&connection, tracking.id), Err(AppError::InvalidPath { .. })));
        assert!(!deploy_trackings_repo::get(&connection, tracking.id).unwrap().dismissed);
    }

    fn vpn_value(connection: &Connection) -> Option<String> {
        settings_repo::get(connection, VPN_SETTING_KEY).unwrap()
    }

    #[test]
    fn a_stored_vpn_name_is_trimmed_and_read_back() {
        let connection = conn();
        store_vpn_connection(&connection, Some("  Office VPN-2 ".to_string())).unwrap();

        assert_eq!(vpn_value(&connection), Some("Office VPN-2".to_string()));
        let settings = load_deploy_settings(&connection).unwrap();
        assert_eq!(settings.vpn_connection, Some("Office VPN-2".to_string()));
        assert_eq!(settings.vpn_supported, vpn::supported());
    }

    #[test]
    fn an_invalid_vpn_name_is_refused_and_keeps_the_stored_one() {
        let connection = conn();
        store_vpn_connection(&connection, Some("Office".to_string())).unwrap();

        for name in ["-flag", "a;b", "$(id)", "vpn\nname", "ąę"] {
            let error = store_vpn_connection(&connection, Some(name.to_string())).unwrap_err();
            let AppError::Other(message) = error else { panic!("expected AppError::Other") };
            assert_eq!(message, "Nazwa połączenia zawiera niedozwolone znaki", "{name:?}");
        }
        assert_eq!(vpn_value(&connection), Some("Office".to_string()));
    }

    #[test]
    fn an_empty_or_missing_vpn_name_clears_the_setting() {
        let connection = conn();
        for cleared in [None, Some(String::new()), Some("   ".to_string())] {
            store_vpn_connection(&connection, Some("Office".to_string())).unwrap();
            store_vpn_connection(&connection, cleared).unwrap();
            assert_eq!(vpn_value(&connection), None);
        }
        assert_eq!(load_deploy_settings(&connection).unwrap().vpn_connection, None);
    }

    fn output(status: Option<i32>, stdout: &str, stderr: &str) -> Result<CommandOutput, RunError> {
        Ok(CommandOutput { status, stdout: stdout.to_string(), stderr: stderr.to_string() })
    }

    #[test]
    fn a_tool_that_prints_a_version_is_found_with_the_first_line() {
        let status = tool_status("gh", output(Some(0), "\ngh version 2.40.0\nhttps://example.test\n", ""));
        assert_eq!(
            status,
            ToolStatus { tool: "gh".to_string(), found: true, detail: "gh version 2.40.0".to_string() }
        );
    }

    #[test]
    fn a_version_printed_on_stderr_still_counts_as_found() {
        let zero = tool_status("bkt", output(Some(0), "", "bkt 1.2.3\n"));
        assert!(zero.found);
        assert_eq!(zero.detail, "bkt 1.2.3");

        let nonzero = tool_status("bkt", output(Some(2), "", "bkt 1.2.3\n"));
        assert!(nonzero.found);
        assert_eq!(nonzero.detail, "bkt 1.2.3");
    }

    #[test]
    fn a_silent_zero_exit_is_found_and_a_silent_failure_is_not() {
        let silent = tool_status("nmcli", output(Some(0), "", ""));
        assert!(silent.found);
        assert_eq!(silent.detail, "");

        let failed = tool_status("nmcli", output(Some(3), "", ""));
        assert!(!failed.found);
        assert_eq!(failed.detail, "polecenie zakończyło się kodem 3");

        let killed = tool_status("nmcli", output(None, "", ""));
        assert!(!killed.found);
        assert_eq!(killed.detail, "polecenie zostało przerwane");
    }

    #[test]
    fn run_errors_map_to_a_missing_tool_with_a_reason() {
        let missing = tool_status("kubectl", Err(RunError::NotFound));
        assert_eq!(
            missing,
            ToolStatus { tool: "kubectl".to_string(), found: false, detail: "nie znaleziono".to_string() }
        );
        let slow = tool_status("kubectl", Err(RunError::TimedOut));
        assert!(!slow.found);
        assert_eq!(slow.detail, "przekroczono czas oczekiwania");
        let broken = tool_status("kubectl", Err(RunError::Io("boom".to_string())));
        assert!(!broken.found);
        assert_eq!(broken.detail, "boom");
    }

    #[test]
    fn the_detail_is_capped_at_120_characters() {
        let long = "ł".repeat(300);
        let from_output = tool_status("gh", output(Some(0), &long, ""));
        assert_eq!(from_output.detail.chars().count(), 120);
        let from_error = tool_status("gh", Err(RunError::Io(long)));
        assert_eq!(from_error.detail.chars().count(), 120);
    }

    #[tokio::test]
    async fn every_tool_is_checked_with_its_own_version_command() {
        let runner = FakeRunner::new()
            .on("bkt", &["--version"], ok("bkt 1.0\n"))
            .on("gh", &["--version"], ok("gh 2.0\n"))
            .on("kubectl", &["version", "--client"], ok("Client Version: v1.30.0\n"))
            .on("nmcli", &["--version"], Err(RunError::NotFound));

        let statuses = check_tools(&runner, true).await;

        let names: Vec<&str> = statuses.iter().map(|status| status.tool.as_str()).collect();
        assert_eq!(names, vec!["bkt", "gh", "kubectl", "nmcli"]);
        assert_eq!(
            statuses.iter().map(|status| status.found).collect::<Vec<_>>(),
            vec![true, true, true, false]
        );
        assert_eq!(statuses[2].detail, "Client Version: v1.30.0");
        assert_eq!(statuses[3].detail, "nie znaleziono");
        let mut calls = runner.calls();
        calls.sort();
        assert_eq!(calls.len(), 4);
        assert!(calls.contains(&(
            "kubectl".to_string(),
            vec!["version".to_string(), "--client".to_string()]
        )));
    }

    #[tokio::test]
    async fn nmcli_is_neither_run_nor_listed_when_the_vpn_is_unsupported() {
        let runner = FakeRunner::new()
            .on("bkt", &["--version"], ok("bkt 1.0\n"))
            .on("gh", &["--version"], ok("gh 2.0\n"))
            .on("kubectl", &["version", "--client"], ok("v1\n"));

        let statuses = check_tools(&runner, false).await;

        let names: Vec<&str> = statuses.iter().map(|status| status.tool.as_str()).collect();
        assert_eq!(names, vec!["bkt", "gh", "kubectl"]);
        assert!(runner.calls().iter().all(|(program, _)| program != "nmcli"));
    }

    #[cfg(unix)]
    fn spellings_of(dir: &tempfile::TempDir) -> Vec<String> {
        let alias = dir.path().parent().unwrap().join(format!(
            "alias-{}",
            dir.path().file_name().unwrap().to_string_lossy()
        ));
        std::os::unix::fs::symlink(dir.path().join("api"), &alias).unwrap();
        vec![
            format!("{}/", dir.path().join("api").display()),
            format!("{}/./", dir.path().join("api").display()),
            alias.to_string_lossy().to_string(),
        ]
    }

    #[cfg(not(unix))]
    fn spellings_of(dir: &tempfile::TempDir) -> Vec<String> {
        vec![format!("{}\\", dir.path().join("api").display())]
    }

    fn canonical_of(dir: &tempfile::TempDir) -> String {
        dir.path().join("api").canonicalize().unwrap().to_string_lossy().to_string()
    }

    #[test]
    fn a_flow_saved_under_another_spelling_is_stored_and_listed_under_the_canonical_path() {
        let connection = conn();
        let (dir, _, project_id) = registered_repo(&connection);
        let canonical = canonical_of(&dir);
        for spelling in spellings_of(&dir) {
            let saved = save_flow(&connection, flow_at(&format!(" {spelling} "))).unwrap();
            assert_eq!(saved.repo_path, canonical, "{spelling}");
            let project = projects_repo::list(&connection)
                .unwrap()
                .into_iter()
                .find(|project| project.id == project_id)
                .unwrap();
            let listed = repo_flows(&connection, &project).unwrap();
            assert_eq!(
                listed[0].flow.as_ref().map(|flow| flow.repo_path.as_str()),
                Some(canonical.as_str()),
                "{spelling}"
            );
        }
    }

    #[test]
    fn deleting_under_another_spelling_removes_the_canonical_flow() {
        let connection = conn();
        let (dir, _, _) = registered_repo(&connection);
        let canonical = canonical_of(&dir);
        for spelling in spellings_of(&dir) {
            save_flow(&connection, flow_at(&canonical)).unwrap();
            let deleted = delete_flow(&connection, &spelling).unwrap();
            assert_eq!(deleted, canonical);
            assert!(deploy_flows_repo::get(&connection, &canonical).unwrap().is_none(), "{spelling}");
        }
    }

    #[test]
    fn detection_and_history_resolve_another_spelling_to_the_canonical_path() {
        let connection = conn();
        let (dir, _, _) = registered_repo(&connection);
        let canonical = canonical_of(&dir);
        stored(&connection, &canonical, TrackingState::Failed);
        for spelling in spellings_of(&dir) {
            assert_eq!(detect_repo_flow(&connection, &spelling).unwrap().repo_path, canonical, "{spelling}");
            let history = repo_history(&connection, &spelling).unwrap();
            assert_eq!(history.len(), 1, "{spelling}");
            assert_eq!(history[0].tracking.repo_path, canonical);
        }
    }

    #[test]
    fn an_unknown_repository_is_refused_by_every_repository_command() {
        let connection = conn();
        let outside = tempdir().unwrap();
        init_repo(outside.path());
        let path = outside.path().to_str().unwrap();
        assert!(matches!(save_flow(&connection, flow_at(path)), Err(AppError::InvalidPath { .. })));
        assert!(matches!(delete_flow(&connection, path), Err(AppError::InvalidPath { .. })));
        assert!(matches!(detect_repo_flow(&connection, path), Err(AppError::InvalidPath { .. })));
        assert!(matches!(repo_history(&connection, path), Err(AppError::InvalidPath { .. })));
    }

    fn project_of(connection: &Connection, project_id: i64) -> Project {
        projects_repo::list(connection)
            .unwrap()
            .into_iter()
            .find(|project| project.id == project_id)
            .unwrap()
    }

    #[test]
    fn a_pending_proposal_is_listed_with_its_repository() {
        let connection = conn();
        let (dir, _, project_id) = registered_repo(&connection);
        let canonical = canonical_of(&dir);
        let proposal = proposals::create(&connection, flow_at(&canonical), now_ms()).unwrap();

        let listed = repo_flows(&connection, &project_of(&connection, project_id)).unwrap();

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].proposal, Some(proposal));
        assert_eq!(listed[0].flow, None);
    }

    #[test]
    fn proposal_views_carry_the_label_the_projects_and_the_changes() {
        let connection = conn();
        let (dir, _, project_id) = registered_repo(&connection);
        let canonical = canonical_of(&dir);
        deploy_flows_repo::upsert(&connection, &flow_at(&canonical)).unwrap();
        let mut proposed = flow_at(&canonical);
        proposed.production_branch = "main".to_string();
        let proposal = proposals::create(&connection, proposed, now_ms()).unwrap();

        let views = proposal_views(&connection, vec![proposal.clone()]).unwrap();

        assert_eq!(
            views,
            vec![ProposalView {
                proposal,
                repo_label: "api".to_string(),
                project_ids: vec![project_id],
                changes: vec![FlowChange {
                    field: "productionBranch".to_string(),
                    label: "Gałąź produkcyjna".to_string(),
                    before: Some("master".to_string()),
                    after: "main".to_string(),
                }],
            }]
        );
    }

    #[test]
    fn accepts_a_repository_inside_a_registered_project() {
        let connection = conn();
        let dir = tempdir().unwrap();
        init_repo(&dir.path().join("api"));
        projects_repo::insert(&connection, "p", dir.path().to_str().unwrap(), "-p", None).unwrap();
        assert!(known_repo_path(&connection, dir.path().join("api").to_str().unwrap()).is_ok());
    }
}
