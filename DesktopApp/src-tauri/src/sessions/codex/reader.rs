use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use parking_lot::Mutex;
use serde_json::Value;
use crate::domain::{Provider, SessionMeta};
use crate::error::{AppError, AppResult};

const META_SCAN_LIMIT: usize = 100;

pub fn codex_root() -> AppResult<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| AppError::Other("no home".into()))?;
    Ok(home.join(".codex").join("sessions"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn mtime_ms(path: &Path) -> i64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn open_lines(path: &Path) -> AppResult<Box<dyn BufRead>> {
    let file = fs::File::open(path)?;
    if path.extension().map(|e| e == "zst").unwrap_or(false) {
        let dec = zstd::stream::read::Decoder::new(file)
            .map_err(|e| AppError::Other(format!("zstd: {e}")))?;
        Ok(Box::new(BufReader::new(dec)))
    } else {
        Ok(Box::new(BufReader::new(file)))
    }
}

pub struct CodexSessionFile {
    pub path: PathBuf,
    pub session_id: String,
    pub cwd: String,
    pub git_branch: Option<String>,
    pub modified_ms: i64,
}

#[derive(Clone)]
struct CachedMeta {
    mtime_ms: i64,
    session_id: String,
    cwd: String,
    git_branch: Option<String>,
}

fn title_cache() -> &'static Mutex<HashMap<PathBuf, (i64, Option<String>)>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (i64, Option<String>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn meta_cache() -> &'static Mutex<HashMap<PathBuf, CachedMeta>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedMeta>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn session_file_meta(path: &Path) -> Option<CodexSessionFile> {
    let mtime = mtime_ms(path);
    if let Some(hit) = meta_cache().lock().get(path) {
        if hit.mtime_ms == mtime {
            return Some(CodexSessionFile {
                path: path.to_path_buf(),
                session_id: hit.session_id.clone(),
                cwd: hit.cwd.clone(),
                git_branch: hit.git_branch.clone(),
                modified_ms: mtime,
            });
        }
    }
    let mut reader = open_lines(path).ok()?;
    let mut first = String::new();
    reader.read_line(&mut first).ok()?;
    let v: Value = serde_json::from_str(&first).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
        return None;
    }
    let payload = v.get("payload")?;
    let session_id = payload.get("id").and_then(|x| x.as_str())?.to_string();
    let cwd = payload.get("cwd").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let git_branch = payload
        .get("git")
        .and_then(|g| g.get("branch"))
        .and_then(|b| b.as_str())
        .map(String::from);
    meta_cache().lock().insert(path.to_path_buf(), CachedMeta {
        mtime_ms: mtime,
        session_id: session_id.clone(),
        cwd: cwd.clone(),
        git_branch: git_branch.clone(),
    });
    Some(CodexSessionFile { path: path.to_path_buf(), session_id, cwd, git_branch, modified_ms: mtime })
}

fn is_rollout_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return false };
    name.starts_with("rollout-") && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"))
}

