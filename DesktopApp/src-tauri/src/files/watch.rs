use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use notify::event::ModifyKind;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager};

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
            rel_dir: rel_dir.trim_end_matches('/').to_string(),
        }
    }
}

struct Slot<H> {
    dir: PathBuf,
    handle: H,
    dead: bool,
    generation: u64,
}

struct DirtyCount {
    count: u32,
    generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Armed {
    Unchanged,
    Added {
        first_for_dir: bool,
        replaced: Option<PathBuf>,
    },
}

struct Registry<H> {
    slots: HashMap<WatchKey, Slot<H>>,
    dirty: HashMap<String, DirtyCount>,
    generations: HashMap<String, u64>,
}

impl<H> Registry<H> {
    fn new() -> Self {
        Self {
            slots: HashMap::new(),
            dirty: HashMap::new(),
            generations: HashMap::new(),
        }
    }

    fn insert_with(
        &mut self,
        key: WatchKey,
        dir: PathBuf,
        make: impl FnOnce() -> AppResult<H>,
    ) -> AppResult<Armed> {
        let generation = self.generation_of(&key.window_label);
        if self
            .slots
            .get(&key)
            .is_some_and(|slot| !slot.dead && slot.generation == generation)
        {
            return Ok(Armed::Unchanged);
        }
        let first_for_dir = self.live_users(&dir) == 0;
        let handle = make()?;
        let replaced = self.slots.insert(
            key,
            Slot {
                dir,
                handle,
                dead: false,
                generation,
            },
        );
        Ok(Armed::Added {
            first_for_dir,
            replaced: replaced.map(|slot| slot.dir),
        })
    }

    fn generation_of(&self, window_label: &str) -> u64 {
        self.generations.get(window_label).copied().unwrap_or(0)
    }

    fn remove(&mut self, key: &WatchKey) -> Option<Slot<H>> {
        self.slots.remove(key)
    }

    fn retire_window(&mut self, window_label: &str) -> u64 {
        let counter = self
            .generations
            .entry(window_label.to_string())
            .or_insert(0);
        let retired = *counter;
        *counter += 1;
        retired
    }

    fn drop_window(&mut self, window_label: &str, generation: u64) -> Vec<Slot<H>> {
        if self
            .dirty
            .get(window_label)
            .is_some_and(|dirty| dirty.generation <= generation)
        {
            self.dirty.remove(window_label);
        }
        let keys: Vec<WatchKey> = self
            .slots
            .iter()
            .filter(|(key, slot)| key.window_label == window_label && slot.generation <= generation)
            .map(|(key, _)| key.clone())
            .collect();
        keys.iter()
            .filter_map(|key| self.slots.remove(key))
            .collect()
    }

    fn live_users(&self, dir: &Path) -> usize {
        self.slots
            .values()
            .filter(|slot| !slot.dead && slot.dir == dir)
            .count()
    }

    fn for_each_live(&self, dir: &Path, mut action: impl FnMut(&H)) {
        for slot in self
            .slots
            .values()
            .filter(|slot| !slot.dead && slot.dir == dir)
        {
            action(&slot.handle);
        }
    }

    fn for_each_live_all(&self, mut action: impl FnMut(&H)) {
        for slot in self.slots.values().filter(|slot| !slot.dead) {
            action(&slot.handle);
        }
    }

    fn for_each_live_below(&self, dir: &Path, mut action: impl FnMut(&H)) {
        for slot in self
            .slots
            .values()
            .filter(|slot| !slot.dead && slot.dir != dir && slot.dir.starts_with(dir))
        {
            action(&slot.handle);
        }
    }

    fn mark_dir_dead(&mut self, dir: &Path) {
        for slot in self
            .slots
            .values_mut()
            .filter(|slot| slot.dir.starts_with(dir))
        {
            slot.dead = true;
        }
    }

    fn set_dirty(&mut self, window_label: &str, count: u32) {
        if count == 0 {
            self.dirty.remove(window_label);
        } else {
            let generation = self.generation_of(window_label);
            self.dirty
                .insert(window_label.to_string(), DirtyCount { count, generation });
        }
    }

