use std::collections::{HashMap, HashSet};
use std::io::BufRead;
use std::path::{Path, PathBuf};
use crate::domain::{SubagentInfo, SubagentStatus};
use crate::error::AppResult;

pub const AGENT_STALE_MS: i64 = 120_000;

pub fn subagents_dir(session_path: &Path) -> PathBuf {
    let parent = session_path.parent().unwrap_or(Path::new(""));
    let stem = session_path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    parent.join(stem).join("subagents")
}

pub(crate) fn mtime_ms(path: &Path) -> Option<i64> {
    path.metadata()
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
}

fn extract_task_id(s: &str) -> Option<String> {
    let start = s.find("<task-id>")? + "<task-id>".len();
    let rest = &s[start..];
    let end = rest.find("</task-id>")?;
    Some(rest[..end].trim().to_string())
}

pub fn collect_completed_ids(lines: &[String]) -> HashSet<String> {
    let mut out = HashSet::new();
    for line in lines {
        if !line.contains("<task-notification>") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        let Some(text) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_str()) else { continue };
        if let Some(id) = extract_task_id(text) {
            out.insert(id);
        }
    }
    out
}

pub fn scan_dir(dir: &Path, completed: &HashSet<String>, now_ms: i64) -> Vec<SubagentInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else { continue };
        let Some(agent_id) = name.strip_prefix("agent-").and_then(|s| s.strip_suffix(".meta.json")) else { continue };
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };

        let started_at = mtime_ms(&path).unwrap_or(0);
        let log_mtime = mtime_ms(&dir.join(format!("agent-{agent_id}.jsonl")));
        let last_seen = log_mtime.unwrap_or(started_at);

        let status = if completed.contains(agent_id) {
            SubagentStatus::Completed
        } else if now_ms - last_seen > AGENT_STALE_MS {
            SubagentStatus::Stale
        } else {
            SubagentStatus::Running
        };

        out.push(SubagentInfo {
            agent_id: agent_id.to_string(),
            agent_type: v.get("agentType").and_then(|x| x.as_str()).unwrap_or("agent").to_string(),
            description: v.get("description").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            status,
            started_at,
            ended_at: match status {
                SubagentStatus::Running => None,
                _ => log_mtime,
            },
        });
    }
    out.sort_by_key(|s| s.started_at);
    out
}

pub fn count_agents(
    dir: &Path,
    completed: &HashSet<String>,
    now_ms: i64,
    parent_mtime_ms: Option<i64>,
) -> (u32, u32) {
    let Ok(entries) = std::fs::read_dir(dir) else { return (0, 0) };
    let mut started: HashMap<String, i64> = HashMap::new();
    let mut logs: HashMap<String, i64> = HashMap::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(rest) = name.strip_prefix("agent-") else { continue };
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if let Some(id) = rest.strip_suffix(".meta.json") {
            started.insert(id.to_string(), mtime);
        } else if let Some(id) = rest.strip_suffix(".jsonl") {
            logs.insert(id.to_string(), mtime);
        }
    }

    let running = started
        .iter()
        .filter(|(id, started_at)| {
            if completed.contains(id.as_str()) {
                return false;
            }
            let last_seen = logs.get(id.as_str()).copied().unwrap_or(**started_at);
            if parent_mtime_ms.is_some_and(|parent| parent > last_seen) {
                return false;
            }
            now_ms - last_seen <= AGENT_STALE_MS
        })
        .count() as u32;
    (running, started.len() as u32)
}

pub fn scan_session(session_path: &Path, now_ms: i64) -> AppResult<Vec<SubagentInfo>> {
    let dir = subagents_dir(session_path);
    let file = std::fs::File::open(session_path)?;
    let lines: Vec<String> = std::io::BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|l| l.contains("<task-notification>"))
        .collect();
    let completed = collect_completed_ids(&lines);
    Ok(scan_dir(&dir, &completed, now_ms))
}

