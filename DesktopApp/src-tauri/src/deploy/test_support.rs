use crate::db::init_pool;
use crate::domain::deploy::{BuildProvider, DeployFlow, Delivery};
use rusqlite::Connection;
use std::ops::Deref;
use tempfile::NamedTempFile;

pub struct TestConn {
    conn: r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>,
}

impl Deref for TestConn {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        &self.conn
    }
}

pub fn conn() -> TestConn {
    let file = NamedTempFile::new().unwrap();
    let path = file.path().to_path_buf();
    std::mem::forget(file);
    let pool = init_pool(&path).unwrap();
    TestConn { conn: pool.get().unwrap() }
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