    fn dirty_elsewhere(&mut self, window_label: &str, live_labels: &HashSet<String>) -> u32 {
        self.dirty.retain(|label, _| live_labels.contains(label));
        self.dirty
            .iter()
            .filter(|(label, _)| label.as_str() != window_label)
            .map(|(_, dirty)| dirty.count)
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

trait Trigger {
    fn trigger(&self);
}

struct Subscription {
    debouncer: Debouncer,
    active: Arc<AtomicBool>,
}

impl Subscription {
    fn new(delay: Duration, action: impl Fn() + Send + Sync + 'static) -> Self {
        let active = Arc::new(AtomicBool::new(true));
        let guard = active.clone();
        let debouncer = Debouncer::new(delay, move || {
            if guard.load(Ordering::SeqCst) {
                action();
            }
        });
        Self { debouncer, active }
    }
}

impl Trigger for Subscription {
    fn trigger(&self) {
        self.debouncer.trigger();
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.active.store(false, Ordering::SeqCst);
    }
}

fn trigger_every_live<H: Trigger>(registry: &Registry<H>) {
    registry.for_each_live_all(|handle| handle.trigger());
}

fn route_event<H: Trigger>(registry: &mut Registry<H>, event: &Event) {
    if matches!(event.kind, EventKind::Access(_)) {
        return;
    }
    if event.need_rescan() {
        trigger_every_live(registry);
        return;
    }
    let mut dirs: HashSet<&Path> = HashSet::new();
    for path in &event.paths {
        dirs.insert(path.as_path());
        if let Some(parent) = path.parent() {
            dirs.insert(parent);
        }
    }
    for dir in dirs {
        registry.for_each_live(dir, |handle| handle.trigger());
    }
    let dir_gone = matches!(
        event.kind,
        EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
    );
    if dir_gone {
        for path in &event.paths {
            registry.for_each_live_below(path, |handle| handle.trigger());
            registry.mark_dir_dead(path);
        }
    }
}

fn shared_watcher(registry: Arc<Mutex<Registry<Subscription>>>) -> AppResult<RecommendedWatcher> {
    notify::recommended_watcher(move |result: notify::Result<Event>| match result {
        Ok(event) => route_event(&mut registry.lock(), &event),
        Err(error) => eprintln!("files: watcher error: {error} {:?}", error.paths),
    })
    .map_err(|error| AppError::Other(format!("notify: {error}")))
}

pub struct FileWatches {
    registry: Arc<Mutex<Registry<Subscription>>>,
    control: Mutex<Option<RecommendedWatcher>>,
}

impl FileWatches {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            registry: Arc::new(Mutex::new(Registry::new())),
            control: Mutex::new(None),
        })
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
        let mut control = self.control.lock();
        let armed = {
            let mut registry = self.registry.lock();
            let emit_app = app.clone();
            let emit_label = key.window_label.clone();
            let emit_rel_dir = key.rel_dir.clone();
            registry.insert_with(key.clone(), abs_dir.clone(), || {
                Ok(Subscription::new(DEBOUNCE, move || {
                    let event = FilesDirChangedEvent {
                        project_id,
                        rel_dir: emit_rel_dir.clone(),
                    };
                    if let Err(error) =
                        emit_app.emit_to(emit_label.as_str(), FILES_DIR_CHANGED_EVENT, event)
                    {
                        eprintln!("files: directory change event failed: {error}");
                    }
                }))
            })?
        };
        let Armed::Added {
            first_for_dir,
            replaced,
        } = armed
        else {
            return Ok(());
        };
        let settled = self.settle_added(app, &mut control, &key, &abs_dir, first_for_dir);
        if let Some(dir) = replaced {
            self.release_dirs(&mut control, HashSet::from([dir]));
        }
        settled
    }

