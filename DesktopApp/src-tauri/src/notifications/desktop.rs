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
fn raise_main_window(app: &AppHandle) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Critical));
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn activate_main_window(app: &AppHandle, session_id: &str) {
    raise_main_window(app);
    super::emit_activate(app, session_id.to_string());
}

pub fn show_link_notification(app: &AppHandle, title: String, body: String, url: Option<String>) {
    let url = url.filter(|url| is_web_url(url));

    #[cfg(all(unix, not(target_os = "macos")))]
    show_link_with_action(app.clone(), title, body, url);

    #[cfg(not(all(unix, not(target_os = "macos"))))]
    {
        let _ = url;
        show_plain_text(app, title, body);
    }
}

fn is_web_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

#[cfg(all(unix, not(target_os = "macos")))]
fn show_link_with_action(app: AppHandle, title: String, body: String, url: Option<String>) {
    std::thread::spawn(move || {
        let action = if url.is_some() { "Otwórz pipeline" } else { "Otwórz" };
        let result = notify_rust::Notification::new()
            .summary(&title)
            .body(&body)
            .appname("AbeonCode")
            .auto_icon()
            .action("default", action)
            .show();
        match result {
            Ok(handle) => handle.wait_for_action(|clicked| {
                if clicked != "__closed" {
                    open_link_or_raise(&app, url.as_deref());
                }
            }),
            Err(e) => eprintln!("[notifications] failed to show notification: {e}"),
        }
    });
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_link_or_raise(app: &AppHandle, url: Option<&str>) {
    use tauri_plugin_opener::OpenerExt;
    match url {
        Some(url) => {
            if let Err(e) = app.opener().open_url(url, None::<&str>) {
                eprintln!("[notifications] failed to open {url}: {e}");
                raise_main_window(app);
            }
        }
        None => raise_main_window(app),
    }
}

#[cfg(not(all(unix, not(target_os = "macos"))))]
fn show_plain_text(app: &AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

#[cfg(not(all(unix, not(target_os = "macos"))))]
fn show_plain(app: &AppHandle, _session_id: String, title: String, body: String) {
    show_plain_text(app, title, body);
}

#[cfg(test)]
mod tests {
    use super::is_web_url;

    #[test]
    fn only_http_and_https_addresses_are_opened() {
        assert!(is_web_url("https://bitbucket.org/a/b/pipelines/results/1"));
        assert!(is_web_url("http://ci.example.test/1"));
        assert!(!is_web_url("file:///etc/passwd"));
        assert!(!is_web_url("javascript:alert(1)"));
        assert!(!is_web_url("ftp://example.test/x"));
        assert!(!is_web_url(""));
    }
}
