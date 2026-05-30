use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use crate::domain::{HistoryBlock, SessionHistory, SessionMeta};
use crate::error::{AppError, AppResult};
use super::activity::compute_activity;
use super::parser::parse_line;

const DEFAULT_PAGE: usize = 200;
const META_SCAN_LIMIT: usize = 100;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Build the path to a session's JSONL file. Validates `session_id` first so an
/// untrusted id (e.g. one arriving from the remote bridge) cannot traverse out
/// of `claude_dir` — the allowlist forbids `/` and `.`, so `..`/absolute paths
/// are rejected before any `join`.
pub fn session_file(claude_dir: &Path, session_id: &str) -> AppResult<PathBuf> {
    crate::validation::validate_session_id(session_id)?;
    Ok(claude_dir.join(format!("{session_id}.jsonl")))
}

pub fn first_user_prompt(path: &Path) -> AppResult<Option<String>> {
    let file = fs::File::open(path)?;
    for (i, line) in BufReader::new(file).lines().map_while(Result::ok).enumerate() {
        if i >= META_SCAN_LIMIT { break; }
        if line.trim().is_empty() { continue; }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue; };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") { continue; }
        let content = v.get("message").and_then(|m| m.get("content"));
        let text = content
            .and_then(|c| c.as_str())
            .map(|s| s.to_string())
            .or_else(|| content
                .and_then(|c| c.as_array())
                .and_then(|arr| arr.iter().find(|i| i.get("type").and_then(|t| t.as_str()) == Some("text")))
                .and_then(|i| i.get("text"))
                .and_then(|t| t.as_str())
                .map(|s| s.to_string()));
        if let Some(text) = text {
            if !text.is_empty() && !super::parser::is_meta_user_content(&text) {
                return Ok(Some(text));
            }
        }
    }
    Ok(None)
}

pub fn list_sessions(
    project_id: i64,
    project_claude_dir: &Path,
    limit: usize,
    offset: usize,
) -> AppResult<Vec<SessionMeta>> {
    if !project_claude_dir.exists() {
        return Ok(vec![]);
    }
    let mut entries: Vec<_> = fs::read_dir(project_claude_dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "jsonl").unwrap_or(false))
        .collect();

    entries.sort_by_key(|e| {
        std::cmp::Reverse(
            e.metadata().and_then(|m| m.modified()).ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        )
    });

    let mut out = Vec::new();
    for entry in entries.into_iter().skip(offset).take(limit) {
        if let Ok(meta) = meta_for_file_fast(project_id, &entry.path()) {
            out.push(meta);
        }
    }
    Ok(out)
}

fn meta_for_file_fast(project_id: i64, path: &Path) -> AppResult<SessionMeta> {
    let id = path.file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::NotFound(path.display().to_string()))?
        .to_string();

    let file_meta = path.metadata()?;
    let last_modified = file_meta.modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let file_size = file_meta.len();
    let approx_messages = (file_size / 500).max(1) as usize;

    let mut title = format!("Sesja {}", &id[..8.min(id.len())]);
    let mut git_branch = None;
    let mut cwd = None;
    let mut has_ai_title = false;

    let file = fs::File::open(path)?;
    for (i, line) in BufReader::new(file).lines().map_while(Result::ok).enumerate() {
        if i >= META_SCAN_LIMIT { break; }
        if line.trim().is_empty() { continue; }

        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue; };
        let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

        if kind == "ai-title" {
            if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()) {
                if !t.is_empty() {
                    title = t.to_string();
                    has_ai_title = true;
                }
            }
        } else if !has_ai_title && kind == "user" {
            if let Some(text) = v.get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
                .and_then(|arr| arr.iter().find(|i| i.get("type").and_then(|t| t.as_str()) == Some("text")))
                .and_then(|i| i.get("text"))
                .and_then(|t| t.as_str())
            {
                if !text.is_empty() {
                    title = truncate(text, 80);
                }
            }
        }

        if cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) {
                cwd = Some(c.to_string());
            }
            if let Some(b) = v.get("gitBranch").and_then(|x| x.as_str()) {
                git_branch = Some(b.to_string());
            }
        }

        if has_ai_title && cwd.is_some() { break; }
    }

    Ok(SessionMeta {
        id, project_id, title,
        message_count: approx_messages,
        last_modified, git_branch, cwd,
        activity: compute_activity(path, now_ms()),
    })
}

fn truncate(s: &str, max: usize) -> String {
    let trimmed = s.trim().replace('\n', " ");
    if trimmed.chars().count() <= max { trimmed }
    else { let mut t: String = trimmed.chars().take(max).collect(); t.push('…'); t }
}

