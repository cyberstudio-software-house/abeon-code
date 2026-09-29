pub mod open_input;
pub mod installer;
pub mod skill;
pub mod request;

use tauri::{AppHandle, Emitter, Manager};
use crate::state::AppState;
use request::OpenRequest;

pub fn dispatch_open(app: &AppHandle, req: OpenRequest) {
    let state = app.state::<AppState>();
    {
        let ready = state.cli_frontend_ready.lock();
        if !*ready {
            state.pending_open_paths.lock().push(req);
            return;
        }
    }
    let background = req.background;
    let _ = app.emit("cli://open-path", req);
    if background {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn scan_args_into_pending(app: &AppHandle, args: &[String], cwd: Option<&str>) {
    for req in request::parse_cli_args(args, cwd) {
        dispatch_open(app, req);
    }
}