    fn settle_added(
        &self,
        app: &AppHandle,
        control: &mut Option<RecommendedWatcher>,
        key: &WatchKey,
        abs_dir: &Path,
        first_for_dir: bool,
    ) -> AppResult<()> {
        if app.get_webview_window(&key.window_label).is_none() {
            let removed = self.registry.lock().remove(key);
            drop(removed);
            return Ok(());
        }
        if first_for_dir {
            if let Err(error) = self.establish(control, abs_dir) {
                let removed = self.registry.lock().remove(key);
                drop(removed);
                return Err(error);
            }
        }
        Ok(())
    }

    fn establish(&self, control: &mut Option<RecommendedWatcher>, abs_dir: &Path) -> AppResult<()> {
        if control.is_none() {
            *control = Some(shared_watcher(self.registry.clone())?);
        }
        if let Some(watcher) = control.as_mut() {
            let unwatched = watcher.unwatch(abs_dir).is_ok();
            let watched = watcher.watch(abs_dir, RecursiveMode::NonRecursive);
            if unwatched || watched.is_ok() {
                self.cover_stream_restart();
            }
            watched.map_err(|error| {
                eprintln!("files: cannot watch {}: {error}", abs_dir.display());
                AppError::Other(format!("notify: {error}"))
            })?;
        }
        Ok(())
    }

    fn cover_stream_restart(&self) {
        #[cfg(target_os = "macos")]
        trigger_every_live(&self.registry.lock());
    }

    fn release_dirs(&self, control: &mut Option<RecommendedWatcher>, dirs: HashSet<PathBuf>) {
        let Some(watcher) = control.as_mut() else {
            return;
        };
        for dir in dirs {
            if self.registry.lock().live_users(&dir) > 0 {
                continue;
            }
            match watcher.unwatch(&dir) {
                Ok(()) => self.cover_stream_restart(),
                Err(error) if matches!(error.kind, notify::ErrorKind::WatchNotFound) => {}
                Err(error) => eprintln!("files: cannot unwatch {}: {error}", dir.display()),
            }
        }
    }

    pub fn unwatch(&self, window_label: &str, project_id: i64, rel_dir: &str) {
        let key = WatchKey::new(window_label, project_id, rel_dir);
        let mut control = self.control.lock();
        let removed = self.registry.lock().remove(&key);
        if let Some(slot) = removed {
            let dirs = HashSet::from([slot.dir.clone()]);
            drop(slot);
            self.release_dirs(&mut control, dirs);
        }
    }

    pub fn retire_window(&self, window_label: &str) -> u64 {
        self.registry.lock().retire_window(window_label)
    }

    pub fn drop_window(&self, window_label: &str, generation: u64) {
        let mut control = self.control.lock();
        let removed = self.registry.lock().drop_window(window_label, generation);
        let dirs: HashSet<PathBuf> = removed.iter().map(|slot| slot.dir.clone()).collect();
        drop(removed);
        self.release_dirs(&mut control, dirs);
    }

    pub fn set_dirty(&self, window_label: &str, count: u32) {
        self.registry.lock().set_dirty(window_label, count);
    }

    pub fn dirty_elsewhere(&self, window_label: &str, live_labels: &HashSet<String>) -> u32 {
        self.registry
            .lock()
            .dirty_elsewhere(window_label, live_labels)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::Instant;

    fn key(window: &str, project: i64, dir: &str) -> WatchKey {
        WatchKey::new(window, project, dir)
    }

    fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if condition() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        condition()
    }

    fn labels(names: &[&str]) -> HashSet<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn dirty_elsewhere_sums_other_windows() {
        let mut registry: Registry<()> = Registry::new();
        registry.set_dirty("main", 0);
        registry.set_dirty("project-1", 2);
        registry.set_dirty("session-x", 1);
        let live = labels(&["main", "project-1", "session-x"]);
        assert_eq!(registry.dirty_elsewhere("main", &live), 3);
        assert_eq!(registry.dirty_elsewhere("project-1", &live), 1);
    }

