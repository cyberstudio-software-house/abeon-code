use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use parking_lot::Mutex;
use notify::{RecommendedWatcher, RecursiveMode, Watcher as _, Event, EventKind};
use tauri::{AppHandle, Emitter};
use crate::domain::{HistoryBlock, Provider, SessionActivity};
use crate::error::AppResult;
use crate::remote::bus::{RemoteEventBus, SessionBusEvent};
use crate::sessions::parser::parse_line;
use crate::sessions::activity::{compute_activity_for};
use crate::sessions::usage::UsageAccumulator;

struct OpenSession {
    path: PathBuf,
    provider: Provider,
    last_offset: u64,
    lines_seen: usize,
    usage: UsageAccumulator,
}

pub struct SessionWatchers {
    sessions: Mutex<HashMap<String, OpenSession>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    last_activity: Mutex<HashMap<String, SessionActivity>>,
    bus: Mutex<Option<RemoteEventBus>>,
}

impl SessionWatchers {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            watcher: Mutex::new(None),
            last_activity: Mutex::new(HashMap::new()),
            bus: Mutex::new(None),
        })
    }

    pub fn open(self: &Arc<Self>, app: AppHandle, session_id: &str, path: PathBuf, provider: Provider) -> AppResult<()> {
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        {
            let mut acc = UsageAccumulator::default();
            let mut lines_seen = 0usize;
            match provider {
                Provider::Claude => {
                    if let Ok(file) = std::fs::File::open(&path) {
                        use std::io::{BufRead, BufReader};
                        for line in BufReader::new(file).lines().map_while(Result::ok) {
                            if line.trim().is_empty() { continue; }
                            lines_seen += 1;
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                                acc.add_line(&v);
                            }
                        }
                    }
                }
                Provider::Codex => {
                    if let Ok(reader) = crate::sessions::codex::reader::open_lines(&path) {
                        use std::io::BufRead;
                        for _ in reader.lines().map_while(Result::ok) {
                            lines_seen += 1;
                        }
                    }
                }
            }
            let mut s = self.sessions.lock();
            s.insert(session_id.to_string(), OpenSession {
                path: path.clone(),
                provider,
                last_offset: size,
                lines_seen,
                usage: acc,
            });
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

    pub fn set_bus(&self, bus: RemoteEventBus) {
        *self.bus.lock() = Some(bus);
    }

    pub fn close(&self, session_id: &str) {
        self.sessions.lock().remove(session_id);
        self.last_activity.lock().remove(session_id);
    }

    fn handle_change(&self, app: &AppHandle, changed: &Path) {
        let mut sessions = self.sessions.lock();
        let mut block_updates: Vec<(String, Vec<HistoryBlock>)> = Vec::new();
        let mut title_updates: Vec<(String, String)> = Vec::new();
        let mut activity_inputs: Vec<(String, PathBuf, Provider)> = Vec::new();
        let mut usage_updates: Vec<(String, crate::domain::UsageSummary)> = Vec::new();

        for (sid, sess) in sessions.iter_mut() {
            if sess.path != changed { continue; }
            let new_size = match std::fs::metadata(&sess.path) {
                Ok(m) => m.len(),
                Err(_) => continue,
            };
            if new_size <= sess.last_offset {
                activity_inputs.push((sid.clone(), sess.path.clone(), sess.provider));
                continue;
            }
            let prev_offset = sess.last_offset;
            let path = sess.path.clone();
            let provider = sess.provider;

            // For Codex zst files, byte-offset seeking into a zstd stream is not valid.
            // In v1 we skip block parsing of appended lines for Codex zst files and emit
            // activity only. For plain .jsonl Codex files we parse appended lines normally.
            let is_zst = path.extension().map(|e| e == "zst").unwrap_or(false);
            let tail = if provider == Provider::Codex && is_zst {
                sess.last_offset = new_size;
                TailResult { blocks: vec![], title: None }
            } else {
                let tail = read_tail(&path, prev_offset, new_size, provider, &mut sess.usage, &mut sess.lines_seen);
                sess.last_offset = new_size;
                tail
            };

            if provider == Provider::Claude {
                usage_updates.push((sid.clone(), sess.usage.finalize()));
            }
            if !tail.blocks.is_empty() {
                block_updates.push((sid.clone(), tail.blocks));
            }
            if let Some(title) = tail.title {
                title_updates.push((sid.clone(), title));
            }
            activity_inputs.push((sid.clone(), sess.path.clone(), provider));
        }
        drop(sessions);

        let bus = self.bus.lock().clone();
        for (sid, blocks) in block_updates {
            let blocks_json = serde_json::json!({ "blocks": &blocks });
            let _ = app.emit(&format!("session:{sid}:append"), &blocks_json);
            if let Some(b) = &bus {
                b.publish(SessionBusEvent::Append { session_id: sid, blocks });
            }
        }
        for (sid, title) in title_updates {
            let _ = app.emit(&format!("session:{sid}:title"), serde_json::json!({ "title": title.clone() }));
            if let Some(b) = &bus {
                b.publish(SessionBusEvent::Title { session_id: sid, title });
            }
        }
        for (sid, summary) in usage_updates {
            let _ = app.emit(&format!("session:{sid}:usage"), &summary);
            if let Some(b) = &bus {
                b.publish(SessionBusEvent::Usage { session_id: sid, summary });
            }
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let mut last = self.last_activity.lock();
        for (sid, path, provider) in activity_inputs {
            let new_activity = compute_activity_for(provider, &path, now);
            let changed_state = last.get(&sid).copied() != Some(new_activity);
            if changed_state {
                last.insert(sid.clone(), new_activity);
                let activity_json = serde_json::json!({ "activity": new_activity });
                let _ = app.emit(&format!("session:{sid}:activity"), &activity_json);
                if matches!(new_activity, SessionActivity::WaitingUser | SessionActivity::WaitingTool) {
                    crate::notifications::emit_attention(app, crate::notifications::AttentionEvent {
                        session_id: sid.clone(),
                        reason: "heuristic".to_string(),
                        message: None,
                    });
                }
                if let Some(b) = &bus {
                    b.publish(SessionBusEvent::Activity { session_id: sid.clone(), activity: new_activity });
                }
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

fn read_tail(path: &Path, from: u64, to: u64, provider: Provider, usage: &mut UsageAccumulator, lines_seen: &mut usize) -> TailResult {
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
        let line_no = *lines_seen;
        *lines_seen += 1;
        if line.trim().is_empty() { continue; }
        match provider {
            Provider::Claude => {
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
            Provider::Codex => {
                if let Ok(bs) = crate::sessions::codex::parser::parse_codex_line(line_no, line) {
                    blocks.extend(bs);
                }
            }
        }
    }
    TailResult { blocks, title }
}
