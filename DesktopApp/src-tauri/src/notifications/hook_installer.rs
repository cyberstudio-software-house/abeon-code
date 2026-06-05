use std::path::Path;
use serde_json::{json, Value};

const SENTINEL: &str = "# abeoncode-attention";

fn hook_command(markers_dir: &Path) -> String {
    let dir = markers_dir.display();
    format!(
        "mkdir -p '{dir}' && f=\"{dir}/$(date +%s%N)-$$\" && cat > \"$f\" && mv \"$f\" \"$f.json\" {SENTINEL}"
    )
}

fn our_entry(markers_dir: &Path) -> Value {
    json!({
        "hooks": [
            { "type": "command", "command": hook_command(markers_dir) }
        ]
    })
}

fn entry_is_ours(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|arr| {
            arr.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains(SENTINEL))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

pub fn merge_install(mut settings: Value, markers_dir: &Path) -> Value {
    if !settings.is_object() {
        settings = json!({});
    }
    let obj = settings.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks_obj = hooks.as_object_mut().unwrap();
    let notif = hooks_obj.entry("Notification").or_insert_with(|| json!([]));
    if !notif.is_array() {
        *notif = json!([]);
    }
    let arr = notif.as_array_mut().unwrap();
    arr.retain(|e| !entry_is_ours(e));
    arr.push(our_entry(markers_dir));
    settings
}

pub fn merge_uninstall(mut settings: Value) -> Value {
    if let Some(arr) = settings
        .get_mut("hooks")
        .and_then(|h| h.get_mut("Notification"))
        .and_then(|n| n.as_array_mut())
    {
        arr.retain(|e| !entry_is_ours(e));
    }
    settings
}

pub fn is_installed(settings: &Value) -> bool {
    settings
        .get("hooks")
        .and_then(|h| h.get("Notification"))
        .and_then(|n| n.as_array())
        .map(|arr| arr.iter().any(entry_is_ours))
        .unwrap_or(false)
}

use crate::error::{AppError, AppResult};

fn settings_path() -> AppResult<std::path::PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| AppError::Other("no home dir".into()))?;
    Ok(home.join(".claude").join("settings.json"))
}

fn read_settings(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

fn write_settings(path: &Path, value: &Value) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| AppError::Other(e.to_string()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(value).map_err(|e| AppError::Other(e.to_string()))?;
    std::fs::write(&tmp, text).map_err(|e| AppError::Other(e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| AppError::Other(e.to_string()))?;
    Ok(())
}

pub fn install(markers_dir: &Path) -> AppResult<()> {
    let path = settings_path()?;
    let merged = merge_install(read_settings(&path), markers_dir);
    write_settings(&path, &merged)
}

pub fn uninstall() -> AppResult<()> {
    let path = settings_path()?;
    let merged = merge_uninstall(read_settings(&path));
    write_settings(&path, &merged)
}

pub fn status() -> bool {
    settings_path().map(|p| is_installed(&read_settings(&p))).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn dir() -> PathBuf {
        PathBuf::from("/home/u/.local/share/abeoncode/notifications")
    }

    #[test]
    fn install_into_empty_settings_creates_structure() {
        let out = merge_install(json!({}), &dir());
        assert!(is_installed(&out));
    }

    #[test]
    fn install_preserves_other_keys_and_hooks() {
        let existing = json!({
            "model": "opus",
            "hooks": {
                "PreToolUse": [{ "hooks": [{ "type": "command", "command": "echo pre" }] }],
                "Notification": [{ "hooks": [{ "type": "command", "command": "echo other" }] }]
            }
        });
        let out = merge_install(existing, &dir());
        assert_eq!(out.get("model").unwrap().as_str(), Some("opus"));
        assert!(out.get("hooks").unwrap().get("PreToolUse").is_some());
        let notif = out["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 2);
        assert!(is_installed(&out));
    }

    #[test]
    fn install_is_idempotent() {
        let once = merge_install(json!({}), &dir());
        let twice = merge_install(once.clone(), &dir());
        let notif = twice["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 1);
    }

    #[test]
    fn uninstall_removes_only_ours() {
        let installed = merge_install(
            json!({ "hooks": { "Notification": [{ "hooks": [{ "type": "command", "command": "echo other" }] }] } }),
            &dir(),
        );
        let out = merge_uninstall(installed);
        let notif = out["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 1);
        assert!(!is_installed(&out));
        assert_eq!(notif[0]["hooks"][0]["command"].as_str(), Some("echo other"));
    }
}
