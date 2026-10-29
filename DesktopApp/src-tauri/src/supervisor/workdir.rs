use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::commands::pty::shell_single_quote;
use crate::domain::supervisor::SupervisorLevel;
use crate::error::{AppError, AppResult};
use crate::supervisor::claude_md;

const SUPERVISOR_DIR: &str = "supervisor";
const SESSION_HOOKS_FILE: &str = "session-hooks.json";
const TEMP_SUFFIX: &str = ".tmp";
const SESSION_CHANNEL: &str = "session";
const SUPERVISOR_CHANNEL: &str = "supervisor";
const CLAUDE_MD_FILE: &str = "CLAUDE.md";
const PREFERENCES_FILE: &str = "preferences.md";
pub const MCP_CONFIG_FILE: &str = "mcp.json";
const CLAUDE_SETTINGS_DIR: &str = ".claude";
const CLAUDE_SETTINGS_FILE: &str = "settings.json";
const CLAUDE_PROJECTS_DIR: &str = "projects";
const ENABLED_PLUGINS_KEY: &str = "enabledPlugins";
const DISABLED_USER_FLAGS: [&str; 3] = [
    "remoteControlAtStartup",
    "inputNeededNotifEnabled",
    "agentPushNotifEnabled",
];
const MCP_SERVER_NAME: &str = "abeoncode";
const MCP_SUBCOMMAND: &str = "mcp";
const ALLOWED_TOOLS: [&str; 1] = ["mcp__abeoncode__*"];
const ALLOWED_AFTER_READ: [&str; 4] = [
    "Glob",
    "Grep",
    "Edit(./preferences.md)",
    "Write(./preferences.md)",
];
const DENIED_TOOLS: [&str; 15] = [
    "Bash",
    "WebFetch",
    "WebSearch",
    "NotebookEdit",
    "Task",
    "Agent",
    "Read(~/.ssh/**)",
    "Read(~/.aws/**)",
    "Read(~/.gnupg/**)",
    "Read(~/.kube/**)",
    "Read(~/.docker/**)",
    "Read(~/.netrc)",
    "Read(~/.git-credentials)",
    "Read(~/.config/gh/**)",
    "Read(~/.claude/channels/**)",
];
const PREFERENCES_TEMPLATE: &str = "# Preferencje użytkownika

Trwałe preferencje użytkownika, które przydają się przy kolejnych decyzjach. Jedna preferencja
w punkcie, z projektem, którego dotyczy (albo „wszystkie projekty”). Bez sekretów i bez treści
sesji.
";
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

fn read_rule(root: &Path) -> Option<String> {
    if !root.is_absolute() {
        return None;
    }
    let text = root.to_string_lossy();
    let trimmed = text.trim_end_matches('/');
    Some(format!("Read(/{trimmed}/**)"))
}

fn user_enabled_plugins(user_settings: &Path) -> Vec<String> {
    let Ok(raw) = std::fs::read(user_settings) else {
        return Vec::new();
    };
    let Ok(settings) = serde_json::from_slice::<Value>(&raw) else {
        return Vec::new();
    };
    settings
        .get(ENABLED_PLUGINS_KEY)
        .and_then(Value::as_object)
        .map(|plugins| {
            plugins
                .iter()
                .filter(|(_, enabled)| enabled.as_bool() == Some(true))
                .map(|(key, _)| key.clone())
                .collect()
        })
        .unwrap_or_default()
}

fn supervisor_settings(exe: &Path, read_roots: &[PathBuf], user_plugins: &[String]) -> Value {
    let allow: Vec<String> = ALLOWED_TOOLS
        .iter()
        .map(|rule| rule.to_string())
        .chain(read_roots.iter().filter_map(|root| read_rule(root)))
        .chain(ALLOWED_AFTER_READ.iter().map(|rule| rule.to_string()))
        .collect();
    let command = hook_command(exe, SUPERVISOR_CHANNEL);
    let mut settings = json!({
        "permissions": { "allow": allow, "deny": DENIED_TOOLS },
        "hooks": {
            "SessionStart": [hook_group(None, &command, QUICK_HOOK_TIMEOUT)],
        }
    });
    for flag in DISABLED_USER_FLAGS {
        settings[flag] = json!(false);
    }
    if !user_plugins.is_empty() {
        let disabled: serde_json::Map<String, Value> = user_plugins
            .iter()
            .map(|key| (key.clone(), json!(false)))
            .collect();
        settings[ENABLED_PLUGINS_KEY] = Value::Object(disabled);
    }
    settings
}

fn mcp_config(exe: &Path) -> Value {
    json!({
        "mcpServers": {
            MCP_SERVER_NAME: {
                "command": exe.to_string_lossy(),
                "args": [MCP_SUBCOMMAND],
            }
        }
    })
}

fn write_atomic(path: &Path, body: &[u8]) -> std::io::Result<()> {
    let mut temp = path.as_os_str().to_owned();
    temp.push(TEMP_SUFFIX);
    std::fs::write(&temp, body)?;
    std::fs::rename(&temp, path)
}

