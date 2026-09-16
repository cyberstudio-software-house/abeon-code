use crate::domain::Note;
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};

fn row_to_note(row: &rusqlite::Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        content: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

pub fn list(conn: &Connection, project_id: Option<i64>) -> AppResult<Vec<Note>> {
    let notes = match project_id {
        Some(project_id) => {
            let mut statement = conn.prepare(
                "SELECT id,project_id,title,content,created_at,updated_at
                 FROM notes WHERE project_id=? ORDER BY updated_at DESC, id DESC",
            )?;
            let rows = statement.query_map(params![project_id], row_to_note)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        }
        None => {
            let mut statement = conn.prepare(
                "SELECT id,project_id,title,content,created_at,updated_at
                 FROM notes WHERE project_id IS NULL ORDER BY updated_at DESC, id DESC",
            )?;
            let rows = statement.query_map([], row_to_note)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        }
    };
    Ok(notes)
}

pub fn get(conn: &Connection, id: i64) -> AppResult<Note> {
    conn.query_row(
        "SELECT id,project_id,title,content,created_at,updated_at FROM notes WHERE id=?",
        params![id],
        row_to_note,
    )
    .map_err(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => AppError::NotFound(format!("note {id}")),
        error => AppError::Db(error),
    })
}

pub fn create(
    conn: &Connection,
    project_id: Option<i64>,
    title: &str,
    content: &str,
) -> AppResult<Note> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::InvalidInput("tytuł jest wymagany".into()));
    }
    if let Some(project_id) = project_id {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)",
            params![project_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(AppError::InvalidInput("projekt nie istnieje".into()));
        }
    }
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO notes(project_id,title,content,created_at,updated_at) VALUES(?,?,?,?,?)",
        params![project_id, title, content, now, now],
    )?;
    get(conn, conn.last_insert_rowid())
}

pub fn update(conn: &Connection, id: i64, title: &str, content: &str) -> AppResult<Note> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::InvalidInput("tytuł jest wymagany".into()));
    }
    let updated_at = chrono::Utc::now().timestamp_millis();
    let affected = conn.execute(
        "UPDATE notes SET title=?,content=?,updated_at=? WHERE id=?",
        params![title, content, updated_at, id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("note {id}")));
    }
    get(conn, id)
}

pub fn delete(conn: &Connection, id: i64) -> AppResult<()> {
    let affected = conn.execute("DELETE FROM notes WHERE id=?", params![id])?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("note {id}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_pool, projects_repo};
    use tempfile::NamedTempFile;

    fn pool() -> crate::db::DbPool {
        let file = NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();
        std::mem::forget(file);
        init_pool(&path).unwrap()
    }

    #[test]
    fn separates_global_and_project_notes() {
        let pool = pool();
        let conn = pool.get().unwrap();
        let project = projects_repo::insert(&conn, "Demo", "/demo", "-demo", None).unwrap();
        create(&conn, None, "Global", "G").unwrap();
        create(&conn, Some(project.id), "Project", "P").unwrap();
        assert_eq!(list(&conn, None).unwrap()[0].title, "Global");
        assert_eq!(list(&conn, Some(project.id)).unwrap()[0].title, "Project");
    }

    #[test]
    fn updates_and_orders_by_latest_change() {
        let pool = pool();
        let conn = pool.get().unwrap();
        let first = create(&conn, None, "First", "A").unwrap();
        let second = create(&conn, None, "Second", "B").unwrap();
        conn.execute(
            "UPDATE notes SET updated_at=1 WHERE id IN (?1, ?2)",
            [first.id, second.id],
        )
        .unwrap();
        update(&conn, first.id, "First updated", "C").unwrap();
        let notes = list(&conn, None).unwrap();
        assert_eq!(notes[0].id, first.id);
        assert_eq!(notes[1].id, second.id);
    }

    #[test]
    fn validates_title_and_missing_records() {
        let pool = pool();
        let conn = pool.get().unwrap();
        assert!(matches!(
            create(&conn, None, "   ", ""),
            Err(AppError::InvalidInput(_))
        ));
        assert!(matches!(
            update(&conn, 404, "Title", ""),
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(delete(&conn, 404), Err(AppError::NotFound(_))));
    }

    #[test]
    fn rejects_missing_project_without_creating_a_note() {
        let pool = pool();
        let conn = pool.get().unwrap();
        assert!(matches!(
            create(&conn, Some(404), "Title", "Content"),
            Err(AppError::InvalidInput(_))
        ));
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn rejects_blank_update_without_changing_the_note() {
        let pool = pool();
        let conn = pool.get().unwrap();
        let note = create(&conn, None, "Original", "Original content").unwrap();

        assert!(matches!(
            update(&conn, note.id, " \t\n ", "Changed content"),
            Err(AppError::InvalidInput(_))
        ));

        let unchanged = get(&conn, note.id).unwrap();
        assert_eq!(unchanged.title, "Original");
        assert_eq!(unchanged.content, "Original content");
        assert_eq!(unchanged.created_at, note.created_at);
        assert_eq!(unchanged.updated_at, note.updated_at);
    }

    #[test]
    fn trims_title_on_create_without_trimming_content() {
        let pool = pool();
        let conn = pool.get().unwrap();
        let note = create(&conn, None, " \t First title \n", "  Content \n").unwrap();
        assert_eq!(note.title, "First title");
        assert_eq!(note.content, "  Content \n");
        assert_eq!(get(&conn, note.id).unwrap().title, "First title");
    }

    #[test]
    fn trims_title_on_update_and_accepts_empty_content() {
        let pool = pool();
        let conn = pool.get().unwrap();
        let note = create(&conn, None, "Original", "Original content").unwrap();
        let updated = update(&conn, note.id, "\n Updated title \t", "").unwrap();
        assert_eq!(updated.title, "Updated title");
        assert_eq!(updated.content, "");
        let stored = get(&conn, note.id).unwrap();
        assert_eq!(stored.title, "Updated title");
        assert_eq!(stored.content, "");
    }

    #[test]
    fn breaks_equal_timestamp_ties_by_descending_id_in_both_scopes() {
        let pool = pool();
        let conn = pool.get().unwrap();
        let project = projects_repo::insert(&conn, "Demo", "/demo", "-demo", None).unwrap();
        conn.execute("DROP INDEX idx_notes_project_updated", []).unwrap();

        for project_id in [None, Some(project.id)] {
            let first = create(&conn, project_id, "First", "").unwrap();
            let second = create(&conn, project_id, "Second", "").unwrap();
            conn.execute(
                "UPDATE notes SET updated_at=1700000000000 WHERE id IN (?1, ?2)",
                [first.id, second.id],
            )
            .unwrap();

            let notes = list(&conn, project_id).unwrap();
            assert_eq!(
                notes.iter().map(|note| note.id).collect::<Vec<_>>(),
                vec![second.id, first.id]
            );
            assert!(notes.iter().all(|note| note.updated_at == 1700000000000));
        }
    }

    #[test]
    fn cascades_project_notes_only() {
        let pool = pool();
        let conn = pool.get().unwrap();
        let project = projects_repo::insert(&conn, "Demo", "/demo", "-demo", None).unwrap();
        create(&conn, None, "Global", "").unwrap();
        create(&conn, Some(project.id), "Project", "").unwrap();
        projects_repo::delete(&conn, project.id).unwrap();
        assert_eq!(list(&conn, None).unwrap().len(), 1);
        assert!(list(&conn, Some(project.id)).unwrap().is_empty());
    }
}
