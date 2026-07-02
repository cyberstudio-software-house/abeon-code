use tauri::AppHandle;

pub fn show_attention_notification(app: &AppHandle, session_id: String, title: String, body: String) {
    #[cfg(all(unix, not(target_os = "macos")))]
    show_with_action(app.clone(), session_id, title, body);

    #[cfg(not(all(unix, not(target_os = "macos"))))]
    show_plain(app, session_id, title, body);
}

#[cfg(all(unix, not(target_os = "macos")))]
fn show_with_action(app: AppHandle, session_id: String, title: String, body: String) {
    std::thread::spawn(move || {
        let result = notify_rust::Notification::new()
            .summary(&title)
            .body(&body)
            .appname("AbeonCode")
            .auto_icon()
            .action("default", "Otwórz")
            .show();
        match result {
            Ok(handle) => handle.wait_for_action(|action| {
                if action != "__closed" {
                    activate_main_window(&app, &session_id);
                }
            }),
            Err(e) => eprintln!("[notifications] failed to show notification: {e}"),
        }
    });
}

#[cfg(all(unix, not(target_os = "macos")))]
fn activate_main_window(app: &AppHandle, session_id: &str) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Critical));
    }
    super::emit_activate(app, session_id.to_string());
}

#[cfg(not(all(unix, not(target_os = "macos"))))]
fn show_plain(app: &AppHandle, _session_id: String, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}
