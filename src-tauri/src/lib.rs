pub mod error;
pub mod db;
pub mod domain;
pub mod sessions;
pub mod pty;
pub mod state;
pub mod commands;

use state::AppState;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db_path = db::db_path().expect("db path");
    let pool = db::init_pool(&db_path).expect("init pool");
    let app_state = AppState::new(pool);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::projects::list_projects,
            commands::projects::add_project,
            commands::projects::update_project,
            commands::projects::remove_project,
            commands::projects::reorder_projects,
            commands::sessions::list_sessions,
            commands::sessions::read_session_history,
            commands::sessions::open_session_watch,
            commands::sessions::close_session_watch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
