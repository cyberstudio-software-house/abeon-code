use crate::db::{deploy_flows_repo, deploy_trackings_repo, projects_repo};
use crate::deploy::detect::detect_flow;
use crate::deploy::repos::{is_known_repo, project_repos, projects_of_repo, repo_label};
use crate::deploy::tracker::DeployTracker;
use crate::deploy::validate::validate_flow;
use crate::deploy::{DEPLOY_CHANGED_EVENT, TRACKING_HISTORY};
use crate::domain::deploy::{DeployChangedEvent, DeployFlow, RepoFlow, Tracking, TrackingView};
use crate::domain::Project;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use git2::Repository;
use rusqlite::Connection;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

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
    project_repos(project)
        .into_iter()
        .map(|repo| {
            let repo_path = repo.to_string_lossy().to_string();
            let label = repo_label(&repo);
            Ok(RepoFlow {
                flow: deploy_flows_repo::get(conn, &repo_path)?,
                remotes: remote_names(&repo),
                proposal: None,
                repo_path,
                label,
            })
        })
        .collect()
}

fn normalize_flow(flow: DeployFlow) -> DeployFlow {
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

fn ensure_known_repo(conn: &Connection, repo_path: &str) -> AppResult<()> {
    let projects = projects_repo::list(conn)?;
    if is_known_repo(&projects, Path::new(repo_path)) {
        Ok(())
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
    ensure_known_repo(conn, &tracking.repo_path)?;
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

#[tauri::command(async)]
pub fn deploy_detect_flow(state: State<AppState>, repo_path: String) -> AppResult<DeployFlow> {
    let conn = state.db.get()?;
    ensure_known_repo(&conn, &repo_path)?;
    Ok(detect_flow(Path::new(&repo_path)))
}

#[tauri::command(async)]
pub fn deploy_save_flow(
    app: AppHandle,
    state: State<AppState>,
    tracker: State<Arc<DeployTracker>>,
    flow: DeployFlow,
) -> AppResult<DeployFlow> {
    let conn = state.db.get()?;
    ensure_known_repo(&conn, flow.repo_path.trim())?;
    let saved = persist_flow(&conn, flow)?;
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
    ensure_known_repo(&conn, &repo_path)?;
    deploy_flows_repo::delete(&conn, &repo_path)?;
    tracker.flows_changed();
    announce_change(&app, &repo_path);
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
    ensure_known_repo(&conn, &repo_path)?;
    let history = deploy_trackings_repo::history(&conn, &repo_path, TRACKING_HISTORY)?;
    tracking_views(&conn, history)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy::test_support::{conn, flow, flow_at, init_repo, project};
    use crate::domain::deploy::TrackingState;
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
        assert!(message.contains("Przestrzeń nazw"));
        assert!(message.contains("; "));
        assert!(deploy_flows_repo::get(&connection, "/r/a").unwrap().is_none());
    }

    #[test]
    fn rejects_a_path_that_belongs_to_no_project() {
        let connection = conn();
        let dir = tempdir().unwrap();
        init_repo(&dir.path().join("api"));
        let error = ensure_known_repo(&connection, dir.path().join("api").to_str().unwrap()).unwrap_err();
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

    #[test]
    fn accepts_a_repository_inside_a_registered_project() {
        let connection = conn();
        let dir = tempdir().unwrap();
        init_repo(&dir.path().join("api"));
        projects_repo::insert(&connection, "p", dir.path().to_str().unwrap(), "-p", None).unwrap();
        assert!(ensure_known_repo(&connection, dir.path().join("api").to_str().unwrap()).is_ok());
    }
}
