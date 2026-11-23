use crate::domain::deploy::{Tracking, TrackingState};
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, Params};

fn open_states() -> String {
    TrackingState::OPEN
        .iter()
        .map(|state| format!("'{}'", state.as_str()))
        .collect::<Vec<_>>()
        .join(", ")
}

fn row_to_tracking(row: &rusqlite::Row) -> rusqlite::Result<Tracking> {
    let id: i64 = row.get(0)?;
    let body: String = row.get(1)?;
    let mut tracking: Tracking = serde_json::from_str(&body).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(error))
    })?;
    tracking.id = id;
    Ok(tracking)
}

fn select(conn: &Connection, sql: &str, params: impl Params) -> AppResult<Vec<Tracking>> {
    let mut statement = conn.prepare(sql)?;
    let rows = statement.query_map(params, row_to_tracking)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn count(value: usize) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

pub fn insert(conn: &Connection, tracking: &Tracking) -> AppResult<Tracking> {
    conn.execute(
        "INSERT INTO deploy_trackings(repo_path, commit_sha, state, started_at, finished_at, dismissed, body)
         VALUES(?,?,?,?,?,?,?)",
        params![
            tracking.repo_path,
            tracking.commit,
            tracking.state.as_str(),
            tracking.started_at,
            tracking.finished_at,
            tracking.dismissed as i64,
            serde_json::to_string(tracking)?,
        ],
    )?;
    let mut saved = tracking.clone();
    saved.id = conn.last_insert_rowid();
    Ok(saved)
}

pub fn update(conn: &Connection, tracking: &Tracking) -> AppResult<()> {
    let changed = conn.execute(
        "UPDATE deploy_trackings
         SET repo_path = ?, commit_sha = ?, state = ?, started_at = ?, finished_at = ?, dismissed = ?, body = ?
         WHERE id = ?",
        params![
            tracking.repo_path,
            tracking.commit,
            tracking.state.as_str(),
            tracking.started_at,
            tracking.finished_at,
            tracking.dismissed as i64,
            serde_json::to_string(tracking)?,
            tracking.id,
        ],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!(
            "deploy tracking {}",
            tracking.id
        )));
    }
    Ok(())
}

pub fn open(conn: &Connection) -> AppResult<Vec<Tracking>> {
    select(
        conn,
        &format!(
            "SELECT id, body FROM deploy_trackings WHERE state IN ({}) ORDER BY id",
            open_states()
        ),
        [],
    )
}

pub fn latest_per_repo(conn: &Connection) -> AppResult<Vec<Tracking>> {
    select(
        conn,
        &format!(
            "SELECT id, body FROM deploy_trackings AS latest
             WHERE id = (SELECT MAX(id) FROM deploy_trackings WHERE repo_path = latest.repo_path)
               AND (state IN ({}) OR dismissed = 0)
             ORDER BY repo_path",
            open_states()
        ),
        [],
    )
}

pub fn history(conn: &Connection, repo_path: &str, limit: usize) -> AppResult<Vec<Tracking>> {
    select(
        conn,
        "SELECT id, body FROM deploy_trackings WHERE repo_path = ? ORDER BY id DESC LIMIT ?",
        params![repo_path, count(limit)],
    )
}

pub fn get(conn: &Connection, id: i64) -> AppResult<Tracking> {
    select(
        conn,
        "SELECT id, body FROM deploy_trackings WHERE id = ?",
        params![id],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| AppError::NotFound(format!("deploy tracking {id}")))
}

