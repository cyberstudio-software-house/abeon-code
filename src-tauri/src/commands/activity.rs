use std::collections::HashMap;
use std::path::Path;
use std::fs;
use tauri::State;
use crate::error::AppResult;
use crate::state::AppState;
use crate::db::projects_repo;

/// Returns the max mtime (in ms since UNIX epoch) of all *.jsonl files in `dir`,
/// or None if `dir` does not exist or contains no *.jsonl files.
fn max_jsonl_mtime(dir: &Path) -> Option<i64> {
    if !dir.exists() {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    let mut max_ms: Option<i64> = None;
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().map(|x| x != "jsonl").unwrap_or(true) {
            continue;
        }
        let modified = match entry.metadata().and_then(|m| m.modified()) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let ms = match modified.duration_since(std::time::UNIX_EPOCH) {
            Ok(d) => d.as_millis() as i64,
            Err(_) => continue,
        };
        max_ms = Some(max_ms.map_or(ms, |cur| cur.max(ms)));
    }
    max_ms
}

#[tauri::command]
pub fn get_projects_activity(state: State<AppState>) -> AppResult<HashMap<i64, i64>> {
    let claude_root = dirs::home_dir()
        .ok_or_else(|| crate::error::AppError::Other("no home dir".into()))?
        .join(".claude")
        .join("projects");
    let c = state.db.get()?;
    let projects = projects_repo::list(&c)?;
    let mut out: HashMap<i64, i64> = HashMap::new();
    for p in projects {
        let dir = claude_root.join(&p.claude_dir);
        if let Some(mtime_ms) = max_jsonl_mtime(&dir) {
            out.insert(p.id, mtime_ms);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use std::fs::File;
    use std::io::Write;
    use filetime::{FileTime, set_file_mtime};

    fn touch_jsonl(dir: &Path, name: &str, mtime_secs: u64) {
        let path = dir.join(format!("{name}.jsonl"));
        let mut f = File::create(&path).unwrap();
        f.write_all(b"{}").unwrap();
        let ft = FileTime::from_unix_time(mtime_secs as i64, 0);
        set_file_mtime(&path, ft).unwrap();
    }

    #[test]
    fn max_jsonl_mtime_picks_newest() {
        let tmp = TempDir::new().unwrap();
        touch_jsonl(tmp.path(), "old", 1_700_000_000);
        touch_jsonl(tmp.path(), "new", 1_800_000_000);
        let got = max_jsonl_mtime(tmp.path());
        assert_eq!(got, Some(1_800_000_000_000));
    }

    #[test]
    fn max_jsonl_mtime_ignores_non_jsonl() {
        let tmp = TempDir::new().unwrap();
        touch_jsonl(tmp.path(), "session", 1_800_000_000);
        // Drop a non-jsonl file with newer mtime.
        let other = tmp.path().join("notes.txt");
        let mut f = File::create(&other).unwrap();
        f.write_all(b"hello").unwrap();
        set_file_mtime(&other, FileTime::from_unix_time(1_900_000_000, 0)).unwrap();
        let got = max_jsonl_mtime(tmp.path());
        assert_eq!(got, Some(1_800_000_000_000));
    }

    #[test]
    fn max_jsonl_mtime_returns_none_when_empty() {
        let tmp = TempDir::new().unwrap();
        let got = max_jsonl_mtime(tmp.path());
        assert_eq!(got, None);
    }

    #[test]
    fn max_jsonl_mtime_returns_none_when_dir_missing() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("does-not-exist");
        let got = max_jsonl_mtime(&missing);
        assert_eq!(got, None);
    }
}
