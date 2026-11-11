use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use crate::domain::files::{FilesDirChangedEvent, FILES_DIR_CHANGED_EVENT};
use crate::error::{AppError, AppResult};

const DEBOUNCE: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct WatchKey {
    window_label: String,
    project_id: i64,
    rel_dir: String,
}

impl WatchKey {
    fn new(window_label: &str, project_id: i64, rel_dir: &str) -> Self {
        Self {
            window_label: window_label.to_string(),
            project_id,
            rel_dir: rel_dir.to_string(),
        }
    }
}

struct Registry<H> {
    watches: HashMap<WatchKey, H>,
    dirty: HashMap<String, u32>,
}

impl<H> Registry<H> {
    fn new() -> Self {
        Self { watches: HashMap::new(), dirty: HashMap::new() }
    }

    fn contains(&self, key: &WatchKey) -> bool {
        self.watches.contains_key(key)
    }

    fn insert(&mut self, key: WatchKey, handle: H) {
        self.watches.insert(key, handle);
    }

    fn remove(&mut self, key: &WatchKey) -> Option<H> {
        self.watches.remove(key)
    }

    fn drop_window(&mut self, window_label: &str) -> Vec<H> {
        self.dirty.remove(window_label);
        let keys: Vec<WatchKey> = self
            .watches
            .keys()
            .filter(|key| key.window_label == window_label)
            .cloned()
            .collect();
        keys.iter().filter_map(|key| self.watches.remove(key)).collect()
    }

    fn set_dirty(&mut self, window_label: &str, count: u32) {
        if count == 0 {
            self.dirty.remove(window_label);
        } else {
            self.dirty.insert(window_label.to_string(), count);
        }
    }

    fn dirty_elsewhere(&self, window_label: &str) -> u32 {
        self.dirty
            .iter()
            .filter(|(label, _)| label.as_str() != window_label)
            .map(|(_, count)| *count)
            .sum()
    }
}

struct Debouncer {
    delay: Duration,
    scheduled: Arc<AtomicBool>,
    action: Arc<dyn Fn() + Send + Sync>,
}

impl Debouncer {
    fn new(delay: Duration, action: impl Fn() + Send + Sync + 'static) -> Self {
        Self {
            delay,
            scheduled: Arc::new(AtomicBool::new(false)),
            action: Arc::new(action),
        }
    }

    fn trigger(&self) {
        if self.scheduled.swap(true, Ordering::SeqCst) {
            return;
        }
        let delay = self.delay;
        let scheduled = self.scheduled.clone();
        let action = self.action.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            scheduled.store(false, Ordering::SeqCst);
            action();
        });
    }
}

struct WatchHandle {
    _watcher: RecommendedWatcher,
    active: Arc<AtomicBool>,
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        self.active.store(false, Ordering::SeqCst);
    }
}

fn start_watcher(
    app: &AppHandle,
    window_label: &str,
    project_id: i64,
    rel_dir: &str,
    abs_dir: PathBuf,
) -> AppResult<WatchHandle> {
    let active = Arc::new(AtomicBool::new(true));
    let emit_app = app.clone();
    let emit_label = window_label.to_string();
    let emit_rel_dir = rel_dir.to_string();
    let emit_active = active.clone();
    let debouncer = Debouncer::new(DEBOUNCE, move || {
        if !emit_active.load(Ordering::SeqCst) {
            return;
        }
        let event = FilesDirChangedEvent {
            project_id,
            rel_dir: emit_rel_dir.clone(),
        };
        if let Err(error) = emit_app.emit_to(emit_label.as_str(), FILES_DIR_CHANGED_EVENT, event) {
            eprintln!("files: directory change event failed: {error}");
        }
    });
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        if let Ok(event) = result {
            if !matches!(event.kind, EventKind::Access(_)) {
                debouncer.trigger();
            }
        }
    })
    .map_err(|error| AppError::Other(format!("notify: {error}")))?;
    watcher
        .watch(&abs_dir, RecursiveMode::NonRecursive)
        .map_err(|error| AppError::Other(format!("notify: {error}")))?;
    Ok(WatchHandle { _watcher: watcher, active })
}

