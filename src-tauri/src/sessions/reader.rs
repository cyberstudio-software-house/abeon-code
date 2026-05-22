use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use crate::domain::{HistoryBlock, SessionHistory, SessionMeta};
use crate::error::{AppError, AppResult};
use super::parser::parse_line;

const DEFAULT_PAGE: usize = 200;

pub fn session_file(claude_dir: &Path, session_id: &str) -> PathBuf {
    claude_dir.join(format!("{session_id}.jsonl"))
}

/// Lists sessions in the Claude project directory with meta for each.
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
        if let Ok(meta) = meta_for_file(project_id, &entry.path()) {
            out.push(meta);
        }
    }
    Ok(out)
}

fn meta_for_file(project_id: i64, path: &Path) -> AppResult<SessionMeta> {
    let id = path.file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::NotFound(path.display().to_string()))?
        .to_string();

    let last_modified = path.metadata()?
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let mut title = format!("Sesja {}", &id[..8.min(id.len())]);
    let mut message_count = 0usize;
    let mut git_branch = None;
    let mut cwd = None;
    let mut first_user_set = false;
    let mut first_assistant_text: Option<String> = None;

    let file = fs::File::open(path)?;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if line.trim().is_empty() { continue; }
        let Ok(blocks) = parse_line(&line) else { continue };
        for b in blocks {
            message_count += 1;
            match &b {
                HistoryBlock::UserText { text, .. } if !first_user_set => {
                    title = truncate(text, 80);
                    first_user_set = true;
                }
                HistoryBlock::AssistantText { text, .. } if first_assistant_text.is_none() => {
                    first_assistant_text = Some(truncate(text, 80));
                }
                _ => {}
            }
        }
        if cwd.is_none() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) {
                    cwd = Some(c.to_string());
                }
                if let Some(b) = v.get("gitBranch").and_then(|x| x.as_str()) {
                    git_branch = Some(b.to_string());
                }
            }
        }
    }

    if !first_user_set {
        if let Some(t) = first_assistant_text { title = t; }
        else {
            let ts = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(last_modified)
                .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
                .unwrap_or_else(|| id.clone());
            title = ts;
        }
    }

    Ok(SessionMeta { id, project_id, title, message_count, last_modified, git_branch, cwd })
}

fn truncate(s: &str, max: usize) -> String {
    let trimmed = s.trim().replace('\n', " ");
    if trimmed.chars().count() <= max { trimmed }
    else { let mut t: String = trimmed.chars().take(max).collect(); t.push('…'); t }
}

/// Reads the last `limit` records, optionally paging back from `before_uuid`.
pub fn read_history(
    project_id: i64,
    claude_dir: &Path,
    session_id: &str,
    limit: Option<usize>,
    before_uuid: Option<&str>,
) -> AppResult<SessionHistory> {
    let path = session_file(claude_dir, session_id);
    let meta = meta_for_file(project_id, &path)?;
    let limit = limit.unwrap_or(DEFAULT_PAGE);

    let file = fs::File::open(&path)?;
    let mut all_blocks: Vec<HistoryBlock> = Vec::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if line.trim().is_empty() { continue; }
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
    use std::fs;
    use tempfile::TempDir;

    fn setup(dir: &Path, name: &str, content: &str) -> PathBuf {
        let p = dir.join(format!("{name}.jsonl"));
        fs::write(&p, content).unwrap();
        p
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
