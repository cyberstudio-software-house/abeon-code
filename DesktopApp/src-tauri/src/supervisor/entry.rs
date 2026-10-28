use std::io::{Read, Write};
use std::time::Duration;

use serde_json::Value;

use crate::supervisor::ipc::{request_blocking, socket_path, HookChannel, IpcRequest, IpcResponse};
use crate::supervisor::mcp;

const HOOK_READ_TIMEOUT: Duration = Duration::from_secs(10);
const MENU_HOOK_READ_TIMEOUT: Duration = Duration::from_secs(590);
const MENU_TOOL_NAME: &str = "AskUserQuestion";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Subcommand {
    Hook(HookChannel),
    Mcp,
}

pub fn detect(args: &[String]) -> Option<Subcommand> {
    match args
        .iter()
        .skip(1)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["hook", "session"] => Some(Subcommand::Hook(HookChannel::Session)),
        ["hook", "supervisor"] => Some(Subcommand::Hook(HookChannel::Supervisor)),
        ["mcp"] => Some(Subcommand::Mcp),
        _ => None,
    }
}

pub fn try_run_subcommand(args: &[String]) -> Option<i32> {
    match detect(args)? {
        Subcommand::Hook(channel) => {
            run_hook(channel);
            Some(0)
        }
        Subcommand::Mcp => {
            mcp::run_stdio();
            Some(0)
        }
    }
}

fn hook_read_timeout(input: &Value) -> Duration {
    if input.get("tool_name").and_then(Value::as_str) == Some(MENU_TOOL_NAME) {
        MENU_HOOK_READ_TIMEOUT
    } else {
        HOOK_READ_TIMEOUT
    }
}

fn run_hook(channel: HookChannel) {
    let mut raw = String::new();
    if std::io::stdin().read_to_string(&mut raw).is_err() {
        return;
    }
    let Ok(input) = serde_json::from_str::<Value>(&raw) else {
        return;
    };
    let timeout = hook_read_timeout(&input);
    let request = IpcRequest::Hook { channel, input };
    if let Some(IpcResponse::Hook { stdout: Some(text) }) =
        request_blocking(&socket_path(), &request, timeout)
    {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|part| part.to_string()).collect()
    }

    #[test]
    fn subcommand_detection() {
        assert_eq!(
            detect(&args(&["x", "hook", "session"])),
            Some(Subcommand::Hook(HookChannel::Session))
        );
        assert_eq!(
            detect(&args(&["x", "hook", "supervisor"])),
            Some(Subcommand::Hook(HookChannel::Supervisor))
        );
        assert_eq!(detect(&args(&["x", "mcp"])), Some(Subcommand::Mcp));
        assert_eq!(detect(&args(&["x", "/some/path"])), None);
        assert_eq!(detect(&args(&["x"])), None);
        assert_eq!(detect(&args(&["x", "hook"])), None);
        assert_eq!(detect(&args(&["x", "hook", "other"])), None);
        assert_eq!(detect(&args(&["x", "hook", "session", "extra"])), None);
        assert!(try_run_subcommand(&args(&["x", "/some/path"])).is_none());
    }

    #[test]
    fn menu_hooks_wait_long_others_short() {
        assert_eq!(
            hook_read_timeout(&json!({ "tool_name": "AskUserQuestion" })),
            Duration::from_secs(590)
        );
        assert_eq!(
            hook_read_timeout(&json!({ "tool_name": "Bash" })),
            Duration::from_secs(10)
        );
        assert_eq!(hook_read_timeout(&json!({})), Duration::from_secs(10));
    }
}