pub fn prune(conn: &Connection, keep_per_repo: usize) -> AppResult<()> {
    conn.execute(
        &format!(
            "DELETE FROM deploy_trackings WHERE id IN (
               SELECT id FROM (
                 SELECT id, ROW_NUMBER() OVER (PARTITION BY repo_path ORDER BY id DESC) AS position
                 FROM deploy_trackings WHERE state NOT IN ({})
               ) WHERE position > ?
             )",
            open_states()
        ),
        params![count(keep_per_repo)],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy::test_support::{conn, flow_at};
    use crate::domain::deploy::Blocker;

    fn tracking(repo: &str, commit: &str, state: TrackingState) -> Tracking {
        let mut tracking = Tracking::new(&flow_at(repo), commit, 1_000);
        tracking.state = state;
        if !tracking.is_open() {
            tracking.finished_at = Some(2_000);
        }
        tracking
    }

    fn commits(trackings: &[Tracking]) -> Vec<(String, String)> {
        trackings
            .iter()
            .map(|tracking| (tracking.repo_path.clone(), tracking.commit.clone()))
            .collect()
    }

    fn pair(repo: &str, commit: &str) -> (String, String) {
        (repo.to_string(), commit.to_string())
    }

    #[test]
    fn insert_assigns_an_id_and_update_round_trips() {
        let conn = conn();
        let first = insert(
            &conn,
            &tracking("/r/a", "aaa", TrackingState::WaitingForRun),
        )
        .unwrap();
        let second = insert(
            &conn,
            &tracking("/r/a", "bbb", TrackingState::WaitingForRun),
        )
        .unwrap();
        assert!(first.id > 0);
        assert!(second.id > first.id);
        assert_eq!(get(&conn, first.id).unwrap(), first);

        let mut changed = first.clone();
        changed.state = TrackingState::Delivering;
        changed.ci_blocker = Some(Blocker::ToolUnavailable {
            tool: "bkt".to_string(),
            reason: "not logged in".to_string(),
        });
        changed.cluster_blocker = Some(Blocker::ToolUnavailable {
            tool: "kubectl".to_string(),
            reason: "forbidden".to_string(),
        });
        changed.run_url = Some("https://example.test/run/1".to_string());
        changed.baseline_images = Some(vec!["app:1".to_string()]);
        changed.current_images = vec!["app:2".to_string()];
        changed.build_finished_at = Some(1_500);
        update(&conn, &changed).unwrap();
        assert_eq!(get(&conn, first.id).unwrap(), changed);
        assert_eq!(get(&conn, second.id).unwrap(), second);
    }

    #[test]
    fn the_scalar_columns_follow_the_body() {
        let conn = conn();
        let mut saved = insert(
            &conn,
            &tracking("/r/a", "aaa", TrackingState::WaitingForRun),
        )
        .unwrap();
        saved.state = TrackingState::Failed;
        saved.finished_at = Some(3_000);
        saved.dismissed = true;
        update(&conn, &saved).unwrap();
        let row: (String, String, String, i64, Option<i64>, i64) = conn
            .query_row(
                "SELECT repo_path, commit_sha, state, started_at, finished_at, dismissed
                 FROM deploy_trackings WHERE id = ?",
                [saved.id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            row,
            (
                "/r/a".to_string(),
                "aaa".to_string(),
                "failed".to_string(),
                1_000,
                Some(3_000),
                1
            )
        );
    }

    #[test]
    fn a_missing_tracking_is_not_found() {
        let conn = conn();
        assert!(matches!(get(&conn, 99), Err(AppError::NotFound(_))));
        let mut ghost = tracking("/r/a", "aaa", TrackingState::Building);
        ghost.id = 99;
        assert!(matches!(update(&conn, &ghost), Err(AppError::NotFound(_))));
    }

    #[test]
    fn open_returns_only_open_trackings() {
        let conn = conn();
        for (repo, commit, state) in [
            ("/r/a", "w", TrackingState::WaitingForRun),
            ("/r/a", "s", TrackingState::Succeeded),
            ("/r/b", "b", TrackingState::Building),
            ("/r/b", "f", TrackingState::Failed),
            ("/r/c", "p", TrackingState::Paused),
            ("/r/c", "t", TrackingState::Stalled),
            ("/r/d", "d", TrackingState::Delivering),
            ("/r/d", "x", TrackingState::Superseded),
        ] {
            insert(&conn, &tracking(repo, commit, state)).unwrap();
        }
        assert_eq!(
            commits(&open(&conn).unwrap()),
            vec![
                pair("/r/a", "w"),
                pair("/r/b", "b"),
                pair("/r/c", "p"),
                pair("/r/d", "d")
            ]
        );
    }

    #[test]
    fn latest_per_repo_hides_a_dismissed_closed_tracking_but_not_an_open_one() {
        let conn = conn();
        insert(&conn, &tracking("/r/a", "a-old", TrackingState::Succeeded)).unwrap();
        let mut dismissed = tracking("/r/a", "a-new", TrackingState::Failed);
        dismissed.dismissed = true;
        insert(&conn, &dismissed).unwrap();

        insert(&conn, &tracking("/r/b", "b-old", TrackingState::Superseded)).unwrap();
        let mut open_dismissed = tracking("/r/b", "b-new", TrackingState::Building);
        open_dismissed.dismissed = true;
        insert(&conn, &open_dismissed).unwrap();

        insert(&conn, &tracking("/r/c", "c-old", TrackingState::Failed)).unwrap();
        insert(&conn, &tracking("/r/c", "c-new", TrackingState::Succeeded)).unwrap();

        assert_eq!(
            commits(&latest_per_repo(&conn).unwrap()),
            vec![pair("/r/b", "b-new"), pair("/r/c", "c-new")]
        );
    }

    #[test]
    fn history_lists_the_newest_first_up_to_the_limit() {
        let conn = conn();
        for commit in ["one", "two", "three"] {
            insert(&conn, &tracking("/r/a", commit, TrackingState::Succeeded)).unwrap();
        }
        insert(&conn, &tracking("/r/b", "other", TrackingState::Succeeded)).unwrap();
        insert(&conn, &tracking("/r/a", "four", TrackingState::Building)).unwrap();
        assert_eq!(
            commits(&history(&conn, "/r/a", 3).unwrap()),
            vec![
                pair("/r/a", "four"),
                pair("/r/a", "three"),
                pair("/r/a", "two")
            ]
        );
        assert!(history(&conn, "/r/none", 3).unwrap().is_empty());
    }

    #[test]
    fn prune_keeps_the_newest_closed_trackings_of_each_repository_and_every_open_one() {
        let conn = conn();
        for commit in ["a1", "a2", "a3", "a4"] {
            insert(&conn, &tracking("/r/a", commit, TrackingState::Succeeded)).unwrap();
        }
        insert(
            &conn,
            &tracking("/r/a", "a-open", TrackingState::Delivering),
        )
        .unwrap();
        for commit in ["b1", "b2", "b3"] {
            insert(&conn, &tracking("/r/b", commit, TrackingState::Failed)).unwrap();
        }
        insert(&conn, &tracking("/r/c", "c1", TrackingState::Stalled)).unwrap();

        prune(&conn, 2).unwrap();

        assert_eq!(
            commits(&history(&conn, "/r/a", 10).unwrap()),
            vec![
                pair("/r/a", "a-open"),
                pair("/r/a", "a4"),
                pair("/r/a", "a3")
            ]
        );
        assert_eq!(
            commits(&history(&conn, "/r/b", 10).unwrap()),
            vec![pair("/r/b", "b3"), pair("/r/b", "b2")]
        );
        assert_eq!(
            commits(&history(&conn, "/r/c", 10).unwrap()),
            vec![pair("/r/c", "c1")]
        );
    }
}
