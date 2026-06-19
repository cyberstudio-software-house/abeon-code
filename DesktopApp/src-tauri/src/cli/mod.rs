pub mod open_input;
pub mod installer;

use tauri::{AppHandle, Emitter, Manager};
use crate::state::AppState;

pub fn dispatch_open(app: &AppHandle, path: String) {
    let state = app.state::<AppState>();
    let ready = *state.cli_frontend_ready.lock();
    if ready {
        let _ = app.emit("cli://open-path", path);
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    } else {
        state.pending_open_paths.lock().push(path);
    }
}

pub fn scan_args_into_pending(app: &AppHandle, args: &[String], cwd: Option<&str>) {
    for raw in args.iter().skip(1) {
        if let Some(path) = open_input::parse_open_input(raw, cwd) {
            dispatch_open(app, path);
        }
    }
}
