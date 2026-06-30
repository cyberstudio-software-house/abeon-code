pub mod error;
pub mod db;
pub mod domain;
pub mod sessions;
pub mod notifications;
pub mod pty;
pub mod state;
pub mod commands;
pub mod cli;
pub mod clickup;
pub mod detectors;
pub mod git;
pub mod remote;
pub mod validation;

use state::AppState;
use tauri::Manager;

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
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            crate::cli::scan_args_into_pending(app, &argv, Some(&cwd));
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(app_state)
        .setup(|app| {
            crate::remote::startup::init_remote_bridge(app.handle().clone());
            if let Ok(dir) = crate::commands::notifications::markers_dir(app.handle()) {
                let watcher = crate::notifications::marker::AttentionWatcher::new(dir);
                watcher.start(app.handle().clone());
                app.manage(watcher);
            }
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        if let Some(path) = crate::cli::open_input::parse_open_input(url.as_str(), None) {
                            crate::cli::dispatch_open(&handle, path);
                        }
                    }
                });
            }
            let cwd = std::env::current_dir().ok().map(|p| p.to_string_lossy().to_string());
            let args: Vec<String> = std::env::args().collect();
            crate::cli::scan_args_into_pending(app.handle(), &args, cwd.as_deref());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::projects::list_projects,
            commands::projects::add_project,
            commands::projects::update_project,
            commands::projects::remove_project,
            commands::projects::reorder_projects,
            commands::projects::find_or_create_project,
            commands::cli::take_pending_open_paths,
            commands::cli::install_cli_command,
            commands::sessions::list_sessions,
            commands::sessions::read_session_history,
            commands::sessions::open_session_watch,
            commands::sessions::close_session_watch,
            commands::pty::spawn_pty,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_kill,
            commands::pty::save_clipboard_image,
            commands::pty::read_clipboard_image,
            commands::pty::read_clipboard_text,
            commands::pty::write_clipboard_text,
            commands::actions::list_actions,
            commands::actions::detect_scripts,
            commands::actions::add_action,
            commands::actions::update_action,
            commands::actions::remove_action,
            commands::git::git_status,
            commands::git::git_diff_file,
            commands::settings::get_git_user,
            commands::settings::get_setting,
            commands::settings::get_all_settings,
            commands::settings::set_setting,
            commands::settings::delete_setting,
            commands::settings::detect_default_shell,
            commands::settings::list_available_shells,
            commands::activity::get_projects_activity,
            commands::sessions::count_sessions,
            commands::sessions::export_session,
            commands::sessions::rename_session,
            commands::sessions::generate_session_title,
            commands::usage::session_usage,
            commands::usage::project_usage,
            commands::models::detect_models,
            commands::providers::detect_providers,
            commands::providers::detect_codex_models,
            commands::settings::open_in_editor,
            commands::settings::list_available_editors,
            commands::settings::open_project_in_editor,
            commands::remote::remote_pair_start,
            commands::clickup::clickup_set_token,
            commands::clickup::clickup_clear_token,
            commands::clickup::clickup_connection_status,
            commands::clickup::clickup_list_workspaces,
            commands::clickup::clickup_list_spaces,
            commands::clickup::clickup_list_lists,
            commands::clickup::clickup_get_config,
            commands::clickup::clickup_set_config,
            commands::clickup::clickup_list_links,
            commands::clickup::clickup_unlink_task,
            commands::clickup::clickup_get_task,
            commands::clickup::clickup_search_tasks,
            commands::clickup::clickup_link_task,
            commands::clickup::clickup_write_task_file,
            commands::clickup::clickup_generate_summary,
            commands::clickup::clickup_post_comment,
            commands::notifications::install_attention_hook,
            commands::notifications::uninstall_attention_hook,
            commands::notifications::attention_hook_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
