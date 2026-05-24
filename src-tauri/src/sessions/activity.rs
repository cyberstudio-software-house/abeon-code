use std::path::Path;
use crate::domain::SessionActivity;

const TAIL_BYTES: u64 = 8 * 1024;
const LIVE_WINDOW_MS: i64 = 5_000;
const TOOL_STALL_MS: i64 = 30_000;
const IDLE_HARD_CAP_MS: i64 = 24 * 60 * 60 * 1000;

pub fn compute_activity(_path: &Path, _now_ms: i64) -> SessionActivity {
    SessionActivity::Idle
}

fn read_tail_lines(path: &Path) -> Option<Vec<String>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).to_string();
    let mut lines: Vec<String> = text.lines().map(String::from).collect();
    // If we seeked into the middle of a file, the first line is partial — drop it.
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    Some(lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::TempDir;

    #[test]
    fn missing_file_returns_idle() {
        let td = TempDir::new().unwrap();
        let p: PathBuf = td.path().join("does-not-exist.jsonl");
        assert_eq!(compute_activity(&p, 0), SessionActivity::Idle);
    }

    #[test]
    fn empty_file_returns_idle() {
        let td = TempDir::new().unwrap();
        let p = td.path().join("empty.jsonl");
        std::fs::write(&p, "").unwrap();
        assert_eq!(compute_activity(&p, 0), SessionActivity::Idle);
    }

    #[test]
    fn tail_small_file_returns_all_lines() {
        let td = TempDir::new().unwrap();
        let p = td.path().join("small.jsonl");
        std::fs::write(&p, "line1\nline2\nline3\n").unwrap();
        let lines = read_tail_lines(&p).unwrap();
        assert_eq!(lines, vec!["line1", "line2", "line3"]);
    }

    #[test]
    fn tail_large_file_drops_partial_first_line() {
        let td = TempDir::new().unwrap();
        let p = td.path().join("large.jsonl");
        let big_first: String = "x".repeat(10_000);
        let content = format!("{big_first}\nsecond\nthird\n");
        std::fs::write(&p, content).unwrap();
        let lines = read_tail_lines(&p).unwrap();
        assert!(!lines.iter().any(|l| l.starts_with("x")), "partial first line not dropped");
        assert_eq!(lines.last().map(String::as_str), Some("third"));
    }

    #[test]
    fn tail_no_trailing_newline_still_returns_last_line() {
        let td = TempDir::new().unwrap();
        let p = td.path().join("no-newline.jsonl");
        std::fs::write(&p, "only-line").unwrap();
        let lines = read_tail_lines(&p).unwrap();
        assert_eq!(lines, vec!["only-line"]);
    }
}