fn write_json(path: &Path, value: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
    write_atomic(path, &body)
}

fn create_if_missing(path: &Path, body: &str) -> std::io::Result<()> {
    use std::io::Write;
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => file.write_all(body.as_bytes()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

pub fn write_supervisor_workdir(
    dir: &Path,
    exe: &Path,
    level: SupervisorLevel,
    read_roots: &[PathBuf],
    claude_home: &Path,
) -> std::io::Result<()> {
    let settings_dir = dir.join(CLAUDE_SETTINGS_DIR);
    std::fs::create_dir_all(&settings_dir)?;
    let claude_md = claude_md::render(level, &claude_home.join(CLAUDE_PROJECTS_DIR));
    write_atomic(&dir.join(CLAUDE_MD_FILE), claude_md.as_bytes())?;
    create_if_missing(&dir.join(PREFERENCES_FILE), PREFERENCES_TEMPLATE)?;
    write_json(&dir.join(MCP_CONFIG_FILE), &mcp_config(exe))?;
    let user_plugins = user_enabled_plugins(&claude_home.join(CLAUDE_SETTINGS_FILE));
    write_json(
        &settings_dir.join(CLAUDE_SETTINGS_FILE),
        &supervisor_settings(exe, read_roots, &user_plugins),
    )
}

pub fn write_session_hooks(dir: &Path, exe: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(SESSION_HOOKS_FILE);
    write_json(&path, &session_hooks(exe))?;
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

    const EXE: &str = "/opt/Abeon Code/it's/abeoncode";

    fn read_json(path: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    fn strings(value: &Value) -> Vec<&str> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap())
            .collect()
    }

    const MISSING_CLAUDE_HOME: &str = "/nonexistent/abeoncode-test/.claude";

    fn write_workdir_with(dir: &Path, level: SupervisorLevel, claude_home: &Path) {
        let roots = [
            PathBuf::from("/home/u/projects/app"),
            PathBuf::from("/home/u/.claude/projects"),
        ];
        write_supervisor_workdir(dir, Path::new(EXE), level, &roots, claude_home).unwrap();
    }

    fn write_workdir(dir: &Path, level: SupervisorLevel) {
        write_workdir_with(dir, level, Path::new(MISSING_CLAUDE_HOME));
    }

    fn workdir_settings(dir: &Path) -> Value {
        read_json(&dir.join(".claude").join("settings.json"))
    }

    #[test]
    fn supervisor_settings_has_no_ask_and_denies_bash() {
        let dir = tempfile::tempdir().unwrap();
        write_workdir(dir.path(), SupervisorLevel::Assistant);
        let settings = workdir_settings(dir.path());
        let permissions = settings["permissions"].as_object().unwrap();
        assert!(!permissions.contains_key("ask"));
        assert_eq!(permissions.len(), 2);
        assert_eq!(
            strings(&settings["permissions"]["allow"]),
            vec![
                "mcp__abeoncode__*",
                "Read(//home/u/projects/app/**)",
                "Read(//home/u/.claude/projects/**)",
                "Glob",
                "Grep",
                "Edit(./preferences.md)",
                "Write(./preferences.md)",
            ]
        );
        assert_eq!(
            strings(&settings["permissions"]["deny"]),
            vec![
                "Bash",
                "WebFetch",
                "WebSearch",
                "NotebookEdit",
                "Task",
                "Agent",
                "Read(~/.ssh/**)",
                "Read(~/.aws/**)",
                "Read(~/.gnupg/**)",
                "Read(~/.kube/**)",
                "Read(~/.docker/**)",
                "Read(~/.netrc)",
                "Read(~/.git-credentials)",
                "Read(~/.config/gh/**)",
                "Read(~/.claude/channels/**)",
            ]
        );
        let hooks = settings["hooks"].as_object().unwrap();
        assert_eq!(hooks.len(), 1);
        let groups = settings["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(groups.len(), 1);
        assert!(groups[0].get("matcher").is_none());
        let commands = groups[0]["hooks"].as_array().unwrap();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0]["type"], "command");
        assert_eq!(
            commands[0]["command"],
            r"'/opt/Abeon Code/it'\''s/abeoncode' hook supervisor"
        );
        assert_eq!(commands[0]["timeout"], 15);
        assert!(!serde_json::to_string(&settings)
            .unwrap()
            .contains("\"ask\""));
    }

    #[test]
    fn preferences_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        write_workdir(dir.path(), SupervisorLevel::Assistant);
        let preferences = dir.path().join("preferences.md");
        assert!(std::fs::read_to_string(&preferences)
            .unwrap()
            .starts_with("# Preferencje użytkownika"));
        std::fs::write(&preferences, "- AbeonCode: zawsze wariant B\n").unwrap();
        write_workdir(dir.path(), SupervisorLevel::Relay);
        assert_eq!(
            std::fs::read_to_string(&preferences).unwrap(),
            "- AbeonCode: zawsze wariant B\n"
        );
    }

    #[test]
    fn claude_md_follows_the_level() {
        let dir = tempfile::tempdir().unwrap();
        let claude_md = dir.path().join("CLAUDE.md");
        std::fs::write(&claude_md, "stara treść").unwrap();
        write_workdir(dir.path(), SupervisorLevel::Assistant);
        let projects = Path::new(MISSING_CLAUDE_HOME).join("projects");
        assert_eq!(
            std::fs::read_to_string(&claude_md).unwrap(),
            crate::supervisor::claude_md::render(SupervisorLevel::Assistant, &projects)
        );
        write_workdir(dir.path(), SupervisorLevel::Autonomous);
        assert_eq!(
            std::fs::read_to_string(&claude_md).unwrap(),
            crate::supervisor::claude_md::render(SupervisorLevel::Autonomous, &projects)
        );
    }

    const DISABLED_FLAGS: [&str; 3] = [
        "remoteControlAtStartup",
        "inputNeededNotifEnabled",
        "agentPushNotifEnabled",
    ];

    #[test]
    fn user_plugins_and_phone_notifications_are_switched_off() {
        let dir = tempfile::tempdir().unwrap();
        let claude_home = dir.path().join(".claude");
        std::fs::create_dir_all(&claude_home).unwrap();
        std::fs::write(
            claude_home.join("settings.json"),
            serde_json::to_vec(&serde_json::json!({
                "enabledPlugins": {
                    "superpowers@claude-plugins-official": true,
                    "discord@claude-plugins-official": true,
                    "explanatory-output-style@claude-plugins-official": true,
                    "already-off@claude-plugins-official": false,
                    "odd@claude-plugins-official": "yes"
                },
                "remoteControlAtStartup": true
            }))
            .unwrap(),
        )
        .unwrap();
        let workdir = dir.path().join("supervisor");
        write_workdir_with(&workdir, SupervisorLevel::Assistant, &claude_home);
        let settings = workdir_settings(&workdir);
        assert_eq!(
            settings["enabledPlugins"],
            serde_json::json!({
                "superpowers@claude-plugins-official": false,
                "discord@claude-plugins-official": false,
                "explanatory-output-style@claude-plugins-official": false
            })
        );
        for flag in DISABLED_FLAGS {
            assert_eq!(settings[flag], false, "{flag}");
        }
    }

    #[test]
    fn missing_or_invalid_user_settings_add_no_plugin_overrides() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        write_workdir(&missing, SupervisorLevel::Assistant);
        let settings = workdir_settings(&missing);
        assert!(settings.get("enabledPlugins").is_none());
        for flag in DISABLED_FLAGS {
            assert_eq!(settings[flag], false, "{flag}");
        }

        for (name, body) in [
            ("invalid", "{ not json"),
            ("not-an-object", r#"{"enabledPlugins": ["superpowers"]}"#),
            (
                "none-enabled",
                r#"{"enabledPlugins": {"superpowers": false}}"#,
            ),
        ] {
            let claude_home = dir.path().join(name).join(".claude");
            std::fs::create_dir_all(&claude_home).unwrap();
            std::fs::write(claude_home.join("settings.json"), body).unwrap();
            let workdir = dir.path().join(name).join("supervisor");
            write_workdir_with(&workdir, SupervisorLevel::Assistant, &claude_home);
            assert!(
                workdir_settings(&workdir).get("enabledPlugins").is_none(),
                "{name}"
            );
        }
    }

    #[test]
    fn mcp_json_points_to_exe() {
        let dir = tempfile::tempdir().unwrap();
        write_workdir(dir.path(), SupervisorLevel::Assistant);
        let mcp = read_json(&dir.path().join("mcp.json"));
        assert_eq!(
            mcp,
            serde_json::json!({
                "mcpServers": { "abeoncode": { "command": EXE, "args": ["mcp"] } }
            })
        );
    }

    #[test]
    fn supervisor_workdir_holds_exactly_the_generated_files() {
        let dir = tempfile::tempdir().unwrap();
        let workdir = dir.path().join("supervisor");
        write_workdir(&workdir, SupervisorLevel::Assistant);
        let mut entries: Vec<String> = std::fs::read_dir(&workdir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        entries.sort();
        assert_eq!(
            entries,
            vec![".claude", "CLAUDE.md", "mcp.json", "preferences.md"]
        );
        let claude_dir: Vec<String> = std::fs::read_dir(workdir.join(".claude"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(claude_dir, vec!["settings.json"]);
    }

    #[test]
    fn read_rules_use_absolute_anchors() {
        assert_eq!(
            read_rule(Path::new("/home/u/my app/")),
            Some("Read(//home/u/my app/**)".to_string())
        );
        assert_eq!(read_rule(Path::new("relative/dir")), None);
        assert_eq!(read_rule(Path::new("")), None);
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
