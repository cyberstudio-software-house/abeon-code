use std::sync::{Arc, Mutex};
use std::io::{Read, Write};
use std::thread;
use portable_pty::{Child, MasterPty, PtySize, CommandBuilder, native_pty_system};
use tauri::{AppHandle, Emitter};
use crate::error::{AppError, AppResult};

pub struct PtyHandle {
    pub id: String,
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

impl PtyHandle {
    pub fn spawn(
        app: AppHandle,
        id: String,
        program: &str,
        args: &[&str],
        cwd: &std::path::Path,
        cols: u16,
        rows: u16,
    ) -> AppResult<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| AppError::Pty(e.to_string()))?;

        let mut cmd = CommandBuilder::new(program);
        for a in args { cmd.arg(a); }
        cmd.cwd(cwd);
        for (k, v) in std::env::vars() { cmd.env(k, v); }
        cmd.env("TERM", "xterm-256color");

        let child = pair.slave.spawn_command(cmd).map_err(|e| AppError::Pty(e.to_string()))?;
        drop(pair.slave);

        let writer = pair.master.take_writer().map_err(|e| AppError::Pty(e.to_string()))?;
        let mut reader = pair.master.try_clone_reader().map_err(|e| AppError::Pty(e.to_string()))?;

        let id_for_thread = id.clone();
        let app_for_thread = app.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        use base64::Engine;
                        let encoded = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        let _ = app_for_thread.emit(
                            &format!("pty:{id_for_thread}:output"),
                            serde_json::json!({ "data": encoded }),
                        );
                    }
                    Err(_) => break,
                }
            }
        });

        let id_for_exit = id.clone();
        let app_for_exit = app.clone();
        let child_arc: Arc<Mutex<Box<dyn Child + Send + Sync>>> = Arc::new(Mutex::new(child));
        let child_for_exit = child_arc.clone();
        thread::spawn(move || {
            let code = child_for_exit.lock().unwrap().wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
            let _ = app_for_exit.emit(
                &format!("pty:{id_for_exit}:exit"),
                serde_json::json!({ "code": code }),
            );
        });

        Ok(PtyHandle {
            id,
            master: Arc::new(Mutex::new(pair.master)),
            child: child_arc,
            writer: Arc::new(Mutex::new(writer)),
        })
    }

    pub fn write(&self, data: &[u8]) -> AppResult<()> {
        self.writer.lock().unwrap().write_all(data).map_err(AppError::Io)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> AppResult<()> {
        self.master.lock().unwrap().resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| AppError::Pty(e.to_string()))
    }

    pub fn kill(&self) -> AppResult<()> {
        let _ = self.child.lock().unwrap().kill();
        Ok(())
    }
}

impl Drop for PtyHandle {
    fn drop(&mut self) {
        let _ = self.child.lock().unwrap().kill();
    }
}
