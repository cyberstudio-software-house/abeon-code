use crate::domain::{HistoryBlock, Provider, SessionActivity, SessionHistory, SessionMeta};
use crate::error::{AppError, AppResult};
use crate::sessions::opencode::parser::parse_part;
use rusqlite::{params, Connection, OpenFlags};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

const DEFAULT_PAGE: usize = 200;
const MAX_PAGE: usize = 500;
const LIVE_WINDOW_MS: i64 = 5_000;
const TOOL_STALL_MS: i64 = 30_000;
const RUNNING_STALL_MS: i64 = 10 * 60_000;
const WAITING_DECAY_MS: i64 = 4 * 60 * 60_000;
const HARD_IDLE_MS: i64 = 24 * 60 * 60_000;

#[derive(Debug, Clone, PartialEq)]
pub struct StoredSession {
    pub id: String,
    pub title: String,
    pub message_count: usize,
    pub updated_at: i64,
    pub directory: String,
    pub activity: SessionActivity,
}

pub struct StoredHistory {
    pub session: StoredSession,
    pub blocks: Vec<HistoryBlock>,
    pub has_more_before: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionRevision {
    pub updated_at: i64,
    pub title: String,
    pub activity: SessionActivity,
}

pub fn into_session_meta(record: StoredSession, project_id: i64) -> SessionMeta {
    SessionMeta {
        id: record.id,
        project_id,
        title: record.title,
        message_count: record.message_count,
        last_modified: record.updated_at,
        git_branch: None,
        cwd: Some(record.directory),
        activity: record.activity,
        provider: Provider::Opencode,
        running_agents: 0,
        total_agents: 0,
    }
}

pub fn into_session_history(history: StoredHistory, project_id: i64) -> SessionHistory {
    SessionHistory {
        meta: into_session_meta(history.session, project_id),
        blocks: history.blocks,
        has_more_before: history.has_more_before,
    }
}

#[derive(Clone, Copy)]
enum LastEvent {
    UserText,
    AssistantText,
    ToolActive,
    ToolCompleted,
    ToolFailed,
}

pub fn database_path() -> Option<PathBuf> {
    if let Some(base) = std::env::var_os("XDG_DATA_HOME") {
        let path = PathBuf::from(base).join("opencode").join("opencode.db");
        if path.exists() {
            return Some(path);
        }
    }
    if let Some(base) = dirs::data_dir() {
        let path = base.join("opencode").join("opencode.db");
        if path.exists() {
            return Some(path);
        }
    }
    dirs::home_dir()
        .map(|home| home.join(".local/share/opencode/opencode.db"))
        .filter(|path| path.exists())
}

fn open_database(path: &Path) -> AppResult<Option<Connection>> {
    if !path.exists() {
        return Ok(None);
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let connection = Connection::open_with_flags(path, flags)?;
    connection.busy_timeout(Duration::from_millis(750))?;
    validate_schema(&connection)?;
    Ok(Some(connection))
}

fn validate_schema(connection: &Connection) -> AppResult<()> {
    let required = [
        (
            "session",
            &[
                "id",
                "parent_id",
                "directory",
                "title",
                "time_created",
                "time_updated",
            ][..],
        ),
        (
            "message",
            &["id", "session_id", "time_created", "time_updated", "data"][..],
        ),
        (
            "part",
            &[
                "id",
                "message_id",
                "session_id",
                "time_created",
                "time_updated",
                "data",
            ][..],
        ),
    ];
    for (table, columns) in required {
        let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
        let present = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<HashSet<_>, _>>()?;
        let missing = columns
            .iter()
            .filter(|column| !present.contains(**column))
            .copied()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(AppError::Other(format!(
                "Nieobsługiwany schemat OpenCode: tabela {table} nie zawiera kolumn {}",
                missing.join(", ")
            )));
        }
    }
    Ok(())
}

pub fn list_for_directory(
    path: &Path,
    directory: &str,
    limit: usize,
) -> AppResult<Vec<StoredSession>> {
    let Some(connection) = open_database(path)? else {
        return Ok(Vec::new());
    };
    let mut statement = connection.prepare(
        "SELECT s.id, s.title, s.time_updated, s.directory,
                (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id)
         FROM session s
         WHERE s.directory = ?1 AND s.parent_id IS NULL
         ORDER BY s.time_updated DESC, s.id DESC
         LIMIT ?2",
    )?;
    let raw = statement
        .query_map(params![directory, limit.min(500) as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)? as usize,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    raw.into_iter()
        .map(|(id, title, updated_at, directory, message_count)| {
            Ok(StoredSession {
                activity: activity_for_session(&connection, &id, updated_at)?,
                id,
                title,
                message_count,
                updated_at,
                directory,
            })
        })
        .collect()
}

pub fn count_for_directory(path: &Path, directory: &str) -> AppResult<usize> {
    let Some(connection) = open_database(path)? else {
        return Ok(0);
    };
    let count = connection.query_row(
        "SELECT COUNT(*) FROM session WHERE directory = ?1 AND parent_id IS NULL",
        params![directory],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(count as usize)
}

pub fn read_history(
    path: &Path,
    session_id: &str,
    limit: Option<usize>,
    before_uuid: Option<&str>,
) -> AppResult<StoredHistory> {
    let Some(connection) = open_database(path)? else {
        return Err(AppError::NotFound(session_id.to_string()));
    };
    let session = stored_session(&connection, session_id)?
        .ok_or_else(|| AppError::NotFound(session_id.to_string()))?;
    let mut statement = connection.prepare(
        "SELECT m.id, json_extract(m.data, '$.role'), m.time_created,
                p.id, p.time_created, p.data
         FROM message m
         JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
         WHERE m.session_id = ?1
         ORDER BY m.time_created, m.id, p.time_created, p.id",
    )?;
    let rows = statement.query_map(params![session_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;
    let mut all_blocks = Vec::new();
    for row in rows {
        let (message_id, role, message_created_at, part_id, part_created_at, raw_data) = row?;
        let Ok(data) = serde_json::from_str::<Value>(&raw_data) else {
            continue;
        };
        all_blocks.extend(parse_part(
            &message_id,
            &role,
            message_created_at,
            &part_id,
            part_created_at,
            &data,
        ));
    }
    let end = before_uuid
        .and_then(|uuid| {
            all_blocks
                .iter()
                .position(|block| block_uuid(block) == uuid)
        })
        .unwrap_or(all_blocks.len());
    let page_size = limit.unwrap_or(DEFAULT_PAGE).min(MAX_PAGE);
    let start = end.saturating_sub(page_size);
    Ok(StoredHistory {
        session,
        blocks: all_blocks[start..end].to_vec(),
        has_more_before: start > 0,
    })
}

pub fn first_user_prompt(path: &Path, session_id: &str) -> AppResult<Option<String>> {
    find_text_part(path, session_id, "user", false)
}

pub fn last_assistant_text(path: &Path, session_id: &str) -> AppResult<Option<String>> {
    find_text_part(path, session_id, "assistant", true)
}

fn find_text_part(
    path: &Path,
    session_id: &str,
    role: &str,
    descending: bool,
) -> AppResult<Option<String>> {
    let Some(connection) = open_database(path)? else {
        return Ok(None);
    };
    let direction = if descending { "DESC" } else { "ASC" };
    let sql = format!(
        "SELECT p.data FROM message m
         JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
         WHERE m.session_id = ?1 AND json_extract(m.data, '$.role') = ?2
           AND json_extract(p.data, '$.type') = 'text'
         ORDER BY m.time_created {direction}, m.id {direction}, p.time_created {direction}, p.id {direction}"
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(params![session_id, role], |row| row.get::<_, String>(0))?;
    for row in rows {
        let Ok(data) = serde_json::from_str::<Value>(&row?) else {
            continue;
        };
        if let Some(text) = data
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            return Ok(Some(text.to_string()));
        }
    }
    Ok(None)
}

pub fn session_revision(path: &Path, session_id: &str) -> AppResult<Option<SessionRevision>> {
    let Some(connection) = open_database(path)? else {
        return Ok(None);
    };
    let Some(session) = stored_session(&connection, session_id)? else {
        return Ok(None);
    };
    Ok(Some(SessionRevision {
        updated_at: session.updated_at,
        title: session.title,
        activity: session.activity,
    }))
}

fn stored_session(connection: &Connection, session_id: &str) -> AppResult<Option<StoredSession>> {
    let mut statement = connection.prepare(
        "SELECT s.id, s.title, s.time_updated, s.directory,
                (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id)
         FROM session s WHERE s.id = ?1 AND s.parent_id IS NULL",
    )?;
    let mut rows = statement.query(params![session_id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let id = row.get::<_, String>(0)?;
    let title = row.get::<_, String>(1)?;
    let updated_at = row.get::<_, i64>(2)?;
    let directory = row.get::<_, String>(3)?;
    let message_count = row.get::<_, i64>(4)? as usize;
    Ok(Some(StoredSession {
        activity: activity_for_session(connection, &id, updated_at)?,
        id,
        title,
        message_count,
        updated_at,
        directory,
    }))
}

fn activity_for_session(
    connection: &Connection,
    session_id: &str,
    updated_at: i64,
) -> AppResult<SessionActivity> {
    let now = crate::sessions::reader::now_ms();
    let age = now.saturating_sub(updated_at);
    if age > HARD_IDLE_MS {
        return Ok(SessionActivity::Idle);
    }
    let mut statement = connection.prepare(
        "SELECT json_extract(m.data, '$.role'), p.data
         FROM message m JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
         WHERE m.session_id = ?1
         ORDER BY p.time_updated DESC, p.id DESC",
    )?;
    let rows = statement.query_map(params![session_id], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?.unwrap_or_default(),
            row.get::<_, String>(1)?,
        ))
    })?;
    for row in rows {
        let (role, raw_data) = row?;
        let Ok(data) = serde_json::from_str::<Value>(&raw_data) else {
            continue;
        };
        if let Some(event) = last_event(&role, &data) {
            return Ok(activity_from_event(event, age));
        }
    }
    Ok(if age <= LIVE_WINDOW_MS {
        SessionActivity::Running
    } else {
        SessionActivity::Idle
    })
}

fn last_event(role: &str, data: &Value) -> Option<LastEvent> {
    match data.get("type").and_then(Value::as_str) {
        Some("text") if role == "user" => Some(LastEvent::UserText),
        Some("text") if role == "assistant" => Some(LastEvent::AssistantText),
        Some("tool") if role == "assistant" => match data
            .get("state")
            .and_then(|state| state.get("status"))
            .and_then(Value::as_str)
        {
            Some("completed") => Some(LastEvent::ToolCompleted),
            Some("error" | "failed") => Some(LastEvent::ToolFailed),
            _ => Some(LastEvent::ToolActive),
        },
        _ => None,
    }
}

fn activity_from_event(event: LastEvent, age: i64) -> SessionActivity {
    if age <= LIVE_WINDOW_MS {
        return SessionActivity::Running;
    }
    match event {
        LastEvent::ToolActive if age <= TOOL_STALL_MS => SessionActivity::Running,
        LastEvent::ToolActive if age <= WAITING_DECAY_MS => SessionActivity::WaitingTool,
        LastEvent::UserText if age <= RUNNING_STALL_MS => SessionActivity::Running,
        LastEvent::UserText
        | LastEvent::AssistantText
        | LastEvent::ToolCompleted
        | LastEvent::ToolFailed
            if age <= WAITING_DECAY_MS =>
        {
            SessionActivity::WaitingUser
        }
        _ => SessionActivity::Idle,
    }
}

fn block_uuid(block: &HistoryBlock) -> &str {
    match block {
        HistoryBlock::UserText { uuid, .. }
        | HistoryBlock::AssistantText { uuid, .. }
        | HistoryBlock::AssistantThinking { uuid, .. }
        | HistoryBlock::ToolUse { uuid, .. }
        | HistoryBlock::ToolResult { uuid, .. }
        | HistoryBlock::Attachment { uuid, .. }
        | HistoryBlock::System { uuid, .. } => uuid,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{HistoryBlock, SessionActivity};
    use rusqlite::{params, Connection};
    use tempfile::NamedTempFile;

    fn test_database() -> NamedTempFile {
        let file = NamedTempFile::new().unwrap();
        let connection = Connection::open(file.path()).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE session (
                    id TEXT PRIMARY KEY,
                    parent_id TEXT,
                    directory TEXT NOT NULL,
                    title TEXT NOT NULL,
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL
                );
                CREATE TABLE message (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE TABLE part (
                    id TEXT PRIMARY KEY,
                    message_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL,
                    data TEXT NOT NULL
                );",
            )
            .unwrap();
        file
    }

    fn insert_session(
        connection: &Connection,
        id: &str,
        parent_id: Option<&str>,
        directory: &str,
        title: &str,
        updated_at: i64,
    ) {
        connection
            .execute(
                "INSERT INTO session VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, parent_id, directory, title, updated_at - 10, updated_at],
            )
            .unwrap();
    }

    fn insert_message(
        connection: &Connection,
        id: &str,
        session_id: &str,
        created_at: i64,
        role: &str,
    ) {
        let data = serde_json::json!({"role": role}).to_string();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                params![id, session_id, created_at, data],
            )
            .unwrap();
    }

    fn insert_part(
        connection: &Connection,
        id: &str,
        message_id: &str,
        session_id: &str,
        created_at: i64,
        data: &str,
    ) {
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                params![id, message_id, session_id, created_at, data],
            )
            .unwrap();
    }

    #[test]
    fn lists_top_level_sessions_for_exact_directory() {
        let file = test_database();
        let connection = Connection::open(file.path()).unwrap();
        insert_session(&connection, "old", None, "/project", "Old", 100);
        insert_session(&connection, "new", None, "/project", "New", 200);
        insert_session(&connection, "child", Some("new"), "/project", "Child", 300);
        insert_session(&connection, "other", None, "/project-copy", "Other", 400);
        insert_message(&connection, "msg1", "new", 190, "user");
        insert_message(&connection, "msg2", "new", 195, "assistant");

        let sessions = list_for_directory(file.path(), "/project", 20).unwrap();

        assert_eq!(
            sessions
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["new", "old"]
        );
        assert_eq!(sessions[0].message_count, 2);
        assert_eq!(count_for_directory(file.path(), "/project").unwrap(), 2);
    }

    #[test]
    fn reads_flattened_history_and_paginates_by_block_uuid() {
        let file = test_database();
        let connection = Connection::open(file.path()).unwrap();
        insert_session(&connection, "session", None, "/project", "Session", 300);
        insert_message(&connection, "msg-user", "session", 100, "user");
        insert_message(&connection, "msg-assistant", "session", 200, "assistant");
        insert_part(
            &connection,
            "part-user",
            "msg-user",
            "session",
            110,
            r#"{"type":"text","text":"Hello"}"#,
        );
        insert_part(
            &connection,
            "part-tool",
            "msg-assistant",
            "session",
            210,
            r#"{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"pwd"},"output":"/project"}}"#,
        );
        insert_part(
            &connection,
            "bad",
            "msg-assistant",
            "session",
            220,
            "not-json",
        );

        let history = read_history(file.path(), "session", None, None).unwrap();
        assert_eq!(history.blocks.len(), 3);
        assert!(
            matches!(&history.blocks[0], HistoryBlock::UserText { uuid, .. } if uuid == "oc-part-user")
        );
        assert!(
            matches!(&history.blocks[2], HistoryBlock::ToolResult { uuid, .. } if uuid == "oc-part-tool-result")
        );

        let before =
            read_history(file.path(), "session", Some(1), Some("oc-part-tool-result")).unwrap();
        assert_eq!(before.blocks.len(), 1);
        assert!(
            matches!(&before.blocks[0], HistoryBlock::ToolUse { uuid, .. } if uuid == "oc-part-tool")
        );
        assert!(before.has_more_before);
    }

    #[test]
    fn reads_prompt_last_answer_and_revision() {
        let file = test_database();
        let connection = Connection::open(file.path()).unwrap();
        let now = crate::sessions::reader::now_ms();
        insert_session(
            &connection,
            "session",
            None,
            "/project",
            "Useful title",
            now,
        );
        insert_message(&connection, "msg-user", "session", now - 200, "user");
        insert_message(
            &connection,
            "msg-assistant",
            "session",
            now - 100,
            "assistant",
        );
        insert_part(
            &connection,
            "part-user",
            "msg-user",
            "session",
            now - 190,
            r#"{"type":"text","text":"First prompt"}"#,
        );
        insert_part(
            &connection,
            "part-a",
            "msg-assistant",
            "session",
            now - 90,
            r#"{"type":"text","text":"First answer"}"#,
        );
        insert_part(
            &connection,
            "part-b",
            "msg-assistant",
            "session",
            now - 80,
            r#"{"type":"text","text":"Last answer"}"#,
        );

        assert_eq!(
            first_user_prompt(file.path(), "session")
                .unwrap()
                .as_deref(),
            Some("First prompt")
        );
        assert_eq!(
            last_assistant_text(file.path(), "session")
                .unwrap()
                .as_deref(),
            Some("Last answer")
        );
        let revision = session_revision(file.path(), "session").unwrap().unwrap();
        assert_eq!(revision.title, "Useful title");
        assert_eq!(revision.updated_at, now);
        assert_ne!(revision.activity, SessionActivity::Idle);
    }

    #[test]
    fn missing_database_is_empty_and_schema_mismatch_isolated() {
        let missing = std::path::Path::new("/definitely/missing/opencode.db");
        assert!(list_for_directory(missing, "/project", 20)
            .unwrap()
            .is_empty());
        assert_eq!(count_for_directory(missing, "/project").unwrap(), 0);
        assert_eq!(first_user_prompt(missing, "session").unwrap(), None);

        let invalid = NamedTempFile::new().unwrap();
        Connection::open(invalid.path())
            .unwrap()
            .execute("CREATE TABLE session (id TEXT)", [])
            .unwrap();
        let error = list_for_directory(invalid.path(), "/project", 20).unwrap_err();
        assert!(error
            .to_string()
            .contains("Nieobsługiwany schemat OpenCode"));
    }
}
