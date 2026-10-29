pub mod handle;
pub mod session_registry;
pub mod input_activity;

use std::collections::HashMap;
use std::sync::Arc;
use parking_lot::Mutex;
use uuid::Uuid;
use tauri::AppHandle;
use crate::error::{AppError, AppResult};
use self::handle::PtyHandle;

#[derive(Default)]
pub struct PtyManager {
    inner: Mutex<HashMap<String, Arc<PtyHandle>>>,
    #[allow(clippy::type_complexity)]
    exit_hook: Mutex<Option<Arc<dyn Fn(String) + Send + Sync>>>,
}

impl PtyManager {
    pub fn new() -> Arc<Self> { Arc::new(Self::default()) }

    pub fn set_exit_hook(&self, hook: Arc<dyn Fn(String) + Send + Sync>) {
        *self.exit_hook.lock() = Some(hook);
    }

    pub fn spawn(
        &self,
        app: AppHandle,
        program: &str,
        args: &[&str],
        cwd: &std::path::Path,
        cols: u16,
        rows: u16,
        env: &HashMap<String, String>,
    ) -> AppResult<String> {
        self.spawn_with_exit_hook(app, program, args, cwd, cols, rows, env, None)
    }

    pub fn spawn_with_exit_hook(
        &self,
        app: AppHandle,
        program: &str,
        args: &[&str],
        cwd: &std::path::Path,
        cols: u16,
        rows: u16,
        env: &HashMap<String, String>,
        local_exit_hook: Option<Arc<dyn Fn(String) + Send + Sync>>,
    ) -> AppResult<String> {
        self.spawn_as(Uuid::new_v4().to_string(), app, program, args, cwd, cols, rows, env, local_exit_hook)
    }

    pub fn spawn_as(
        &self,
        id: String,
        app: AppHandle,
        program: &str,
        args: &[&str],
        cwd: &std::path::Path,
        cols: u16,
        rows: u16,
        env: &HashMap<String, String>,
        local_exit_hook: Option<Arc<dyn Fn(String) + Send + Sync>>,
    ) -> AppResult<String> {
        let global_exit_hook = self.exit_hook.lock().clone();
        let hook = if global_exit_hook.is_some() || local_exit_hook.is_some() {
            Some(Arc::new(move |pty_id: String| {
                if let Some(global) = &global_exit_hook {
                    global(pty_id.clone());
                }
                if let Some(local) = &local_exit_hook {
                    local(pty_id);
                }
            }) as Arc<dyn Fn(String) + Send + Sync>)
        } else {
            None
        };
        let h = PtyHandle::spawn(app, id.clone(), program, args, cwd, cols, rows, env, hook)?;
        self.inner.lock().insert(id.clone(), Arc::new(h));
        Ok(id)
    }

    pub fn contains(&self, id: &str) -> bool {
        self.inner.lock().contains_key(id)
    }

    fn handle(&self, id: &str) -> AppResult<Arc<PtyHandle>> {
        self.inner
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("pty {id}")))
    }

    pub fn write(&self, id: &str, data: &[u8]) -> AppResult<()> {
        self.handle(id)?.write(data)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> AppResult<()> {
        self.handle(id)?.resize(cols, rows)
    }

    pub fn kill(&self, id: &str) -> AppResult<()> {
        let removed = self.inner.lock().remove(id);
        if let Some(h) = removed { let _ = h.kill(); }
        Ok(())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use portable_pty::{native_pty_system, PtySize};
    use std::io::Write;
    use std::sync::mpsc;
    use std::time::Duration;

    struct StalledWriter {
        entered: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    impl Write for StalledWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let _ = self.entered.send(());
            let _ = self.release.recv();
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn insert(manager: &PtyManager, id: &str, writer: Box<dyn Write + Send>) {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let handle = PtyHandle::from_parts(id, pair.master, writer);
        manager.inner.lock().insert(id.to_string(), Arc::new(handle));
    }

    #[test]
    fn a_stalled_write_leaves_other_ptys_usable() {
        let manager = PtyManager::new();
        let (entered, entered_signal) = mpsc::channel();
        let (release_signal, release) = mpsc::channel();
        insert(&manager, "stalled", Box::new(StalledWriter { entered, release }));
        insert(&manager, "live", Box::new(std::io::sink()));
        let stalled = {
            let manager = manager.clone();
            std::thread::spawn(move || manager.write("stalled", b"long injection"))
        };
        entered_signal.recv_timeout(Duration::from_secs(5)).unwrap();
        let (done, outcome) = mpsc::channel();
        {
            let manager = manager.clone();
            std::thread::spawn(move || {
                let _ = done.send((
                    manager.contains("live"),
                    manager.write("live", b"x").is_ok(),
                    manager.resize("live", 100, 30).is_ok(),
                    manager.kill("gone").is_ok(),
                ));
            });
        }
        let result = outcome.recv_timeout(Duration::from_secs(2));
        release_signal.send(()).unwrap();
        stalled.join().unwrap().unwrap();
        assert_eq!(result, Ok((true, true, true, true)));
        assert!(manager.write("missing", b"x").is_err());
    }
}