pub fn count_running(list: &[SubagentInfo]) -> u32 {
    list.iter().filter(|s| s.status == SubagentStatus::Running).count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_agent(dir: &Path, id: &str, agent_type: &str, description: &str) -> i64 {
        std::fs::create_dir_all(dir).unwrap();
        let meta = dir.join(format!("agent-{id}.meta.json"));
        std::fs::write(
            &meta,
            format!(
                r#"{{"agentType":"{agent_type}","description":"{description}","toolUseId":"toolu_x","spawnDepth":1}}"#
            ),
        )
        .unwrap();
        std::fs::write(dir.join(format!("agent-{id}.jsonl")), "{\"type\":\"user\"}\n").unwrap();
        meta.metadata()
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    #[test]
    fn subagents_dir_is_sibling_directory_of_session_file() {
        let p = Path::new("/home/u/.claude/projects/enc/abc-123.jsonl");
        assert_eq!(
            subagents_dir(p),
            Path::new("/home/u/.claude/projects/enc/abc-123/subagents")
        );
    }

    #[test]
    fn collects_task_id_from_notification_line() {
        let lines = vec![
            r#"{"type":"user","message":{"content":"<task-notification>\n<task-id>af01e388</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n</task-notification>"}}"#.to_string(),
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}"#.to_string(),
        ];
        let ids = collect_completed_ids(&lines);
        assert!(ids.contains("af01e388"));
        assert_eq!(ids.len(), 1);
    }

    #[test]
    fn ignores_notification_shaped_text_from_assistant() {
        let lines = vec![
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"<task-notification><task-id>fake</task-id></task-notification>"}]}}"#.to_string(),
        ];
        assert!(collect_completed_ids(&lines).is_empty());
    }

    #[test]
    fn agent_without_notification_and_fresh_log_is_running() {
        let td = TempDir::new().unwrap();
        let dir = td.path().join("subagents");
        let started = write_agent(&dir, "a1", "Explore", "Znajdz skroty");
        let list = scan_dir(&dir, &HashSet::new(), started + 1_000);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].status, SubagentStatus::Running);
        assert_eq!(list[0].agent_type, "Explore");
        assert_eq!(list[0].description, "Znajdz skroty");
        assert_eq!(list[0].ended_at, None);
    }

    #[test]
    fn agent_with_notification_is_completed() {
        let td = TempDir::new().unwrap();
        let dir = td.path().join("subagents");
        let started = write_agent(&dir, "a1", "Explore", "x");
        let completed: HashSet<String> = ["a1".to_string()].into_iter().collect();
        let list = scan_dir(&dir, &completed, started + 1_000);
        assert_eq!(list[0].status, SubagentStatus::Completed);
        assert!(list[0].ended_at.is_some());
    }

    #[test]
    fn silent_agent_past_threshold_is_stale() {
        let td = TempDir::new().unwrap();
        let dir = td.path().join("subagents");
        let started = write_agent(&dir, "a1", "Explore", "x");
        let list = scan_dir(&dir, &HashSet::new(), started + AGENT_STALE_MS + 1_000);
        assert_eq!(list[0].status, SubagentStatus::Stale);
    }

    #[test]
    fn missing_directory_yields_empty_list() {
        let td = TempDir::new().unwrap();
        let list = scan_dir(&td.path().join("nope"), &HashSet::new(), 0);
        assert!(list.is_empty());
    }

    #[test]
    fn scan_session_sees_notification_beyond_the_tail_window() {
        let td = TempDir::new().unwrap();
        let session_path = td.path().join("sess.jsonl");
        let dir = subagents_dir(&session_path);
        let started = write_agent(&dir, "a1", "Explore", "x");

        let mut log = String::from(
            r#"{"type":"user","message":{"content":"<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n</task-notification>"}}"#,
        );
        log.push('\n');
        let filler = format!(
            "{{\"type\":\"assistant\",\"message\":{{\"content\":[{{\"type\":\"text\",\"text\":\"{}\"}}]}}}}\n",
            "f".repeat(200)
        );
        while log.len() < 16 * 1024 {
            log.push_str(&filler);
        }
        std::fs::write(&session_path, &log).unwrap();

        let list = scan_session(&session_path, started + 1_000).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].status, SubagentStatus::Completed);
    }

    #[test]
    fn a_notification_id_from_a_real_line_matches_the_agent_files_on_disk() {
        const AGENT_ID: &str = "af01e3886643f8b67";
        let td = TempDir::new().unwrap();
        let session_path = td.path().join("9f2c1e40-3c7a-4d21-bd5f-1a2b3c4d5e6f.jsonl");
        let dir = subagents_dir(&session_path);
        let started = write_agent(&dir, AGENT_ID, "Explore", "Znajdz skroty");

        let line = format!(
            r#"{{"parentUuid":"3b1d0c6e-1f2a-4c5b-9d8e-7f6a5b4c3d2e","isSidechain":false,"type":"user","message":{{"role":"user","content":"<task-notification>\n<task-id>{AGENT_ID}</task-id>\n<tool-use-id>toolu_01AbCdEfGhIjKlMnOpQrStUv</tool-use-id>\n</task-notification>"}},"uuid":"5c4b3a29-8e7d-4f6a-b1c2-d3e4f5a6b7c8","timestamp":"2026-07-29T10:00:00.000Z"}}"#
        );
        std::fs::write(&session_path, format!("{line}\n")).unwrap();

        let completed = collect_completed_ids(&[line]);
        assert!(completed.contains(AGENT_ID), "notification id did not survive parsing");

        let list = scan_session(&session_path, started + 1_000).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].agent_id, AGENT_ID);
        assert_eq!(list[0].status, SubagentStatus::Completed);
        assert_eq!(count_running(&list), 0);
        assert_eq!(count_agents(&dir, &completed, started + 1_000, None), (0, 1));
    }

    #[test]
    fn scan_session_without_notification_reports_running() {
        let td = TempDir::new().unwrap();
        let session_path = td.path().join("sess.jsonl");
        let dir = subagents_dir(&session_path);
        let started = write_agent(&dir, "a1", "Explore", "x");
        std::fs::write(&session_path, "{\"type\":\"user\"}\n").unwrap();

        let list = scan_session(&session_path, started + 1_000).unwrap();
        assert_eq!(list[0].status, SubagentStatus::Running);
    }

    #[test]
    fn count_agents_agrees_with_the_full_scan() {
        let td = TempDir::new().unwrap();
        let dir = td.path().join("subagents");
        let started = write_agent(&dir, "a1", "Explore", "x");
        write_agent(&dir, "a2", "claude", "y");
        write_agent(&dir, "a3", "claude", "z");
        let completed: HashSet<String> = ["a2".to_string()].into_iter().collect();
        let now = started + 1_000;

        let list = scan_dir(&dir, &completed, now);
        assert_eq!(count_agents(&dir, &completed, now, None), (count_running(&list), list.len() as u32));
        assert_eq!(count_agents(&dir, &completed, now, None), (2, 3));
    }

    #[test]
    fn count_agents_never_parses_the_meta_file() {
        let td = TempDir::new().unwrap();
        let dir = td.path().join("subagents");
        let started = write_agent(&dir, "a1", "Explore", "x");
        std::fs::write(dir.join("agent-a1.meta.json"), "{ this is not json").unwrap();
        let now = started + 1_000;

        assert!(scan_dir(&dir, &HashSet::new(), now).is_empty());
        assert_eq!(count_agents(&dir, &HashSet::new(), now, None), (1, 1));
    }

    #[test]
    fn count_agents_marks_a_silent_agent_as_not_running() {
        let td = TempDir::new().unwrap();
        let dir = td.path().join("subagents");
        let started = write_agent(&dir, "a1", "Explore", "x");
        assert_eq!(count_agents(&dir, &HashSet::new(), started + AGENT_STALE_MS + 1_000, None), (0, 1));
    }

    #[test]
    fn count_agents_drops_an_agent_whose_log_is_older_than_the_parent_session_log() {
        let td = TempDir::new().unwrap();
        let dir = td.path().join("subagents");
        let started = write_agent(&dir, "a1", "Explore", "x");
        let agent_log = mtime_ms(&dir.join("agent-a1.jsonl")).unwrap();

        assert_eq!(
            count_agents(&dir, &HashSet::new(), started + 1_000, Some(agent_log + 5_000)),
            (0, 1),
        );
    }

    #[test]
    fn count_agents_keeps_an_agent_still_writing_after_the_parent_session_log() {
        let td = TempDir::new().unwrap();
        let dir = td.path().join("subagents");
        let started = write_agent(&dir, "a1", "Explore", "x");
        let agent_log = mtime_ms(&dir.join("agent-a1.jsonl")).unwrap();

        assert_eq!(
            count_agents(&dir, &HashSet::new(), started + 1_000, Some(agent_log - 5_000)),
            (1, 1),
        );
    }

    #[test]
    fn count_agents_on_a_missing_directory_is_zero() {
        let td = TempDir::new().unwrap();
        assert_eq!(count_agents(&td.path().join("nope"), &HashSet::new(), 0, None), (0, 0));
    }

    #[test]
    fn counts_only_running_agents() {
        let td = TempDir::new().unwrap();
        let dir = td.path().join("subagents");
        let started = write_agent(&dir, "a1", "Explore", "x");
        write_agent(&dir, "a2", "claude", "y");
        let completed: HashSet<String> = ["a2".to_string()].into_iter().collect();
        let list = scan_dir(&dir, &completed, started + 1_000);
        assert_eq!(list.len(), 2);
        assert_eq!(count_running(&list), 1);
    }
}
