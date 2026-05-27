use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use tauri::State;
use crate::domain::UsageSummary;
use crate::error::{AppError, AppResult};
use crate::sessions::usage::UsageAccumulator;
use crate::state::AppState;
use crate::db::projects_repo;

fn claude_root() -> AppResult<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| AppError::Other("no home".into()))?;
    Ok(home.join(".claude").join("projects"))
}

fn mtime_ms(path: &Path) -> i64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn add_file(acc: &mut UsageAccumulator, path: &Path) {
    if let Ok(file) = fs::File::open(path) {
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if line.trim().is_empty() { continue; }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                acc.add_line(&v);
            }
        }
    }
}

/// Aggregates usage from one session file. A missing/unreadable file yields a
/// zero summary by design — a freshly opened session may not have written its
/// JSONL yet, so callers treat "no file" as "no usage", not an error.
fn scan_file(path: &Path) -> UsageSummary {
    let mut acc = UsageAccumulator::default();
    add_file(&mut acc, path);
    acc.finalize()
}

#[tauri::command]
pub fn session_usage(
    state: State<AppState>,
    project_id: i64,
    session_id: String,
) -> AppResult<UsageSummary> {
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    let dir = claude_root()?.join(&proj.claude_dir);
    let path = dir.join(format!("{session_id}.jsonl"));
    Ok(scan_file(&path))
}

#[tauri::command]
pub fn project_usage(
    state: State<AppState>,
    project_id: i64,
) -> AppResult<UsageSummary> {
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    let dir = claude_root()?.join(&proj.claude_dir);

    if !dir.exists() {
        return Ok(UsageSummary {
            tokens: Default::default(),
            cost_usd: 0.0,
            by_model: vec![],
            unknown_models: vec![],
        });
    }

    let files: Vec<PathBuf> = fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
        .collect();

    let max_mtime = files.iter().map(|p| mtime_ms(p)).max().unwrap_or(0);

    {
        let cache = state.project_usage_cache.lock();
        if let Some((cached_mtime, summary)) = cache.get(&project_id) {
            if *cached_mtime == max_mtime {
                return Ok(summary.clone());
            }
        }
    }

    let mut acc = UsageAccumulator::default();
    for path in &files {
        add_file(&mut acc, path);
    }
    let summary = acc.finalize();

    state.project_usage_cache.lock().insert(project_id, (max_mtime, summary.clone()));
    Ok(summary)
}