    #[test]
    fn dirty_elsewhere_ignores_and_prunes_labels_of_closed_windows() {
        let mut registry: Registry<()> = Registry::new();
        registry.set_dirty("project-1", 2);
        registry.set_dirty("project-2", 5);
        let live = labels(&["main", "project-1"]);

        assert_eq!(registry.dirty_elsewhere("main", &live), 2);
        assert!(!registry.dirty.contains_key("project-2"));
        assert_eq!(
            registry.dirty.get("project-1").map(|dirty| dirty.count),
            Some(2)
        );
    }

    #[test]
    fn dirty_count_set_after_the_window_was_dropped_never_blocks() {
        let mut registry: Registry<()> = Registry::new();
        let retired = registry.retire_window("project-1");
        registry.drop_window("project-1", retired);
        registry.set_dirty("project-1", 3);

        assert_eq!(registry.dirty_elsewhere("main", &labels(&["main"])), 0);
        assert!(registry.dirty.is_empty());
    }

    #[test]
    fn drop_window_clears_dirty_and_watches() {
        let mut registry: Registry<u8> = Registry::new();
        registry
            .insert_with(key("project-1", 1, ""), PathBuf::from("/a"), || Ok(1))
            .unwrap();
        registry
            .insert_with(key("project-1", 1, "src"), PathBuf::from("/a/src"), || {
                Ok(2)
            })
            .unwrap();
        registry
            .insert_with(key("main", 1, ""), PathBuf::from("/a"), || Ok(3))
            .unwrap();
        registry.set_dirty("project-1", 4);
        registry.set_dirty("main", 1);

        let retired = registry.retire_window("project-1");
        let dropped = registry.drop_window("project-1", retired);

        assert_eq!(dropped.len(), 2);
        assert_eq!(registry.slots.len(), 1);
        assert!(registry.slots.contains_key(&key("main", 1, "")));
        let live = labels(&["main", "other", "project-1"]);
        assert_eq!(registry.dirty_elsewhere("main", &live), 0);
        assert_eq!(registry.dirty_elsewhere("other", &live), 1);
    }

    #[test]
    fn watch_is_idempotent() {
        let mut registry: Registry<u8> = Registry::new();
        let calls = AtomicUsize::new(0);
        let factory = || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(7)
        };
        let first = registry
            .insert_with(key("main", 1, "src"), PathBuf::from("/a/src"), factory)
            .unwrap();
        let second = registry
            .insert_with(key("main", 1, "src"), PathBuf::from("/a/src"), || {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(8)
            })
            .unwrap();