pub fn read_history(
    project_id: i64,
    claude_dir: &Path,
    session_id: &str,
    limit: Option<usize>,
    before_uuid: Option<&str>,
) -> AppResult<SessionHistory> {
    let path = session_file(claude_dir, session_id)?;
    let limit = limit.unwrap_or(DEFAULT_PAGE).min(500);

    let file_meta = path.metadata()?;
    let last_modified = file_meta.modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let id = path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();

    let file = fs::File::open(&path)?;
    let mut all_blocks: Vec<HistoryBlock> = Vec::new();
    let mut title = format!("Sesja {}", &id[..8.min(id.len())]);
    let mut has_ai_title = false;
    let mut git_branch = None;
    let mut cwd = None;
    let mut line_count = 0usize;

    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if line.trim().is_empty() { continue; }
        line_count += 1;

        if !has_ai_title || cwd.is_none() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if kind == "ai-title" {
                    if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()) {
                        if !t.is_empty() {
                            title = t.to_string();
                            has_ai_title = true;
                        }
                    }
                } else if !has_ai_title && kind == "user" {
                    if let Some(text) = v.get("message")
                        .and_then(|m| m.get("content"))
                        .and_then(|c| c.as_array())
                        .and_then(|arr| arr.iter().find(|i| i.get("type").and_then(|t| t.as_str()) == Some("text")))
                        .and_then(|i| i.get("text"))
                        .and_then(|t| t.as_str())
                    {
                        if !text.is_empty() {
                            title = truncate(text, 80);
                        }
                    }
                }
                if cwd.is_none() {
                    if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) {
                        cwd = Some(c.to_string());
                    }
                    if let Some(b) = v.get("gitBranch").and_then(|x| x.as_str()) {
                        git_branch = Some(b.to_string());
                    }
                }
            }
        }

        if let Ok(bs) = parse_line(&line) {
            all_blocks.extend(bs);
        }
    }

    let end = if let Some(before) = before_uuid {
        all_blocks.iter().position(|b| block_uuid(b) == before).unwrap_or(all_blocks.len())
    } else {
        all_blocks.len()
    };

    let start = end.saturating_sub(limit);
    let blocks = all_blocks[start..end].to_vec();
    let has_more_before = start > 0;

    let meta = SessionMeta {
        id, project_id, title,
        message_count: line_count,
        last_modified, git_branch, cwd,
        activity: compute_activity(&path, now_ms()),
    };

    Ok(SessionHistory { meta, blocks, has_more_before })
}

fn block_uuid(b: &HistoryBlock) -> &str {
    match b {
        HistoryBlock::UserText { uuid, .. } |
        HistoryBlock::AssistantText { uuid, .. } |
        HistoryBlock::AssistantThinking { uuid, .. } |
        HistoryBlock::ToolUse { uuid, .. } |
        HistoryBlock::ToolResult { uuid, .. } |
        HistoryBlock::Attachment { uuid, .. } |
        HistoryBlock::System { uuid, .. } => uuid,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::SessionActivity;
    use std::fs;
    use tempfile::TempDir;

    fn setup(dir: &Path, name: &str, content: &str) -> PathBuf {
        let p = dir.join(format!("{name}.jsonl"));
        fs::write(&p, content).unwrap();
        p
    }

    #[test]
    fn list_sessions_includes_activity() {
        let td = TempDir::new().unwrap();
        let content = r#"{"type":"user","uuid":"u1","timestamp":"2026-05-21T12:00:00Z","sessionId":"s1","cwd":"/x","gitBranch":"main","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#;
        setup(td.path(), "sess-active", content);

        let list = list_sessions(1, td.path(), 10, 0).unwrap();
        let s = list.iter().find(|m| m.id == "sess-active").unwrap();
        assert_eq!(s.activity, SessionActivity::Running);
    }

    #[test]
    fn list_orders_by_mtime_desc() {
        let td = TempDir::new().unwrap();
        setup(td.path(), "aaaa-old", "{\"type\":\"queue-operation\"}\n");
        std::thread::sleep(std::time::Duration::from_millis(20));
        setup(td.path(), "bbbb-new", "{\"type\":\"queue-operation\"}\n");
        let v = list_sessions(1, td.path(), 10, 0).unwrap();
        assert_eq!(v.len(), 2);
        assert!(v[0].id.starts_with("bbbb"));
    }

    #[test]
    fn ai_title_overrides_first_user_prompt() {
        let td = TempDir::new().unwrap();
        let content = concat!(
            r#"{"type":"user","uuid":"u1","timestamp":"2026-05-21T12:00:00Z","sessionId":"s1","cwd":"/x","gitBranch":"main","message":{"role":"user","content":[{"type":"text","text":"fix the bug in auth module where tokens expire too early"}]}}"#, "\n",
            r#"{"type":"assistant","uuid":"a1","timestamp":"2026-05-21T12:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"I'll look into it."}]}}"#, "\n",
            r#"{"type":"ai-title","aiTitle":"Fix early token expiration in auth","sessionId":"s1"}"#, "\n",
        );
        setup(td.path(), "sess-ai-title", content);

        let list = list_sessions(1, td.path(), 10, 0).unwrap();
        let s = list.iter().find(|m| m.id == "sess-ai-title").unwrap();
        assert_eq!(s.title, "Fix early token expiration in auth");

        let h = read_history(1, td.path(), "sess-ai-title", None, None).unwrap();
        assert_eq!(h.meta.title, "Fix early token expiration in auth");
    }

    #[test]
    fn falls_back_to_user_prompt_without_ai_title() {
        let td = TempDir::new().unwrap();
        let content = r#"{"type":"user","uuid":"u1","timestamp":"2026-05-21T12:00:00Z","sessionId":"s1","cwd":"/x","gitBranch":"main","message":{"role":"user","content":[{"type":"text","text":"hello world"}]}}"#;
        setup(td.path(), "sess-no-ai", content);

        let list = list_sessions(1, td.path(), 10, 0).unwrap();
        let s = list.iter().find(|m| m.id == "sess-no-ai").unwrap();
        assert_eq!(s.title, "hello world");
    }

    #[test]
    fn read_history_pagination() {
        let td = TempDir::new().unwrap();
        let mut content = String::new();
        for i in 0..10 {
            content.push_str(&format!(
                "{{\"type\":\"user\",\"uuid\":\"u{i}\",\"timestamp\":\"2026-05-21T12:00:0{i}Z\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"msg {i}\"}}]}}}}\n"
            ));
        }
        let _path = setup(td.path(), "sess", &content);
        let h = read_history(1, td.path(), "sess", Some(3), None).unwrap();
        assert_eq!(h.blocks.len(), 3);
        assert!(h.has_more_before);
        let last_text = match &h.blocks[2] {
            HistoryBlock::UserText { text, .. } => text.clone(),
            _ => panic!()
        };
        assert_eq!(last_text, "msg 9");
    }
}
