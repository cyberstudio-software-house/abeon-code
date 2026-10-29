use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::commands::pty::shell_single_quote;
use crate::error::{AppError, AppResult};

const SUPERVISOR_DIR: &str = "supervisor";
const SESSION_HOOKS_FILE: &str = "session-hooks.json";
const SESSION_HOOKS_TEMP_FILE: &str = "session-hooks.json.tmp";
const SESSION_CHANNEL: &str = "session";
const QUICK_HOOK_TIMEOUT: u64 = 15;
const MENU_HOOK_TIMEOUT: u64 = 600;
const MENU_MATCHER: &str = "AskUserQuestion";
const GUARD_MATCHER: &str = "Bash|mcp__.*";

pub fn supervisor_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Other(format!("app_data_dir: {error}")))?;
    Ok(base.join(SUPERVISOR_DIR))
}

pub fn hook_command(exe: &Path, channel: &str) -> String {
    format!(
        "{} hook {channel}",
        shell_single_quote(&exe.to_string_lossy())
    )
}

fn hook_group(matcher: Option<&str>, command: &str, timeout: u64) -> Value {
    let mut group = json!({
        "hooks": [{ "type": "command", "command": command, "timeout": timeout }]
    });
    if let Some(matcher) = matcher {
        group["matcher"] = json!(matcher);
    }
    group
}

fn session_hooks(exe: &Path) -> Value {
    let command = hook_command(exe, SESSION_CHANNEL);
    json!({
        "hooks": {
            "Stop": [hook_group(None, &command, QUICK_HOOK_TIMEOUT)],
            "UserPromptSubmit": [hook_group(None, &command, QUICK_HOOK_TIMEOUT)],
            "PreToolUse": [
                hook_group(Some(MENU_MATCHER), &command, MENU_HOOK_TIMEOUT),
                hook_group(Some(GUARD_MATCHER), &command, QUICK_HOOK_TIMEOUT),
            ],
        }
    })
}

pub fn write_session_hooks(dir: &Path, exe: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let body = serde_json::to_vec_pretty(&session_hooks(exe)).map_err(std::io::Error::other)?;
    let temp = dir.join(SESSION_HOOKS_TEMP_FILE);
    let path = dir.join(SESSION_HOOKS_FILE);
    std::fs::write(&temp, body)?;
    std::fs::rename(&temp, &path)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn read_hooks(path: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    fn entry<'a>(hooks: &'a Value, event: &str, index: usize) -> &'a Value {
        &hooks["hooks"][event][index]
    }

    #[test]
    fn session_hooks_json_shape() {
        let dir = tempfile::tempdir().unwrap();
        let exe = Path::new("/opt/Abeon Code/it's/abeoncode");
        let path = write_session_hooks(&dir.path().join("supervisor"), exe).unwrap();
        assert_eq!(
            path,
            dir.path().join("supervisor").join("session-hooks.json")
        );
        let hooks = read_hooks(&path);
        let expected_command = r"'/opt/Abeon Code/it'\''s/abeoncode' hook session";

        let events = hooks["hooks"].as_object().unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(hooks["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(
            hooks["hooks"]["UserPromptSubmit"].as_array().unwrap().len(),
            1
        );
        assert_eq!(hooks["hooks"]["PreToolUse"].as_array().unwrap().len(), 2);

        let expected = [
            ("Stop", 0, None, 15),
            ("UserPromptSubmit", 0, None, 15),
            ("PreToolUse", 0, Some("AskUserQuestion"), 600),
            ("PreToolUse", 1, Some("Bash|mcp__.*"), 15),
        ];
        for (event, index, matcher, timeout) in expected {
            let group = entry(&hooks, event, index);
            assert_eq!(
                group["matcher"].as_str(),
                matcher,
                "{event}[{index}] matcher"
            );
            let commands = group["hooks"].as_array().unwrap();
            assert_eq!(commands.len(), 1, "{event}[{index}] hook count");
            assert_eq!(commands[0]["type"], "command");
            assert_eq!(
                commands[0]["command"], expected_command,
                "{event}[{index}] command"
            );
            assert_eq!(commands[0]["timeout"], timeout, "{event}[{index}] timeout");
        }
    }

    #[cfg(unix)]
    #[test]
    fn session_hooks_command_survives_the_shell() {
        let dir = tempfile::tempdir().unwrap();
        let exe = Path::new("/opt/Abeon Code/it's $(id)/abeoncode");
        let path = write_session_hooks(dir.path(), exe).unwrap();
        let hooks = read_hooks(&path);
        let command = entry(&hooks, "Stop", 0)["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string();
        let output = std::process::Command::new("bash")
            .arg("-c")
            .arg(format!("printf '%s\\n' {command}"))
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            "/opt/Abeon Code/it's $(id)/abeoncode\nhook\nsession\n"
        );
    }

    #[test]
    fn session_hooks_are_rewritten_on_every_start() {
        let dir = tempfile::tempdir().unwrap();
        write_session_hooks(dir.path(), Path::new("/old/abeoncode")).unwrap();
        let path = write_session_hooks(dir.path(), Path::new("/new/abeoncode")).unwrap();
        let hooks = read_hooks(&path);
        assert_eq!(
            entry(&hooks, "Stop", 0)["hooks"][0]["command"],
            "'/new/abeoncode' hook session"
        );
    }
}