        assert_eq!(
            first,
            Armed::Added {
                first_for_dir: true,
                replaced: None,
            }
        );
        assert_eq!(second, Armed::Unchanged);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(registry.slots.len(), 1);
        assert!(registry.remove(&key("main", 1, "src")).is_some());
        assert!(registry.slots.is_empty());
        assert!(registry.remove(&key("main", 1, "src")).is_none());
    }

    #[test]
    fn failing_factory_inserts_nothing() {
        let mut registry: Registry<u8> = Registry::new();
        let result = registry.insert_with(key("main", 1, "src"), PathBuf::from("/a/src"), || {
            Err(AppError::Other("boom".to_string()))
        });
        assert!(result.is_err());
        assert!(registry.slots.is_empty());
    }

    #[test]
    fn trailing_slash_is_one_watch() {
        let mut registry: Registry<u8> = Registry::new();
        registry
            .insert_with(key("main", 1, "src"), PathBuf::from("/a/src"), || Ok(1))
            .unwrap();
        let again = registry
            .insert_with(key("main", 1, "src/"), PathBuf::from("/a/src"), || Ok(2))
            .unwrap();
        assert_eq!(again, Armed::Unchanged);
        assert_eq!(key("main", 1, "src/"), key("main", 1, "src"));
        assert_eq!(key("main", 1, "/"), key("main", 1, ""));
        assert!(registry.remove(&key("main", 1, "src//")).is_some());
    }

    #[test]
    fn dead_entry_is_replaced_by_the_next_watch() {
        let mut registry: Registry<u8> = Registry::new();
        let dir = PathBuf::from("/a/src");
        registry
            .insert_with(key("main", 1, "src"), dir.clone(), || Ok(1))
            .unwrap();
        assert_eq!(registry.live_users(&dir), 1);

        registry.mark_dir_dead(&dir);
        assert_eq!(registry.live_users(&dir), 0);
        let mut seen = 0;
        registry.for_each_live(&dir, |_| seen += 1);
        assert_eq!(seen, 0);

        let replaced = registry
            .insert_with(key("main", 1, "src"), dir.clone(), || Ok(2))
            .unwrap();
        assert_eq!(
            replaced,
            Armed::Added {
                first_for_dir: true,
                replaced: Some(dir.clone()),
            }
        );
        assert_eq!(registry.live_users(&dir), 1);
        assert_eq!(
            registry
                .slots
                .get(&key("main", 1, "src"))
                .map(|slot| slot.handle),
            Some(2)
        );
    }

    #[test]
    fn failing_factory_keeps_a_dead_entry_dead() {
        let mut registry: Registry<u8> = Registry::new();
        let dir = PathBuf::from("/a/src");
        registry
            .insert_with(key("main", 1, "src"), dir.clone(), || Ok(1))
            .unwrap();
        registry.mark_dir_dead(&dir);
        let result = registry.insert_with(key("main", 1, "src"), dir.clone(), || {
            Err(AppError::Other("boom".to_string()))
        });
        assert!(result.is_err());
        assert_eq!(registry.live_users(&dir), 0);
    }

    #[test]
    fn entries_of_a_recreated_window_survive_the_deferred_drop() {
        let mut registry: Registry<u8> = Registry::new();
        registry
            .insert_with(key("project-1", 1, "src"), PathBuf::from("/a/src"), || {
                Ok(1)
            })
            .unwrap();
        registry
            .insert_with(key("project-1", 1, "lib"), PathBuf::from("/a/lib"), || {
                Ok(2)
            })
            .unwrap();
        registry.set_dirty("project-1", 4);

        let retired = registry.retire_window("project-1");
        let rearmed = registry
            .insert_with(key("project-1", 1, "src"), PathBuf::from("/a/src"), || {
                Ok(3)
            })
            .unwrap();
        registry
            .insert_with(
                key("project-1", 1, "docs"),
                PathBuf::from("/a/docs"),
                || Ok(4),
            )
            .unwrap();
        registry.set_dirty("project-1", 2);
        let dropped = registry.drop_window("project-1", retired);

        assert_eq!(
            rearmed,
            Armed::Added {
                first_for_dir: false,
                replaced: Some(PathBuf::from("/a/src")),
            }
        );
        let dropped: Vec<u8> = dropped.iter().map(|slot| slot.handle).collect();
        assert_eq!(dropped, vec![2]);
        assert_eq!(
            registry
                .slots
                .get(&key("project-1", 1, "src"))
                .map(|slot| slot.handle),
            Some(3)
        );
        assert!(registry.slots.contains_key(&key("project-1", 1, "docs")));
        let live = labels(&["main", "project-1"]);
        assert_eq!(registry.dirty_elsewhere("main", &live), 2);
    }

    #[test]
    fn replacing_a_slot_hands_its_directory_to_the_release_path() {
        let mut registry: Registry<u8> = Registry::new();
        let src = PathBuf::from("/a/src");
        let lib = PathBuf::from("/a/lib");
        let moved = PathBuf::from("/b/lib");
        registry
            .insert_with(key("project-1", 1, "src"), src.clone(), || Ok(1))
            .unwrap();
        registry
            .insert_with(key("project-1", 1, "lib"), lib.clone(), || Ok(2))
            .unwrap();
        registry.retire_window("project-1");

        let same_dir = registry
            .insert_with(key("project-1", 1, "src"), src.clone(), || Ok(3))
            .unwrap();
        assert_eq!(
            same_dir,
            Armed::Added {
                first_for_dir: false,
                replaced: Some(src.clone()),
            }
        );
        assert_eq!(registry.live_users(&src), 1);
        drop(registry.remove(&key("project-1", 1, "src")));
        assert_eq!(registry.live_users(&src), 0);

        let elsewhere = registry
            .insert_with(key("project-1", 1, "lib"), moved.clone(), || Ok(4))
            .unwrap();
        assert_eq!(
            elsewhere,
            Armed::Added {
                first_for_dir: true,
                replaced: Some(lib.clone()),
            }
        );
        assert_eq!(registry.live_users(&lib), 0);
        assert_eq!(registry.live_users(&moved), 1);
    }

    #[test]
    fn retiring_a_window_does_not_touch_other_labels() {
        let mut registry: Registry<u8> = Registry::new();
        registry
            .insert_with(key("main", 1, "src"), PathBuf::from("/a/src"), || Ok(1))
            .unwrap();
        assert_eq!(registry.retire_window("project-1"), 0);
        assert_eq!(registry.retire_window("project-1"), 1);
        let dropped = registry.drop_window("main", 0);
        assert_eq!(dropped.len(), 1);
        let again = registry
            .insert_with(key("main", 1, "src"), PathBuf::from("/a/src"), || Ok(2))
            .unwrap();
        assert_eq!(
            again,
            Armed::Added {
                first_for_dir: true,
                replaced: None,
            }
        );
    }

    #[test]
    fn rearming_a_live_slot_needs_no_os_watch() {
        let mut registry: Registry<u8> = Registry::new();
        let dir = PathBuf::from("/a/src");
        let calls = AtomicUsize::new(0);
        let factory = |handle: u8| {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(handle)
        };

        let first = registry
            .insert_with(key("main", 1, "src"), dir.clone(), || factory(1))
            .unwrap();
        let rearms: Vec<Armed> = (0..3)
            .map(|_| {
                registry
                    .insert_with(key("main", 1, "src"), dir.clone(), || factory(2))
                    .unwrap()
            })
            .collect();
        let other_window = registry
            .insert_with(key("project-1", 1, "src"), dir.clone(), || factory(3))
            .unwrap();

        assert_eq!(
            first,
            Armed::Added {
                first_for_dir: true,
                replaced: None,
            }
        );
        assert!(rearms.iter().all(|armed| *armed == Armed::Unchanged));
        assert_eq!(
            other_window,
            Armed::Added {
                first_for_dir: false,
                replaced: None,
            }
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            registry
                .slots
                .get(&key("main", 1, "src"))
                .map(|slot| slot.handle),
            Some(1)
        );
    }

    #[test]
    fn live_users_counts_every_window_on_a_directory() {
        let mut registry: Registry<u8> = Registry::new();
        let dir = PathBuf::from("/a/src");
        registry
            .insert_with(key("main", 1, "src"), dir.clone(), || Ok(1))
            .unwrap();
        registry
            .insert_with(key("project-1", 1, "src"), dir.clone(), || Ok(2))
            .unwrap();
        registry
            .insert_with(key("main", 1, "lib"), PathBuf::from("/a/lib"), || Ok(3))
            .unwrap();
        assert_eq!(registry.live_users(&dir), 2);
        registry.remove(&key("main", 1, "src"));
        assert_eq!(registry.live_users(&dir), 1);
    }

    #[tokio::test]
    async fn debouncer_coalesces_a_burst_into_one_action() {
        let counter = Arc::new(AtomicUsize::new(0));
        let counted = counter.clone();
        let debouncer = Debouncer::new(Duration::from_millis(300), move || {
            counted.fetch_add(1, Ordering::SeqCst);
        });
        for _ in 0..20 {
            debouncer.trigger();
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        debouncer.trigger();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn dropping_a_subscription_cancels_its_pending_action() {
        let counter = Arc::new(AtomicUsize::new(0));
        let counted = counter.clone();
        let subscription = Subscription::new(Duration::from_millis(100), move || {
            counted.fetch_add(1, Ordering::SeqCst);
        });
        subscription.trigger();
        drop(subscription);
        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(counter.load(Ordering::SeqCst), 0);
    }

    fn counting_subscription(counter: &Arc<AtomicUsize>) -> Subscription {
        let counted = counter.clone();
        Subscription::new(Duration::from_millis(100), move || {
            counted.fetch_add(1, Ordering::SeqCst);
        })
    }

    #[test]
    fn shared_watcher_routes_events_to_the_matching_directory_and_marks_removal() {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap();
        let watched = root.join("watched");
        let other = root.join("other");
        std::fs::create_dir_all(&watched).unwrap();
        std::fs::create_dir_all(&other).unwrap();

        let registry = Arc::new(Mutex::new(Registry::new()));
        let watched_hits = Arc::new(AtomicUsize::new(0));
        let other_hits = Arc::new(AtomicUsize::new(0));
        registry
            .lock()
            .insert_with(key("main", 1, "watched"), watched.clone(), || {
                Ok(counting_subscription(&watched_hits))
            })
            .unwrap();
        registry
            .lock()
            .insert_with(key("project-1", 1, "watched"), watched.clone(), || {
                Ok(counting_subscription(&watched_hits))
            })
            .unwrap();
        registry
            .lock()
            .insert_with(key("main", 1, "other"), other.clone(), || {
                Ok(counting_subscription(&other_hits))
            })
            .unwrap();

        let mut watcher = shared_watcher(registry.clone()).unwrap();
        watcher
            .watch(&watched, RecursiveMode::NonRecursive)
            .unwrap();
        watcher.watch(&other, RecursiveMode::NonRecursive).unwrap();

        for index in 0..10 {
            std::fs::write(watched.join(format!("file-{index}.txt")), "x").unwrap();
        }
        assert!(wait_until(Duration::from_secs(10), || watched_hits
            .load(Ordering::SeqCst)
            >= 2));
        std::thread::sleep(Duration::from_millis(600));
        let settled = watched_hits.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(600));
        assert!(settled >= 2);
        assert_eq!(watched_hits.load(Ordering::SeqCst), settled);
        assert_eq!(other_hits.load(Ordering::SeqCst), 0);

        std::fs::remove_dir_all(&watched).unwrap();
        assert!(wait_until(Duration::from_secs(10), || {
            registry.lock().live_users(&watched) == 0
        }));
        assert!(wait_until(Duration::from_secs(10), || watched_hits
            .load(Ordering::SeqCst)
            > settled));
        assert_eq!(registry.lock().live_users(&other), 1);

        std::fs::create_dir_all(&watched).unwrap();
        let replaced = registry
            .lock()
            .insert_with(key("main", 1, "watched"), watched.clone(), || {
                Ok(counting_subscription(&watched_hits))
            })
            .unwrap();
        assert_eq!(
            replaced,
            Armed::Added {
                first_for_dir: true,
                replaced: Some(watched.clone()),
            }
        );
        let _ = watcher.unwatch(&watched);
        watcher
            .watch(&watched, RecursiveMode::NonRecursive)
            .unwrap();
        let before = watched_hits.load(Ordering::SeqCst);
        std::fs::write(watched.join("again.txt"), "x").unwrap();
        assert!(wait_until(Duration::from_secs(10), || watched_hits
            .load(Ordering::SeqCst)
            > before));
    }

    #[derive(Default)]
    struct Recorder {
        hits: AtomicUsize,
    }

    impl Trigger for Arc<Recorder> {
        fn trigger(&self) {
            self.hits.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn recorded_registry(
        entries: &[(&str, &str)],
    ) -> (Registry<Arc<Recorder>>, Vec<Arc<Recorder>>) {
        let mut registry = Registry::new();
        let mut recorders = Vec::new();
        for (rel, dir) in entries {
            let recorder = Arc::new(Recorder::default());
            recorders.push(recorder.clone());
            registry
                .insert_with(key("main", 1, rel), PathBuf::from(dir), || Ok(recorder))
                .unwrap();
        }
        (registry, recorders)
    }

    fn hits(recorder: &Arc<Recorder>) -> usize {
        recorder.hits.load(Ordering::SeqCst)
    }

    #[test]
    fn marking_a_directory_dead_covers_its_subdirectories_by_path_component() {
        let (mut registry, _recorders) = recorded_registry(&[
            ("src", "/p/src"),
            ("src/comp", "/p/src/comp"),
            ("src2", "/p/src2"),
        ]);
        registry.mark_dir_dead(Path::new("/p/src"));
        assert_eq!(registry.live_users(Path::new("/p/src")), 0);
        assert_eq!(registry.live_users(Path::new("/p/src/comp")), 0);
        assert_eq!(registry.live_users(Path::new("/p/src2")), 1);
    }

    #[test]
    fn renaming_a_watched_directory_notifies_and_kills_nested_watches() {
        let (mut registry, recorders) = recorded_registry(&[
            ("src", "/p/src"),
            ("src/comp", "/p/src/comp"),
            ("src2", "/p/src2"),
            ("", "/p"),
        ]);
        let event = Event::new(EventKind::Modify(ModifyKind::Name(
            notify::event::RenameMode::From,
        )))
        .add_path(PathBuf::from("/p/src"));

        route_event(&mut registry, &event);

        assert_eq!(hits(&recorders[0]), 1);
        assert_eq!(hits(&recorders[1]), 1);
        assert_eq!(hits(&recorders[2]), 0);
        assert_eq!(hits(&recorders[3]), 1);
        assert_eq!(registry.live_users(Path::new("/p/src")), 0);
        assert_eq!(registry.live_users(Path::new("/p/src/comp")), 0);
        assert_eq!(registry.live_users(Path::new("/p/src2")), 1);
        assert_eq!(registry.live_users(Path::new("/p")), 1);
    }

    #[test]
    fn a_file_event_notifies_only_its_parent_directory() {
        let (mut registry, recorders) = recorded_registry(&[("src", "/p/src"), ("lib", "/p/lib")]);
        let event = Event::new(EventKind::Create(notify::event::CreateKind::File))
            .add_path(PathBuf::from("/p/src/a.txt"));

        route_event(&mut registry, &event);

        assert_eq!(hits(&recorders[0]), 1);
        assert_eq!(hits(&recorders[1]), 0);
        assert_eq!(registry.live_users(Path::new("/p/src")), 1);
    }

    #[test]
    fn a_queue_overflow_notifies_every_live_entry() {
        let (mut registry, recorders) =
            recorded_registry(&[("src", "/p/src"), ("lib", "/p/lib"), ("gone", "/p/gone")]);
        registry.mark_dir_dead(Path::new("/p/gone"));
        let event = Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan);

        route_event(&mut registry, &event);

        assert_eq!(hits(&recorders[0]), 1);
        assert_eq!(hits(&recorders[1]), 1);
        assert_eq!(hits(&recorders[2]), 0);
    }

    #[test]
    fn triggering_every_live_entry_skips_dead_ones() {
        let (mut registry, recorders) =
            recorded_registry(&[("src", "/p/src"), ("lib", "/p/lib"), ("gone", "/p/gone")]);
        registry.mark_dir_dead(Path::new("/p/gone"));

        trigger_every_live(&registry);

        assert_eq!(hits(&recorders[0]), 1);
        assert_eq!(hits(&recorders[1]), 1);
        assert_eq!(hits(&recorders[2]), 0);
    }

    #[test]
    fn access_events_notify_nobody() {
        let (mut registry, recorders) = recorded_registry(&[("src", "/p/src")]);
        let event = Event::new(EventKind::Access(notify::event::AccessKind::Read))
            .add_path(PathBuf::from("/p/src/a.txt"));
        route_event(&mut registry, &event);
        assert_eq!(hits(&recorders[0]), 0);
    }
}