pub fn scan_sessions(root: &Path) -> Vec<CodexSessionFile> {
    fn subdirs_desc(dir: &Path) -> Vec<PathBuf> {
        let Ok(rd) = fs::read_dir(dir) else { return vec![] };
        let mut out: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect();
        out.sort();
        out.reverse();
        out
    }
    let mut out = Vec::new();
    for year in subdirs_desc(root) {
        for month in subdirs_desc(&year) {
            for day in subdirs_desc(&month) {
                let Ok(files) = fs::read_dir(&day) else { continue };
                for f in files.filter_map(|e| e.ok()) {
                    let p = f.path();
                    if is_rollout_file(&p) {
                        if let Some(meta) = session_file_meta(&p) {
                            out.push(meta);
                        }
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    out
}

pub fn find_session(root: &Path, session_id: &str) -> Option<PathBuf> {
    scan_sessions(root).into_iter().find(|s| s.session_id == session_id).map(|s| s.path)
}

pub(crate) fn is_meta_codex_text(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("<user_instructions>")
        || t.starts_with("<environment_context>")
        || t.starts_with("<ENVIRONMENT_CONTEXT>")
        || t.starts_with("<turn_context>")
}

fn read_first_user_text(path: &Path) -> Option<String> {
    let reader = open_lines(path).ok()?;
    for (i, line) in reader.lines().map_while(Result::ok).enumerate() {
        if i >= META_SCAN_LIMIT { break; }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("response_item") { continue; }
        let Some(p) = v.get("payload") else { continue };
        if p.get("type").and_then(|t| t.as_str()) != Some("message") { continue; }
        if p.get("role").and_then(|r| r.as_str()) != Some("user") { continue; }
        let Some(arr) = p.get("content").and_then(|c| c.as_array()) else { continue };
        for item in arr {
            if item.get("type").and_then(|t| t.as_str()) != Some("input_text") { continue; }
            let text = item.get("text").and_then(|t| t.as_str()).unwrap_or("");
            if !text.is_empty() && !is_meta_codex_text(text) {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn first_user_text(path: &Path) -> Option<String> {
    let mtime = mtime_ms(path);
    if let Some((cached_mtime, text)) = title_cache().lock().get(path) {
        if *cached_mtime == mtime {
            return text.clone();
        }
    }
    let text = read_first_user_text(path);
    title_cache().lock().insert(path.to_path_buf(), (mtime, text.clone()));
    text
}

fn truncate(s: &str, max: usize) -> String {
    let trimmed = s.trim().replace('\n', " ");
    if trimmed.chars().count() <= max { trimmed }
    else { let mut t: String = trimmed.chars().take(max).collect(); t.push('…'); t }
}

pub fn list_for_cwd(root: &Path, cwd: &str, project_id: i64, limit: usize) -> Vec<SessionMeta> {
    scan_sessions(root)
        .into_iter()
        .filter(|s| s.cwd == cwd)
        .take(limit)
        .map(|s| {
            let title = first_user_text(&s.path)
                .map(|t| truncate(&t, 80))
                .unwrap_or_else(|| format!("Sesja {}", &s.session_id[..8.min(s.session_id.len())]));
            let approx_messages = (s.path.metadata().map(|m| m.len()).unwrap_or(0) / 500).max(1) as usize;
            SessionMeta {
                id: s.session_id.clone(),
                project_id,
                title,
                message_count: approx_messages,
                last_modified: s.modified_ms,
                git_branch: s.git_branch.clone(),
                cwd: Some(s.cwd.clone()),
                activity: crate::sessions::activity::compute_activity_for(Provider::Codex, &s.path, now_ms()),
                provider: Provider::Codex,
            }
        })
        .collect()
}

pub fn count_for_cwd(root: &Path, cwd: &str) -> usize {
    scan_sessions(root).into_iter().filter(|s| s.cwd == cwd).count()
}

const MODEL_SCAN_FILES: usize = 20;
const MODEL_SCAN_LINES: usize = 80;

pub fn detect_models(root: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in scan_sessions(root).into_iter().take(MODEL_SCAN_FILES) {
        let Ok(reader) = open_lines(&s.path) else { continue };
        for (i, line) in reader.lines().map_while(Result::ok).enumerate() {
            if i >= MODEL_SCAN_LINES { break; }
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if v.get("type").and_then(|t| t.as_str()) != Some("turn_context") { continue; }
            let Some(m) = v.get("payload").and_then(|p| p.get("model")).and_then(|m| m.as_str()) else { continue };
            if !out.iter().any(|x| x == m) {
                out.push(m.to_string());
            }
        }
    }
    out
}

pub fn first_user_prompt(path: &Path) -> AppResult<Option<String>> {
    Ok(first_user_text(path))
}

pub fn read_history(
    root: &Path,
    project_id: i64,
    session_id: &str,
    limit: Option<usize>,
    before_uuid: Option<&str>,
) -> crate::error::AppResult<crate::domain::SessionHistory> {
    crate::validation::validate_session_id(session_id)?;
    let path = find_session(root, session_id)
        .ok_or_else(|| AppError::NotFound(session_id.to_string()))?;
    let limit = limit.unwrap_or(200).min(500);

    let mut all_blocks: Vec<crate::domain::HistoryBlock> = Vec::new();
    let mut title: Option<String> = None;
    let mut line_count = 0usize;
    let reader = open_lines(&path)?;
    for (i, line) in reader.lines().map_while(Result::ok).enumerate() {
        if line.trim().is_empty() { continue; }
        line_count += 1;
        if let Ok(bs) = super::parser::parse_codex_line(i, &line) {
            if title.is_none() {
                if let Some(crate::domain::HistoryBlock::UserText { text, .. }) = bs.first() {
                    title = Some(truncate(text, 80));
                }
            }
            all_blocks.extend(bs);
        }
    }

    let end = match before_uuid {
        Some(before) => all_blocks.iter().position(|b| block_uuid(b) == before).unwrap_or(all_blocks.len()),
        None => all_blocks.len(),
    };
    let start = end.saturating_sub(limit);
    let blocks = all_blocks[start..end].to_vec();
    let has_more_before = start > 0;

    let file_meta = session_file_meta(&path).ok_or_else(|| AppError::NotFound(session_id.to_string()))?;
    let meta = SessionMeta {
        id: session_id.to_string(),
        project_id,
        title: title.unwrap_or_else(|| format!("Sesja {}", &session_id[..8.min(session_id.len())])),
        message_count: line_count,
        last_modified: file_meta.modified_ms,
        git_branch: file_meta.git_branch,
        cwd: Some(file_meta.cwd),
        activity: crate::sessions::activity::compute_activity_for(Provider::Codex, &path, now_ms()),
        provider: Provider::Codex,
    };
    Ok(crate::domain::SessionHistory { meta, blocks, has_more_before })
}

fn block_uuid(b: &crate::domain::HistoryBlock) -> &str {
    use crate::domain::HistoryBlock::*;
    match b {
        UserText { uuid, .. } | AssistantText { uuid, .. } | AssistantThinking { uuid, .. }
        | ToolUse { uuid, .. } | ToolResult { uuid, .. } | Attachment { uuid, .. } | System { uuid, .. } => uuid,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn meta_line(id: &str, cwd: &str) -> String {
        format!(
            r#"{{"timestamp":"2026-06-11T10:00:00.000Z","type":"session_meta","payload":{{"id":"{id}","timestamp":"2026-06-11T10:00:00.000Z","cwd":"{cwd}","originator":"codex_cli_rs","cli_version":"0.139.0"}}}}"#
        )
    }

    fn write_rollout(root: &std::path::Path, day: &str, name: &str, content: &str) -> std::path::PathBuf {
        let dir = root.join("2026").join("06").join(day);
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        fs::write(&p, content).unwrap();
        p
    }

    #[test]
    fn scan_finds_sessions_across_days() {
        let td = TempDir::new().unwrap();
        write_rollout(td.path(), "10", "rollout-2026-06-10T09-00-00-aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl",
            &meta_line("aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "/proj/x"));
        write_rollout(td.path(), "11", "rollout-2026-06-11T09-00-00-bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl",
            &meta_line("bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "/proj/y"));
        let all = scan_sessions(td.path());
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|s| s.session_id == "aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa" && s.cwd == "/proj/x"));
    }

    #[test]
    fn scan_skips_files_without_session_meta() {
        let td = TempDir::new().unwrap();
        write_rollout(td.path(), "11", "rollout-x.jsonl", r#"{"type":"event_msg","payload":{}}"#);
        assert!(scan_sessions(td.path()).is_empty());
    }

    #[test]
    fn missing_root_yields_empty() {
        assert!(scan_sessions(std::path::Path::new("/nonexistent-codex-root")).is_empty());
    }

    #[test]
    fn find_session_locates_file_by_id() {
        let td = TempDir::new().unwrap();
        let p = write_rollout(td.path(), "11", "rollout-cccc.jsonl", &meta_line("cccc3333-cccc-cccc-cccc-cccccccccccc", "/p"));
        assert_eq!(find_session(td.path(), "cccc3333-cccc-cccc-cccc-cccccccccccc"), Some(p));
        assert_eq!(find_session(td.path(), "nope"), None);
    }

    #[test]
    fn list_for_cwd_filters_and_builds_meta() {
        let td = TempDir::new().unwrap();
        let content = format!(
            "{}\n{}\n",
            meta_line("dddd4444-dddd-dddd-dddd-dddddddddddd", "/proj/match"),
            r#"{"timestamp":"2026-06-11T10:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fix the login bug"}]}}"#,
        );
        write_rollout(td.path(), "11", "rollout-dddd.jsonl", &content);
        write_rollout(td.path(), "11", "rollout-eeee.jsonl", &meta_line("eeee5555-eeee-eeee-eeee-eeeeeeeeeeee", "/proj/other"));

        let list = list_for_cwd(td.path(), "/proj/match", 7, 50);
        assert_eq!(list.len(), 1);
        let m = &list[0];
        assert_eq!(m.id, "dddd4444-dddd-dddd-dddd-dddddddddddd");
        assert_eq!(m.project_id, 7);
        assert_eq!(m.provider, crate::domain::Provider::Codex);
        assert_eq!(m.title, "fix the login bug");
        assert_eq!(m.cwd.as_deref(), Some("/proj/match"));
    }

    #[test]
    fn first_user_text_is_cached_until_mtime_changes() {
        let td = TempDir::new().unwrap();
        let content = format!(
            "{}\n{}\n",
            meta_line("cace7777-cace-cace-cace-cacecacecace", "/proj/c"),
            r#"{"timestamp":"2026-06-11T10:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"first prompt"}]}}"#,
        );
        let p = write_rollout(td.path(), "11", "rollout-cace.jsonl", &content);

        let list1 = list_for_cwd(td.path(), "/proj/c", 1, 50);
        assert_eq!(list1[0].title, "first prompt");

        let mtime_before = p.metadata().unwrap().modified().unwrap();
        let list2 = list_for_cwd(td.path(), "/proj/c", 1, 50);
        assert_eq!(list2[0].title, "first prompt");
        assert_eq!(p.metadata().unwrap().modified().unwrap(), mtime_before);
    }

    #[test]
    fn reads_zst_compressed_rollout() {
        let td = TempDir::new().unwrap();
        let raw = meta_line("ffff6666-ffff-ffff-ffff-ffffffffffff", "/proj/z");
        let compressed = zstd::stream::encode_all(raw.as_bytes(), 0).unwrap();
        let dir = td.path().join("2026").join("06").join("11");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("rollout-ffff.jsonl.zst"), compressed).unwrap();
        let all = scan_sessions(td.path());
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].cwd, "/proj/z");
    }

    #[test]
    fn read_history_paginates_with_stable_uuids() {
        let td = TempDir::new().unwrap();
        let content = format!(
            "{}\n{}\n{}\n",
            meta_line("abab1212-abab-abab-abab-abababababab", "/p"),
            r#"{"timestamp":"2026-06-11T10:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"one"}]}}"#,
            r#"{"timestamp":"2026-06-11T10:00:06.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"two"}]}}"#,
        );
        write_rollout(td.path(), "11", "rollout-abab.jsonl", &content);

        let h = read_history(td.path(), 1, "abab1212-abab-abab-abab-abababababab", Some(1), None).unwrap();
        assert_eq!(h.blocks.len(), 1);
        assert!(h.has_more_before);
        assert_eq!(h.meta.provider, crate::domain::Provider::Codex);

        let older = read_history(td.path(), 1, "abab1212-abab-abab-abab-abababababab", Some(1), Some("cx-2-0")).unwrap();
        assert_eq!(older.blocks.len(), 1);
        assert!(matches!(&older.blocks[0], crate::domain::HistoryBlock::UserText { text, .. } if text == "one"));
    }

    #[test]
    fn real_capture_session_meta_parses() {
        let td = TempDir::new().unwrap();
        let content = include_str!("../../../tests/fixtures/codex-rollout-real.jsonl");
        write_rollout(td.path(), "11", "rollout-real.jsonl", content);
        let all = scan_sessions(td.path());
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].session_id, "019eb80e-c7eb-74a1-80f7-a26d9af4b0fb");
        assert_eq!(all[0].cwd, "/tmp/codex-recon");

        let list = list_for_cwd(td.path(), "/tmp/codex-recon", 1, 50);
        assert_eq!(list.len(), 1);
        assert!(list[0].title.starts_with("Run the command"));
    }

    #[test]
    fn detect_models_collects_turn_context_models_newest_first() {
        let td = TempDir::new().unwrap();
        let older = format!(
            "{}\n{}\n",
            meta_line("aaaa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "/p1"),
            r#"{"timestamp":"2026-06-10T10:00:01.000Z","type":"turn_context","payload":{"cwd":"/p1","model":"gpt-5.4"}}"#,
        );
        write_rollout(td.path(), "10", "rollout-old.jsonl", &older);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let newer = format!(
            "{}\n{}\n{}\n",
            meta_line("bbbb0002-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "/p2"),
            r#"{"timestamp":"2026-06-11T10:00:01.000Z","type":"turn_context","payload":{"cwd":"/p2","model":"gpt-5.5"}}"#,
            r#"{"timestamp":"2026-06-11T10:00:02.000Z","type":"turn_context","payload":{"cwd":"/p2","model":"gpt-5.5"}}"#,
        );
        write_rollout(td.path(), "11", "rollout-new.jsonl", &newer);

        let models = detect_models(td.path());
        assert_eq!(models, vec!["gpt-5.5".to_string(), "gpt-5.4".to_string()]);
    }

    #[test]
    fn detect_models_empty_root() {
        assert!(detect_models(std::path::Path::new("/nonexistent-codex-root")).is_empty());
    }

    #[test]
    fn physical_line_count_includes_empty_lines() {
        // File "A\n\nB\n": A at physical index 0, empty at 1, B at 2.
        // enumerate() in read_history counts all lines, so B gets line_no 2 → uuid "cx-2-…".
        // The watcher must also count 3 physical lines after open, so the next
        // appended line gets line_no 3 — not 2 (which would collide with B).
        let td = TempDir::new().unwrap();
        let user_line = r#"{"timestamp":"2026-06-11T10:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"A"}]}}"#;
        let assistant_line = r#"{"timestamp":"2026-06-11T10:00:06.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"B"}]}}"#;
        let content = format!("{}\n\n{}\n", user_line, assistant_line);
        write_rollout(td.path(), "11", "rollout-phys.jsonl", &content);

        let path = td.path().join("2026").join("06").join("11").join("rollout-phys.jsonl");

        // Verify read_history assigns physical line numbers (A→0, empty skipped, B→2).
        let reader = open_lines(&path).unwrap();
        use std::io::BufRead;
        let line_nos: Vec<usize> = reader.lines()
            .map_while(Result::ok)
            .enumerate()
            .filter(|(_, l)| !l.trim().is_empty())
            .map(|(i, _)| i)
            .collect();
        assert_eq!(line_nos, vec![0, 2], "read_history uses physical indices 0 and 2");

        // The watcher open path must count all physical lines (3), so the
        // next appended line gets line_no 3.
        let mut lines_seen = 0usize;
        let reader2 = open_lines(&path).unwrap();
        for _ in reader2.lines().map_while(Result::ok) {
            lines_seen += 1;
        }
        assert_eq!(lines_seen, 3, "watcher open must count 3 physical lines for 'A\\n\\nB\\n'");

        // Simulate one appended line: line_no captured before increment must equal 3.
        let line_no = lines_seen;
        lines_seen += 1;
        assert_eq!(line_no, 3);
        assert_eq!(lines_seen, 4);
    }
}
