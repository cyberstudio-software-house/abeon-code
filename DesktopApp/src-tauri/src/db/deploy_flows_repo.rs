use crate::domain::deploy::{BuildProvider, DeployFlow, Delivery};
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};
use std::time::{SystemTime, UNIX_EPOCH};

const COLUMNS: &str = "repo_path, enabled, remote, build, build_repo, production_branch, \
     delivery, namespace, workloads, kube_context, updated_at";

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn corrupt(column: &str, value: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        format!("invalid {column}: {value}").into(),
    )
}

fn row_to_flow(row: &rusqlite::Row) -> rusqlite::Result<DeployFlow> {
    let build: String = row.get(3)?;
    let delivery: String = row.get(6)?;
    let workloads: String = row.get(8)?;
    Ok(DeployFlow {
        repo_path: row.get(0)?,
        enabled: row.get::<_, i64>(1)? != 0,
        remote: row.get(2)?,
        build: BuildProvider::parse(&build).ok_or_else(|| corrupt("build", &build))?,
        build_repo: row.get(4)?,
        production_branch: row.get(5)?,
        delivery: Delivery::parse(&delivery).ok_or_else(|| corrupt("delivery", &delivery))?,
        namespace: row.get(7)?,
        workloads: serde_json::from_str(&workloads)
            .map_err(|_| corrupt("workloads", &workloads))?,
        kube_context: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

pub fn get(conn: &Connection, repo_path: &str) -> AppResult<Option<DeployFlow>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM deploy_flows WHERE repo_path = ?"
    ))?;
    let mut rows = statement.query_map(params![repo_path], row_to_flow)?;
    match rows.next() {
        Some(flow) => Ok(Some(flow?)),
        None => Ok(None),
    }
}

pub fn list_enabled(conn: &Connection) -> AppResult<Vec<DeployFlow>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM deploy_flows WHERE enabled = 1 ORDER BY repo_path"
    ))?;
    let rows = statement.query_map([], row_to_flow)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn upsert(conn: &Connection, flow: &DeployFlow) -> AppResult<DeployFlow> {
    let updated_at = now_millis();
    let workloads = serde_json::to_string(&flow.workloads)?;
    conn.execute(
        "INSERT INTO deploy_flows(repo_path, enabled, remote, build, build_repo, production_branch,
                                  delivery, namespace, workloads, kube_context, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(repo_path) DO UPDATE SET
           enabled           = excluded.enabled,
           remote            = excluded.remote,
           build             = excluded.build,
           build_repo        = excluded.build_repo,
           production_branch = excluded.production_branch,
           delivery          = excluded.delivery,
           namespace         = excluded.namespace,
           workloads         = excluded.workloads,
           kube_context      = excluded.kube_context,
           updated_at        = excluded.updated_at",
        params![
            flow.repo_path,
            flow.enabled as i64,
            flow.remote,
            flow.build.as_str(),
            flow.build_repo,
            flow.production_branch,
            flow.delivery.as_str(),
            flow.namespace,
            workloads,
            flow.kube_context,
            updated_at,
        ],
    )?;
    get(conn, &flow.repo_path)?
        .ok_or_else(|| AppError::NotFound(format!("deploy flow {}", flow.repo_path)))
}

pub fn delete(conn: &Connection, repo_path: &str) -> AppResult<()> {
    conn.execute("DELETE FROM deploy_flows WHERE repo_path = ?", params![repo_path])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy::test_support::{conn, flow_at};

    #[test]
    fn upsert_round_trips_and_list_enabled_skips_disabled() {
        let conn = conn();
        let saved = upsert(&conn, &flow_at("/r/a")).unwrap();
        let mut off = flow_at("/r/b");
        off.enabled = false;
        upsert(&conn, &off).unwrap();
        assert_eq!(get(&conn, "/r/a").unwrap(), Some(saved.clone()));
        assert_eq!(list_enabled(&conn).unwrap(), vec![saved]);
        delete(&conn, "/r/a").unwrap();
        assert_eq!(get(&conn, "/r/a").unwrap(), None);
    }

    #[test]
    fn upsert_stamps_the_time_and_replaces_an_existing_row() {
        let conn = conn();
        let first = upsert(&conn, &flow_at("/r/a")).unwrap();
        assert!(first.updated_at > 0);

        let mut changed = flow_at("/r/a");
        changed.workloads = vec!["app".to_string(), "worker".to_string()];
        changed.kube_context = Some("prod".to_string());
        changed.build = BuildProvider::Github;
        changed.delivery = Delivery::Kubemeter;
        let second = upsert(&conn, &changed).unwrap();

        assert_eq!(second.workloads, vec!["app".to_string(), "worker".to_string()]);
        assert_eq!(second.kube_context.as_deref(), Some("prod"));
        assert_eq!(second.build, BuildProvider::Github);
        assert_eq!(second.delivery, Delivery::Kubemeter);
        assert!(second.updated_at >= first.updated_at);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM deploy_flows", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn migration_creates_the_tracking_and_proposal_tables() {
        let conn = conn();
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'
                 AND name IN ('deploy_flows','deploy_trackings','deploy_flow_proposals')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 3);
        let index: String = conn
            .query_row(
                "SELECT tbl_name FROM sqlite_master WHERE type='index' AND name='idx_deploy_trackings_repo'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index, "deploy_trackings");
    }
}
