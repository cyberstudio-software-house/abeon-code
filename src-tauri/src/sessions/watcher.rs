use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use parking_lot::Mutex;
use notify::{RecommendedWatcher, RecursiveMode, Watcher as _, Event, EventKind};
use tauri::{AppHandle, Emitter};
use crate::domain::HistoryBlock;
use crate::error::AppResult;
use crate::sessions::parser::parse_line;

struct OpenSession {
    path: PathBuf,
    last_offset: u64,
}

pub struct SessionWatchers {
    sessions: Mutex<HashMap<String, OpenSession>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl SessionWatchers {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            watcher: Mutex::new(None),
        })
    }

    pub fn open(self: &Arc<Self>, app: AppHandle, session_id: &str, path: PathBuf) -> AppResult<()> {
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        {
            let mut s = self.sessions.lock();
            s.insert(session_id.to_string(), OpenSession { path: path.clone(), last_offset: size });
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
    }

    fn handle_change(&self, app: &AppHandle, changed: &Path) {
        let mut sessions = self.sessions.lock();
        let mut updates: Vec<(String, Vec<HistoryBlock>)> = Vec::new();

        for (sid, sess) in sessions.iter_mut() {
            if sess.path != changed { continue; }
            let new_size = match std::fs::metadata(&sess.path) {
                Ok(m) => m.len(),
                Err(_) => continue,
            };
            if new_size <= sess.last_offset { continue; }
            let blocks = read_tail(&sess.path, sess.last_offset, new_size);
            sess.last_offset = new_size;
            if !blocks.is_empty() {
                updates.push((sid.clone(), blocks));
            }
        }
        drop(sessions);

        for (sid, blocks) in updates {
            let _ = app.emit(&format!("session:{sid}:append"), serde_json::json!({ "blocks": blocks }));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn read_tail(path: &Path, from: u64, to: u64) -> Vec<HistoryBlock> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = match std::fs::File::open(path) { Ok(f) => f, Err(_) => return vec![] };
    if f.seek(SeekFrom::Start(from)).is_err() { return vec![]; }
    let mut buf = vec![0u8; (to - from) as usize];
    if f.read_exact(&mut buf).is_err() { return vec![]; }
    let text = String::from_utf8_lossy(&buf);
    let mut out = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() { continue; }
        if let Ok(bs) = parse_line(line) {
            out.extend(bs);
        }
    }
    out
}
