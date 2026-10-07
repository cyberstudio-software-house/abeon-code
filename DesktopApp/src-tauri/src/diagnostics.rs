use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const APP_DIR: &str = "pl.cyberstudio.abeoncode";
const LOG_FILE: &str = "abeoncode.log";

pub fn init() {
    #[cfg(unix)]
    keep_discarded_output();
    install_panic_hook();
    log_event(&format!("start version={}", env!("CARGO_PKG_VERSION")));
}

pub fn log_path() -> Option<PathBuf> {
    Some(dirs::data_local_dir()?.join(APP_DIR).join("logs").join(LOG_FILE))
}

fn rotated_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".1");
    PathBuf::from(name)
}

pub fn rotate_if_large(path: &Path, max_bytes: u64) -> io::Result<bool> {
    let size = match fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if size <= max_bytes {
        return Ok(false);
    }
    fs::copy(path, rotated_path(path))?;
    OpenOptions::new().write(true).open(path)?.set_len(0)?;
    Ok(true)
}

pub fn format_event(timestamp: &str, pid: u32, message: &str) -> String {
    format!("[{timestamp}] abeoncode[{pid}] {message}")
}

pub fn log_event(message: &str) {
    let timestamp = chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false);
    let _ = writeln!(io::stderr(), "{}", format_event(&timestamp, std::process::id(), message));
}

pub fn describe_run_event(event: &tauri::RunEvent) -> Option<String> {
    match event {
        tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { .. }, .. } => {
            Some(format!("window close requested label={label}"))
        }
        tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } => {
            Some(format!("window destroyed label={label}"))
        }
        tauri::RunEvent::ExitRequested { code: Some(code), .. } => Some(format!("exit requested code={code}")),
        tauri::RunEvent::ExitRequested { code: None, .. } => Some("exit requested after the last window closed".to_string()),
        tauri::RunEvent::Exit => Some("exit".to_string()),
        _ => None,
    }
}

pub fn log_run_event(event: &tauri::RunEvent) {
    if let Some(description) = describe_run_event(event) {
        log_event(&description);
    }
}

pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log_event(&format!("panic: {info}"));
        previous(info);
    }));
}

#[cfg(unix)]
fn keep_discarded_output() {
    const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
    const ROTATION_CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

    if !fd_is_discarded(libc::STDERR_FILENO) {
        return;
    }
    let Some(path) = log_path() else { return };
    let Some(directory) = path.parent() else { return };
    if fs::create_dir_all(directory).is_err() {
        return;
    }
    let _ = rotate_if_large(&path, MAX_LOG_BYTES);
    if redirect_fd(libc::STDERR_FILENO, &path).is_err() {
        return;
    }
    if fd_is_discarded(libc::STDOUT_FILENO) {
        let _ = redirect_fd(libc::STDOUT_FILENO, &path);
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(ROTATION_CHECK_INTERVAL);
        let _ = rotate_if_large(&path, MAX_LOG_BYTES);
    });
}

#[cfg(unix)]
pub fn fd_is_discarded(fd: std::os::fd::RawFd) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(null_device) = fs::metadata("/dev/null") else { return false };
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
        return true;
    }
    let stat = unsafe { stat.assume_init() };
    stat.st_mode & libc::S_IFMT == libc::S_IFCHR && stat.st_rdev as u64 == null_device.rdev()
}

#[cfg(unix)]
pub fn redirect_fd(fd: std::os::fd::RawFd, path: &Path) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let file = OpenOptions::new().create(true).append(true).open(path)?;
    if unsafe { libc::dup2(file.as_raw_fd(), fd) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(unix)]
