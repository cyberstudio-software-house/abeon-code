use crate::db::{deploy_flows_repo, projects_repo};
use crate::deploy::repos::{is_known_repo, normalize};
use crate::deploy::validate::validate_flow;
use crate::domain::deploy::DeployFlow;
use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use std::path::Path;

pub fn normalize_flow(flow: DeployFlow) -> DeployFlow {
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

pub fn known_repo_path(conn: &Connection, repo_path: &str) -> AppResult<String> {
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

pub fn save_flow(conn: &Connection, flow: DeployFlow) -> AppResult<DeployFlow> {
    let repo_path = known_repo_path(conn, &flow.repo_path)?;
    persist_flow(conn, DeployFlow { repo_path, ..flow })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy::test_support::{conn, flow, init_repo};
    use tempfile::tempdir;

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

    #[test]
    fn accepts_a_repository_inside_a_registered_project() {
        let connection = conn();
        let dir = tempdir().unwrap();
        init_repo(&dir.path().join("api"));
        projects_repo::insert(&connection, "p", dir.path().to_str().unwrap(), "-p", None).unwrap();
        assert!(known_repo_path(&connection, dir.path().join("api").to_str().unwrap()).is_ok());
    }
}
