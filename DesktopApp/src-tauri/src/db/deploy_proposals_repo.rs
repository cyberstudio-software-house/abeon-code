use crate::domain::deploy::{DeployFlow, FlowProposal};
use crate::error::AppResult;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

const COLUMNS: &str = "id, repo_path, body, created_at, expires_at";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredBody {
    #[serde(flatten)]
    flow: DeployFlow,
    #[serde(default)]
    base_updated_at: Option<i64>,
}

fn corrupt(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        2,
        rusqlite::types::Type::Text,
        format!("invalid proposal body: {error}").into(),
    )
}

fn row_to_proposal(row: &rusqlite::Row) -> rusqlite::Result<FlowProposal> {
    let repo_path: String = row.get(1)?;
    let body: String = row.get(2)?;
    let stored: StoredBody = serde_json::from_str(&body).map_err(corrupt)?;
    Ok(FlowProposal {
        id: row.get(0)?,
        flow: DeployFlow { repo_path: repo_path.clone(), ..stored.flow },
        repo_path,
        created_at: row.get(3)?,
        expires_at: row.get(4)?,
        base_updated_at: stored.base_updated_at,
    })
}

pub fn insert(conn: &Connection, proposal: &FlowProposal) -> AppResult<()> {
    let body = serde_json::to_string(&StoredBody {
        flow: proposal.flow.clone(),
        base_updated_at: proposal.base_updated_at,
    })?;
    conn.execute(
        "INSERT INTO deploy_flow_proposals(id, repo_path, body, created_at, expires_at)
         VALUES(?,?,?,?,?)",
        params![
            proposal.id,
            proposal.repo_path,
            body,
            proposal.created_at,
            proposal.expires_at
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Option<FlowProposal>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM deploy_flow_proposals WHERE id = ?"),
            params![id],
            row_to_proposal,
        )
        .optional()?)
}

pub fn get_for_repo(conn: &Connection, repo_path: &str) -> AppResult<Option<FlowProposal>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM deploy_flow_proposals WHERE repo_path = ?"),
            params![repo_path],
            row_to_proposal,
        )
        .optional()?)
}

pub fn list(conn: &Connection) -> AppResult<Vec<FlowProposal>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM deploy_flow_proposals ORDER BY created_at, id"
    ))?;
    let rows = statement.query_map([], row_to_proposal)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM deploy_flow_proposals WHERE id = ?", params![id])?;
    Ok(())
}

pub fn delete_for_repo(conn: &Connection, repo_path: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM deploy_flow_proposals WHERE repo_path = ?",
        params![repo_path],
    )?;
    Ok(())
}

pub fn delete_expired(conn: &Connection, now: i64) -> AppResult<()> {
    conn.execute(
        "DELETE FROM deploy_flow_proposals WHERE expires_at <= ?",
        params![now],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy::test_support::{conn, flow_at};

    fn proposal(id: &str, repo_path: &str, created_at: i64) -> FlowProposal {
        FlowProposal {
            id: id.to_string(),
            repo_path: repo_path.to_string(),
            flow: flow_at(repo_path),
            created_at,
            expires_at: created_at + 100,
            base_updated_at: Some(created_at + 7),
        }
    }

    #[test]
    fn the_base_travels_inside_the_body_and_an_older_body_has_none() {
        let conn = conn();
        insert(&conn, &proposal("aaaaaaaa", "/r/a", 10)).unwrap();
        let body: String = conn
            .query_row("SELECT body FROM deploy_flow_proposals WHERE id = 'aaaaaaaa'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&body).unwrap()["baseUpdatedAt"], 17);
        assert_eq!(get(&conn, "aaaaaaaa").unwrap().unwrap().base_updated_at, Some(17));

        let legacy = serde_json::to_string(&flow_at("/r/b")).unwrap();
        conn.execute(
            "INSERT INTO deploy_flow_proposals(id, repo_path, body, created_at, expires_at)
             VALUES('bbbbbbbb', '/r/b', ?, 0, 100)",
            [legacy],
        )
        .unwrap();
        let read = get(&conn, "bbbbbbbb").unwrap().unwrap();
        assert_eq!(read.base_updated_at, None);
        assert_eq!(read.flow, flow_at("/r/b"));
    }

    #[test]
    fn finds_the_proposal_of_a_repository() {
        let conn = conn();
        insert(&conn, &proposal("aaaaaaaa", "/r/a", 10)).unwrap();
        assert_eq!(get_for_repo(&conn, "/r/a").unwrap(), Some(proposal("aaaaaaaa", "/r/a", 10)));
        assert_eq!(get_for_repo(&conn, "/r/b").unwrap(), None);
    }

    #[test]
    fn round_trips_and_lists_oldest_first() {
        let conn = conn();
        insert(&conn, &proposal("bbbbbbbb", "/r/b", 20)).unwrap();
        insert(&conn, &proposal("aaaaaaaa", "/r/a", 10)).unwrap();
        assert_eq!(get(&conn, "aaaaaaaa").unwrap(), Some(proposal("aaaaaaaa", "/r/a", 10)));
        assert_eq!(get(&conn, "cccccccc").unwrap(), None);
        let ids: Vec<String> = list(&conn).unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec!["aaaaaaaa".to_string(), "bbbbbbbb".to_string()]);
    }

    #[test]
    fn the_stored_row_decides_the_repository_of_the_flow() {
        let conn = conn();
        let mut forged = proposal("aaaaaaaa", "/r/a", 10);
        forged.flow.repo_path = "/r/elsewhere".to_string();
        insert(&conn, &forged).unwrap();
        let read = get(&conn, "aaaaaaaa").unwrap().unwrap();
        assert_eq!(read.flow.repo_path, "/r/a");
        assert_eq!(read.repo_path, "/r/a");
    }

    #[test]
    fn a_repository_holds_one_proposal() {
        let conn = conn();
        insert(&conn, &proposal("aaaaaaaa", "/r/a", 10)).unwrap();
        assert!(insert(&conn, &proposal("bbbbbbbb", "/r/a", 20)).is_err());
        delete_for_repo(&conn, "/r/a").unwrap();
        insert(&conn, &proposal("bbbbbbbb", "/r/a", 20)).unwrap();
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn deletes_by_id_and_by_expiry() {
        let conn = conn();
        insert(&conn, &proposal("aaaaaaaa", "/r/a", 0)).unwrap();
        insert(&conn, &proposal("bbbbbbbb", "/r/b", 50)).unwrap();
        insert(&conn, &proposal("cccccccc", "/r/c", 50)).unwrap();
        delete_expired(&conn, 99).unwrap();
        assert_eq!(list(&conn).unwrap().len(), 3);
        delete_expired(&conn, 100).unwrap();
        assert_eq!(get(&conn, "aaaaaaaa").unwrap(), None);
        delete(&conn, "bbbbbbbb").unwrap();
        let ids: Vec<String> = list(&conn).unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec!["cccccccc".to_string()]);
    }

    #[test]
    fn a_corrupt_body_is_an_error() {
        let conn = conn();
        conn.execute(
            "INSERT INTO deploy_flow_proposals(id, repo_path, body, created_at, expires_at)
             VALUES('aaaaaaaa', '/r/a', 'not json', 0, 100)",
            [],
        )
        .unwrap();
        assert!(get(&conn, "aaaaaaaa").is_err());
    }
}