pub fn watch_termination_signals() {
    use tokio::signal::unix::{signal, SignalKind};
    let streams = tauri::async_runtime::block_on(async {
        Ok::<_, io::Error>((
            signal(SignalKind::terminate())?,
            signal(SignalKind::hangup())?,
            signal(SignalKind::interrupt())?,
        ))
    });
    let Ok((mut terminate, mut hangup, mut interrupt)) = streams else { return };
    tauri::async_runtime::spawn(async move {
        let (name, number) = tokio::select! {
            _ = terminate.recv() => ("SIGTERM", libc::SIGTERM),
            _ = hangup.recv() => ("SIGHUP", libc::SIGHUP),
            _ = interrupt.recv() => ("SIGINT", libc::SIGINT),
        };
        log_event(&format!("terminated by {name}"));
        unsafe {
            libc::signal(number, libc::SIG_DFL);
            libc::raise(number);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File, OpenOptions};
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn log_lives_in_the_app_data_directory() {
        let path = log_path().expect("data dir");
        assert!(path.ends_with("pl.cyberstudio.abeoncode/logs/abeoncode.log"));
    }

    #[test]
    fn event_line_carries_timestamp_process_and_message() {
        assert_eq!(
            format_event("2026-10-07T14:28:39.600+02:00", 42, "exit"),
            "[2026-10-07T14:28:39.600+02:00] abeoncode[42] exit",
        );
    }

    #[test]
    fn small_log_is_left_alone() {
        let dir = tempdir().unwrap();
        let log = dir.path().join("app.log");
        fs::write(&log, "short").unwrap();

        assert!(!rotate_if_large(&log, 10).unwrap());
        assert_eq!(fs::read_to_string(&log).unwrap(), "short");
        assert!(!dir.path().join("app.log.1").exists());
    }

    #[test]
    fn missing_log_is_not_an_error() {
        let dir = tempdir().unwrap();
        assert!(!rotate_if_large(&dir.path().join("app.log"), 10).unwrap());
    }

    #[test]
    fn large_log_moves_aside_and_keeps_accepting_appends() {
        let dir = tempdir().unwrap();
        let log = dir.path().join("app.log");
        let mut appender = OpenOptions::new().create(true).append(true).open(&log).unwrap();
        appender.write_all(b"old content beyond the limit\n").unwrap();

        assert!(rotate_if_large(&log, 10).unwrap());
        appender.write_all(b"new\n").unwrap();

        assert_eq!(fs::read_to_string(dir.path().join("app.log.1")).unwrap(), "old content beyond the limit\n");
        assert_eq!(fs::read_to_string(&log).unwrap(), "new\n");
    }

    #[test]
    fn exit_is_described_and_idle_events_are_skipped() {
        assert_eq!(describe_run_event(&tauri::RunEvent::Exit).as_deref(), Some("exit"));
        assert_eq!(describe_run_event(&tauri::RunEvent::Ready), None);
    }

    #[cfg(unix)]
    mod unix {
        use super::*;
        use std::io::{BufRead, BufReader, Read};
        use std::os::fd::AsRawFd;
        use std::os::unix::process::ExitStatusExt;
        use std::process::{Child, Command, Stdio};
        use std::time::Duration;

        const PROBE_ENV: &str = "ABEON_DIAGNOSTICS_PROBE";
        const PROBE_READY: &str = "diagnostics-probe-ready";

        fn is_probe() -> bool {
            std::env::var_os(PROBE_ENV).is_some()
        }

        fn probe_command(test: &str) -> Command {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args(["--exact", test, "--nocapture", "--test-threads=1"])
                .env(PROBE_ENV, "1")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            command
        }

        fn spawn_probe(test: &str) -> Child {
            probe_command(test).spawn().unwrap()
        }

        fn stderr_of(child: &mut Child) -> String {
            let mut text = String::new();
            child.stderr.take().unwrap().read_to_string(&mut text).unwrap();
            text
        }

        #[test]
        fn null_device_counts_as_discarded_and_a_file_does_not() {
            let dir = tempdir().unwrap();
            let null = File::open("/dev/null").unwrap();
            let file = File::create(dir.path().join("kept")).unwrap();

            assert!(fd_is_discarded(null.as_raw_fd()));
            assert!(!fd_is_discarded(file.as_raw_fd()));
        }

        #[test]
        fn redirected_descriptor_appends_to_the_log() {
            let dir = tempdir().unwrap();
            let log = dir.path().join("app.log");
            fs::write(&log, "earlier\n").unwrap();
            let mut sink = File::create(dir.path().join("sink")).unwrap();

            redirect_fd(sink.as_raw_fd(), &log).unwrap();
            sink.write_all(b"later\n").unwrap();

            assert_eq!(fs::read_to_string(&log).unwrap(), "earlier\nlater\n");
            assert_eq!(fs::read_to_string(dir.path().join("sink")).unwrap(), "");
        }

        #[test]
        fn termination_signal_is_logged_before_the_process_dies_by_it() {
            if is_probe() {
                watch_termination_signals();
                println!("{PROBE_READY}");
                std::thread::sleep(Duration::from_secs(30));
                return;
            }
            let mut child = spawn_probe("diagnostics::tests::unix::termination_signal_is_logged_before_the_process_dies_by_it");
            let ready = BufReader::new(child.stdout.take().unwrap())
                .lines()
                .map_while(Result::ok)
                .any(|line| line.contains(PROBE_READY));
            assert!(ready, "probe never reached the watcher: {}", stderr_of(&mut child));

            unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
            let status = child.wait().unwrap();
            let stderr = stderr_of(&mut child);

            assert_eq!(status.signal(), Some(libc::SIGTERM), "stderr: {stderr}");
            assert!(stderr.contains("terminated by SIGTERM"), "stderr: {stderr}");
        }

        #[test]
        fn discarded_output_of_a_starting_app_lands_in_the_log_file() {
            if is_probe() {
                init();
                log_event("probe event");
                return;
            }
            let data_home = tempdir().unwrap();
            let status = probe_command("diagnostics::tests::unix::discarded_output_of_a_starting_app_lands_in_the_log_file")
                .env("XDG_DATA_HOME", data_home.path())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            let log = data_home.path().join("pl.cyberstudio.abeoncode/logs/abeoncode.log");
            let content = fs::read_to_string(&log).unwrap_or_default();

            assert!(status.success());
            assert!(content.contains("start version="), "log: {content}");
            assert!(content.contains("probe event"), "log: {content}");
        }

        #[test]
        fn output_reaching_a_terminal_or_pipe_is_not_redirected() {
            if is_probe() {
                init();
                return;
            }
            let data_home = tempdir().unwrap();
            let output = probe_command("diagnostics::tests::unix::output_reaching_a_terminal_or_pipe_is_not_redirected")
                .env("XDG_DATA_HOME", data_home.path())
                .output()
                .unwrap();

            assert!(String::from_utf8_lossy(&output.stderr).contains("start version="));
            assert!(!data_home.path().join("pl.cyberstudio.abeoncode").exists());
        }

        #[test]
        fn panic_is_logged_as_a_timestamped_event() {
            if is_probe() {
                install_panic_hook();
                panic!("probe failure");
            }
            let mut child = spawn_probe("diagnostics::tests::unix::panic_is_logged_as_a_timestamped_event");
            let stderr = stderr_of(&mut child);
            child.wait().unwrap();

            let event = stderr.lines().find(|line| line.contains("] abeoncode[") && line.contains("panic:"));
            assert!(event.is_some(), "stderr: {stderr}");
            assert!(stderr.contains("probe failure"), "stderr: {stderr}");
        }
    }
}
