use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use parking_lot::Mutex;
use notify::{RecommendedWatcher, RecursiveMode, Watcher as _, Event, EventKind};
use tauri::{AppHandle, Emitter};
use crate::domain::{HistoryBlock, SessionActivity};
use crate::error::AppResult;
use crate::sessions::parser::parse_line;
use crate::sessions::activity::compute_activity;
use crate::sessions::usage::UsageAccumulator;

struct OpenSession {
    path: PathBuf,
    last_offset: u64,
    usage: UsageAccumulator,
}

pub struct SessionWatchers {
    sessions: Mutex<HashMap<String, OpenSession>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    last_activity: Mutex<HashMap<String, SessionActivity>>,
}

impl SessionWatchers {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            watcher: Mutex::new(None),
            last_activity: Mutex::new(HashMap::new()),
        })
    }

    pub fn open(self: &Arc<Self>, app: AppHandle, session_id: &str, path: PathBuf) -> AppResult<()> {
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        {
            let mut acc = UsageAccumulator::default();
            if let Ok(file) = std::fs::File::open(&path) {
                use std::io::{BufRead, BufReader};
                for line in BufReader::new(file).lines().map_while(Result::ok) {
                    if line.trim().is_empty() { continue; }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                        acc.add_line(&v);
                    }
                }
            }
            let mut s = self.sessions.lock();
            s.insert(session_id.to_string(), OpenSession { path: path.clone(), last_offset: size, usage: acc });
        }
        let mut w = self.watcher.lock();
        if w.is_none() {
            let self_clone = self.clone();
            let app_clone = app.clone();
            let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
                if let Ok(ev) = res {
                    if matches!(ev.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                        for p in ev.paths {
                            self_clone.handle_change(&app_clone, &p);
                        }
                    }
                }
            }).map_err(|e| crate::error::AppError::Other(format!("notify: {e}")))?;
            *w = Some(watcher);
        }
        if let Some(watcher) = w.as_mut() {
            let dir = path.parent().map(|p| p.to_path_buf()).unwrap_or(path.clone());
            let _ = watcher.watch(&dir, RecursiveMode::NonRecursive);
        }
        Ok(())
    }

    pub fn close(&self, session_id: &str) {
        self.sessions.lock().remove(session_id);
        self.last_activity.lock().remove(session_id);
    }

    fn handle_change(&self, app: &AppHandle, changed: &Path) {
        let mut sessions = self.sessions.lock();
        let mut block_updates: Vec<(String, Vec<HistoryBlock>)> = Vec::new();
        let mut title_updates: Vec<(String, String)> = Vec::new();
        let mut activity_inputs: Vec<(String, PathBuf)> = Vec::new();
        let mut usage_updates: Vec<(String, crate::domain::UsageSummary)> = Vec::new();

        for (sid, sess) in sessions.iter_mut() {
            if sess.path != changed { continue; }
            let new_size = match std::fs::metadata(&sess.path) {
                Ok(m) => m.len(),
                Err(_) => continue,
            };
            if new_size <= sess.last_offset {
                activity_inputs.push((sid.clone(), sess.path.clone()));
                continue;
            }
            let prev_offset = sess.last_offset;
            let path = sess.path.clone();
            let tail = read_tail(&path, prev_offset, new_size, &mut sess.usage);
            sess.last_offset = new_size;
            usage_updates.push((sid.clone(), sess.usage.finalize()));
            if !tail.blocks.is_empty() {
                block_updates.push((sid.clone(), tail.blocks));
            }
            if let Some(title) = tail.title {
                title_updates.push((sid.clone(), title));
            }
            activity_inputs.push((sid.clone(), sess.path.clone()));
        }
        drop(sessions);

        for (sid, blocks) in block_updates {
            let _ = app.emit(&format!("session:{sid}:append"), serde_json::json!({ "blocks": blocks }));
        }
        for (sid, title) in title_updates {
            let _ = app.emit(&format!("session:{sid}:title"), serde_json::json!({ "title": title }));
        }
        for (sid, summary) in usage_updates {
            let _ = app.emit(&format!("session:{sid}:usage"), &summary);
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let mut last = self.last_activity.lock();
        for (sid, path) in activity_inputs {
            let new_activity = compute_activity(&path, now);
            let changed_state = last.get(&sid).copied() != Some(new_activity);
            if changed_state {
                last.insert(sid.clone(), new_activity);
                let _ = app.emit(
                    &format!("session:{sid}:activity"),
                    serde_json::json!({ "activity": new_activity }),
                );
            }
        }
        drop(last);

        std::thread::sleep(Duration::from_millis(50));
    }
}

struct TailResult {
    blocks: Vec<HistoryBlock>,
    title: Option<String>,
}

fn read_tail(path: &Path, from: u64, to: u64, usage: &mut UsageAccumulator) -> TailResult {
    use std::io::{Read, Seek, SeekFrom};
    let empty = TailResult { blocks: vec![], title: None };
    let mut f = match std::fs::File::open(path) { Ok(f) => f, Err(_) => return empty };
    if f.seek(SeekFrom::Start(from)).is_err() { return empty; }
    let mut buf = vec![0u8; (to - from) as usize];
    if f.read_exact(&mut buf).is_err() { return empty; }
    let text = String::from_utf8_lossy(&buf);
    let mut blocks = Vec::new();
    let mut title = None;
    for line in text.lines() {
        if line.trim().is_empty() { continue; }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if v.get("type").and_then(|t| t.as_str()) == Some("ai-title") {
                if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()) {
                    if !t.is_empty() {
                        title = Some(t.to_string());
                    }
                }
            }
            usage.add_line(&v);
        }
        if let Ok(bs) = parse_line(line) {
            blocks.extend(bs);
        }
    }
    TailResult { blocks, title }
}
