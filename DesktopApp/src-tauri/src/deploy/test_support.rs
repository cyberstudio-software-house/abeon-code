use crate::db::init_pool;
use crate::domain::deploy::{BuildProvider, DeployFlow, Delivery};
use crate::domain::Project;
use rusqlite::Connection;
use std::ops::Deref;
use std::path::Path;
use tempfile::{NamedTempFile, TempDir};

pub struct TestConn {
    conn: r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>,
    file: NamedTempFile,
}

impl TestConn {
    pub fn db_path(&self) -> &Path {
        self.file.path()
    }
}

impl Deref for TestConn {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        &self.conn
    }
}

pub fn conn() -> TestConn {
    let file = NamedTempFile::new().unwrap();
    let pool = init_pool(&file.path().to_path_buf()).unwrap();
    TestConn { conn: pool.get().unwrap(), file }
}

#[cfg(test)]
mod conn_tests {
    use super::*;

    #[test]
    fn the_temp_database_is_removed_when_the_fixture_drops() {
        let fixture = conn();
        let path = fixture.db_path().to_path_buf();
        assert!(path.exists());
        drop(fixture);
        assert!(!path.exists());
    }
}

pub fn init_repo(path: &Path) {
    std::fs::create_dir_all(path).unwrap();
    git2::Repository::init(path).unwrap();
}

pub fn repo_with_remote(name: &str, url: &str) -> TempDir {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    repo.remote(name, url).unwrap();
    dir
}

pub fn write(repo: impl AsRef<Path>, relative: &str, content: &str) {
    let target = repo.as_ref().join(relative);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(target, content).unwrap();
}

pub fn remote_ref(repo: impl AsRef<Path>, remote: &str, branch: &str) {
    let repo = git2::Repository::open(repo.as_ref()).unwrap();
    let signature = git2::Signature::now("test", "test@example.com").unwrap();
    let tree_id = repo.treebuilder(None).unwrap().write().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    let commit = repo.commit(None, &signature, &signature, "seed", &tree, &[]).unwrap();
    repo.reference(&format!("refs/remotes/{remote}/{branch}"), commit, true, "test").unwrap();
}

pub fn project(id: i64, path: &str) -> Project {
    Project {
        id,
        name: format!("project-{id}"),
        path: path.to_string(),
        claude_dir: String::new(),
        color: None,
        sort_order: id,
        created_at: 0,
    }
}

pub fn flow_at(path: &str) -> DeployFlow {
    DeployFlow {
        repo_path: path.to_string(),
        enabled: true,
        remote: "origin".to_string(),
        build: BuildProvider::Bitbucket,
        build_repo: "cybercode/hr-management".to_string(),
        production_branch: "master".to_string(),
        delivery: Delivery::Image,
        namespace: "cs-app-hs".to_string(),
        workloads: vec!["app".to_string()],
        kube_context: None,
        updated_at: 0,
    }
}

pub fn flow() -> DeployFlow {
    flow_at("/r/a")
}

pub fn flow_with(field: &str, value: &str) -> DeployFlow {
    let mut flow = flow();
    match field {
        "repoPath" => flow.repo_path = value.to_string(),
        "remote" => flow.remote = value.to_string(),
        "buildRepo" => flow.build_repo = value.to_string(),
        "productionBranch" => flow.production_branch = value.to_string(),
        "namespace" => flow.namespace = value.to_string(),
        "workloads" => flow.workloads = vec![value.to_string()],
        "kubeContext" => flow.kube_context = Some(value.to_string()),
        other => panic!("unknown flow field {other}"),
    }
    flow
}
