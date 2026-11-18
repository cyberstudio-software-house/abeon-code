use std::collections::HashMap;
use std::sync::{Arc, Mutex, atomic::{AtomicU32, Ordering}};
use std::io::{Read, Write};
use std::thread;
use portable_pty::{Child, MasterPty, PtySize, CommandBuilder, native_pty_system};
use crate::error::{AppError, AppResult};
use super::output_gate::{OutputGate, PtyEvent};

pub struct PtyHandle {
    pub id: String,
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pid: AtomicU32,
    gate: Arc<OutputGate>,
}

impl PtyHandle {
    pub fn spawn(
        gate: Arc<OutputGate>,
        id: String,
        program: &str,
        args: &[&str],
        cwd: &std::path::Path,
        cols: u16,
        rows: u16,
        env: &HashMap<String, String>,
        on_exit: Option<std::sync::Arc<dyn Fn(String) + Send + Sync>>,
    ) -> AppResult<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| AppError::Pty(e.to_string()))?;

        let mut cmd = CommandBuilder::new(program);
        for a in args { cmd.arg(a); }
        cmd.cwd(cwd);
        for (k, v) in env { cmd.env(k, v); }
        cmd.env("TERM", "xterm-256color");

        let child = pair.slave.spawn_command(cmd).map_err(|e| AppError::Pty(e.to_string()))?;
        drop(pair.slave);

        let raw_pid = child.process_id().unwrap_or(0);

        let writer = pair.master.take_writer().map_err(|e| AppError::Pty(e.to_string()))?;
        let mut reader = pair.master.try_clone_reader().map_err(|e| AppError::Pty(e.to_string()))?;

        let gate_for_read = gate.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => gate_for_read.send(PtyEvent::Output(buf[..n].to_vec())),
                    Err(_) => break,
                }
            }
        });

        let id_for_exit = id.clone();
        let gate_for_exit = gate.clone();
        let child_mu: Arc<Mutex<Box<dyn Child + Send + Sync>>> = Arc::new(Mutex::new(child));
        thread::spawn(move || {
            let code = child_mu.lock().unwrap().wait()
                .map(|s| s.exit_code() as i32)
                .unwrap_or(-1);
            gate_for_exit.send(PtyEvent::Exit(code));
            if let Some(cb) = &on_exit {
                cb(id_for_exit.clone());
            }
        });

        Ok(PtyHandle {
            id,
            master: Arc::new(Mutex::new(pair.master)),
            writer: Arc::new(Mutex::new(writer)),
            pid: AtomicU32::new(raw_pid),
            gate,
        })
    }

    #[cfg(all(test, unix))]
    pub(crate) fn from_parts(
        id: &str,
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
    ) -> PtyHandle {
        PtyHandle {
            id: id.to_string(),
            master: Arc::new(Mutex::new(master)),
            writer: Arc::new(Mutex::new(writer)),
            pid: AtomicU32::new(0),
            gate: Arc::new(OutputGate::new(super::output_gate::OutputDelivery::Immediate, Box::new(|_| {}))),
        }
    }

    pub fn write(&self, data: &[u8]) -> AppResult<()> {
        self.writer.lock().unwrap().write_all(data).map_err(AppError::Io)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> AppResult<()> {
        self.master.lock().unwrap().resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| AppError::Pty(e.to_string()))
    }

    pub fn kill(&self) -> AppResult<()> {
        kill_pid(self.pid.load(Ordering::Relaxed));
        Ok(())
    }

    pub fn attach(&self) {
        self.gate.attach();
    }
}

impl Drop for PtyHandle {
    fn drop(&mut self) {
        kill_pid(self.pid.load(Ordering::Relaxed));
    }
}

fn kill_pid(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::pty::output_gate::{OutputDelivery, OutputGate, PtyEvent};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[test]
    fn a_pty_spawned_for_attach_delivers_nothing_before_attach_and_everything_after() {
        let events = Arc::new(parking_lot::Mutex::new(Vec::<PtyEvent>::new()));
        let sink = events.clone();
        let gate = Arc::new(OutputGate::new(
            OutputDelivery::OnAttach,
            Box::new(move |event| sink.lock().push(event)),
        ));
        let (exited_tx, exited_rx) = mpsc::channel();
        let handle = PtyHandle::spawn(
            gate,
            "pty-held".to_string(),
            "sh",
            &["-c", "printf hello; sleep 0.2; exit 3"],
            &std::env::temp_dir(),
            80,
            24,
            &HashMap::new(),
            Some(Arc::new(move |_| {
                let _ = exited_tx.send(());
            })),
        )
        .unwrap();

        exited_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(events.lock().is_empty());

        handle.attach();

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot = events.lock().clone();
            let output: Vec<u8> = snapshot
                .iter()
                .filter_map(|event| match event {
                    PtyEvent::Output(bytes) => Some(bytes.clone()),
                    PtyEvent::Exit(_) => None,
                })
                .flatten()
                .collect();
            if snapshot.last() == Some(&PtyEvent::Exit(3)) && output == b"hello" {
                break;
            }
            assert!(Instant::now() < deadline, "events after attach: {snapshot:?}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
