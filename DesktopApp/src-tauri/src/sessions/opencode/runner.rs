use crate::error::{AppError, AppResult};
use crate::sessions::opencode::reader;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

#[derive(Debug, PartialEq)]
pub struct RunOutput {
    pub session_id: Option<String>,
    pub text: Option<String>,
}

const MAX_ERROR_CHARS: usize = 500;

pub fn parse_run_output(output: &str) -> RunOutput {
    let mut session_id = None;
    let mut text = None;
    for line in output.lines() {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(id) = event.get("sessionID").and_then(Value::as_str) {
            session_id = Some(id.to_string());
        }
        if event.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(value) = event
                .get("part")
                .and_then(|part| part.get("text"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            {
                text = Some(value.to_string());
            }
        }
    }
    RunOutput { session_id, text }
}

pub async fn run_prompt_with_environment(
    model: Option<&str>,
    prompt: &str,
    binary: &Path,
    environment: Option<&HashMap<String, String>>,
) -> AppResult<String> {
    let mut command = tokio::process::Command::new(binary);
    command.arg("run").arg("--format").arg("json");
    if let Some(model) = model.filter(|value| !value.is_empty()) {
        command.arg("--model").arg(model);
    }
    command.arg(prompt);
    command.current_dir(std::env::temp_dir());
    command.kill_on_drop(true);
    if let Some(environment) = environment {
        command.envs(environment);
    }

    let output = tokio::time::timeout(Duration::from_secs(90), command.output())
        .await
        .map_err(|_| AppError::Other("Generowanie tytułu przekroczyło limit 90s".into()))?
        .map_err(|error| AppError::Other(format!("opencode run: {error}")))?;
    let parsed = parse_run_output(&String::from_utf8_lossy(&output.stdout));
    let session_id = parsed.session_id.clone();
    let result = if output.status.success() {
        resolve_run_text(&parsed)
    } else {
        Err(AppError::Other(opencode_failure_message(&output.stderr)))
    };
    if let Some(session_id) = session_id {
        if let Err(error) = cleanup_session(&session_id, binary, environment).await {
            eprintln!("opencode cleanup failed for {session_id}: {error}");
        }
    }
    result
}

fn resolve_run_text(parsed: &RunOutput) -> AppResult<String> {
    let mut text = parsed.text.clone();
    if text.is_none() {
        if let (Some(path), Some(session_id)) =
            (reader::database_path(), parsed.session_id.as_deref())
        {
            text = reader::last_assistant_text(&path, session_id)?;
        }
    }
    text.ok_or_else(|| AppError::Other("OpenCode nie zwrócił odpowiedzi".into()))
}

async fn cleanup_session(
    session_id: &str,
    binary: &Path,
    environment: Option<&HashMap<String, String>>,
) -> AppResult<()> {
    let mut command = tokio::process::Command::new(binary);
    command.arg("session").arg("delete").arg(session_id);
    command.current_dir(std::env::temp_dir());
    command.kill_on_drop(true);
    if let Some(environment) = environment {
        command.envs(environment);
    }
    let output = tokio::time::timeout(Duration::from_secs(15), command.output())
        .await
        .map_err(|_| AppError::Other("Usuwanie tymczasowej sesji OpenCode przekroczyło limit 15s".into()))?
        .map_err(|error| AppError::Other(format!("opencode session delete: {error}")))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(AppError::Other(opencode_failure_message(&output.stderr)))
    }
}

fn opencode_failure_message(stderr: &[u8]) -> String {
    let value = String::from_utf8_lossy(stderr);
    let trimmed = value.trim();
    let excerpt = trimmed.chars().take(MAX_ERROR_CHARS).collect::<String>();
    if excerpt.is_empty() {
        "Polecenie OpenCode zakończyło się błędem".into()
    } else {
        format!("OpenCode: {excerpt}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_last_text_and_session_from_jsonl() {
        let output = concat!(
            r#"{"type":"step_start","sessionID":"ses_123","part":{"type":"step-start"}}"#,
            "\n",
            "not-json\n",
            r#"{"type":"text","sessionID":"ses_123","part":{"type":"text","text":"First"}}"#,
            "\n",
            r#"{"type":"text","sessionID":"ses_123","part":{"type":"text","text":"Final title"}}"#,
            "\n",
            r#"{"type":"step_finish","sessionID":"ses_123","part":{"type":"step-finish"}}"#,
        );

        assert_eq!(
            parse_run_output(output),
            RunOutput {
                session_id: Some("ses_123".into()),
                text: Some("Final title".into()),
            }
        );
    }

    #[test]
    fn ignores_empty_and_unrelated_events() {
        let output = concat!(
            r#"{"type":"text","sessionID":"ses_456","part":{"type":"text","text":""}}"#,
            "\n",
            r#"{"type":"tool_use","part":{"type":"tool","text":"ignored"}}"#,
        );

        assert_eq!(
            parse_run_output(output),
            RunOutput {
                session_id: Some("ses_456".into()),
                text: None,
            }
        );
    }

    #[test]
    fn bounds_cli_error_output() {
        let message = opencode_failure_message("x".repeat(800).as_bytes());

        assert_eq!(message.chars().count(), "OpenCode: ".chars().count() + MAX_ERROR_CHARS);
        assert!(!message.contains("xxx\n"));
    }
}