pub struct FileWatches {
    registry: Mutex<Registry<WatchHandle>>,
}

impl FileWatches {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { registry: Mutex::new(Registry::new()) })
    }

    pub fn watch(
        &self,
        app: &AppHandle,
        window_label: &str,
        project_id: i64,
        rel_dir: &str,
        abs_dir: PathBuf,
    ) -> AppResult<()> {
        let key = WatchKey::new(window_label, project_id, rel_dir);
        let mut registry = self.registry.lock();
        if registry.contains(&key) {
            return Ok(());
        }
        let handle = start_watcher(app, window_label, project_id, rel_dir, abs_dir)?;
        registry.insert(key, handle);
        Ok(())
    }

    pub fn unwatch(&self, window_label: &str, project_id: i64, rel_dir: &str) {
        let removed = self
            .registry
            .lock()
            .remove(&WatchKey::new(window_label, project_id, rel_dir));
        drop(removed);
    }

    pub fn drop_window(&self, window_label: &str) {
        let removed = self.registry.lock().drop_window(window_label);
        drop(removed);
    }

    pub fn set_dirty(&self, window_label: &str, count: u32) {
        self.registry.lock().set_dirty(window_label, count);
    }

    pub fn dirty_elsewhere(&self, window_label: &str) -> u32 {
        self.registry.lock().dirty_elsewhere(window_label)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirty_elsewhere_sums_other_windows() {
        let mut registry: Registry<()> = Registry::new();
        registry.set_dirty("main", 0);
        registry.set_dirty("project-1", 2);
        registry.set_dirty("session-x", 1);
        assert_eq!(registry.dirty_elsewhere("main"), 3);
        assert_eq!(registry.dirty_elsewhere("project-1"), 1);
    }

    #[test]
    fn drop_window_clears_dirty_and_watches() {
        let mut registry: Registry<u8> = Registry::new();
        registry.insert(WatchKey::new("project-1", 1, ""), 1);
        registry.insert(WatchKey::new("project-1", 1, "src"), 2);
        registry.insert(WatchKey::new("main", 1, ""), 3);
        registry.set_dirty("project-1", 4);
        registry.set_dirty("main", 1);

        let dropped = registry.drop_window("project-1");

        assert_eq!(dropped.len(), 2);
        assert!(!registry.contains(&WatchKey::new("project-1", 1, "")));
        assert!(!registry.contains(&WatchKey::new("project-1", 1, "src")));
        assert!(registry.contains(&WatchKey::new("main", 1, "")));
        assert_eq!(registry.dirty_elsewhere("main"), 0);
        assert_eq!(registry.dirty_elsewhere("other"), 1);
    }

    #[test]
    fn watch_is_idempotent() {
        let mut registry: Registry<u8> = Registry::new();
        let key = WatchKey::new("main", 1, "src");
        if !registry.contains(&key) {
            registry.insert(key.clone(), 1);
        }
        if !registry.contains(&key) {
            registry.insert(key.clone(), 2);
        }
        assert_eq!(registry.watches.len(), 1);
        assert_eq!(registry.watches.get(&key), Some(&1));
        assert!(registry.remove(&key).is_some());
        assert!(registry.watches.is_empty());
        assert!(registry.remove(&key).is_none());
    }

    #[tokio::test]
    async fn debouncer_coalesces_a_burst_into_one_action() {
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = counter.clone();
        let debouncer = Debouncer::new(Duration::from_millis(40), move || {
            counted.fetch_add(1, Ordering::SeqCst);
        });
        for _ in 0..20 {
            debouncer.trigger();
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        debouncer.trigger();
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }
}
