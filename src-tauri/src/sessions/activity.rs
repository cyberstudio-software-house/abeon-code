use std::path::Path;
use crate::domain::SessionActivity;

const TAIL_BYTES: u64 = 8 * 1024;
const LIVE_WINDOW_MS: i64 = 5_000;
const TOOL_STALL_MS: i64 = 30_000;
const IDLE_HARD_CAP_MS: i64 = 24 * 60 * 60 * 1000;

pub fn compute_activity(_path: &Path, _now_ms: i64) -> SessionActivity {
    SessionActivity::Idle
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
}
