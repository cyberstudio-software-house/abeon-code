pub mod handle;

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
}

impl PtyManager {
    pub fn new() -> Arc<Self> { Arc::new(Self::default()) }

    pub fn spawn(
        &self,
        app: AppHandle,
        program: &str,
        args: &[&str],
        cwd: &std::path::Path,
        cols: u16,
        rows: u16,
    ) -> AppResult<String> {
        let id = Uuid::new_v4().to_string();
        let h = PtyHandle::spawn(app, id.clone(), program, args, cwd, cols, rows)?;
        self.inner.lock().insert(id.clone(), Arc::new(h));
        Ok(id)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> AppResult<()> {
        let g = self.inner.lock();
        let h = g.get(id).ok_or_else(|| AppError::NotFound(format!("pty {id}")))?;
        h.write(data)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> AppResult<()> {
        let g = self.inner.lock();
        let h = g.get(id).ok_or_else(|| AppError::NotFound(format!("pty {id}")))?;
        h.resize(cols, rows)
    }

    pub fn kill(&self, id: &str) -> AppResult<()> {
        let mut g = self.inner.lock();
        if let Some(h) = g.remove(id) { let _ = h.kill(); }
        Ok(())
    }
}
