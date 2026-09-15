use crate::error::{AppError, AppResult};
use crate::sessions::opencode::reader;
use serde_json::Value;
use std::time::Duration;

#[derive(Debug, PartialEq)]
pub struct RunOutput {
    pub session_id: Option<String>,
    pub text: Option<String>,
}

pub fn parse_run_output(output: &str) -> AppResult<RunOutput> {
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
    Ok(RunOutput { session_id, text })
}

pub async fn run_prompt(model: Option<&str>, prompt: &str) -> AppResult<String> {
    let mut command = tokio::process::Command::new("opencode");
    command.arg("run").arg("--format").arg("json");
    if let Some(model) = model.filter(|value| !value.is_empty()) {
        command.arg("--model").arg(model);
    }
    command.arg(prompt);
    command.current_dir(std::env::temp_dir());
    command.kill_on_drop(true);

    let output = tokio::time::timeout(Duration::from_secs(90), command.output())
        .await
        .map_err(|_| AppError::Other("Generowanie tytułu przekroczyło limit 90s".into()))?
        .map_err(|error| AppError::Other(format!("opencode run: {error}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Other(format!(
            "opencode run failed: {}",
            stderr.trim()
        )));
    }

    let parsed = parse_run_output(&String::from_utf8_lossy(&output.stdout))?;
    let mut text = parsed.text;
    if text.is_none() {
        if let (Some(path), Some(session_id)) =
            (reader::database_path(), parsed.session_id.as_deref())
        {
            text = reader::last_assistant_text(&path, session_id)?;
        }
    }
    if let Some(session_id) = parsed.session_id {
        cleanup_session(&session_id).await;
    }
    text.ok_or_else(|| AppError::Other("OpenCode nie zwrócił odpowiedzi".into()))
}

async fn cleanup_session(session_id: &str) {
    let mut command = tokio::process::Command::new("opencode");
    command.arg("session").arg("delete").arg(session_id);
    command.current_dir(std::env::temp_dir());
    command.kill_on_drop(true);
    let _ = tokio::time::timeout(Duration::from_secs(15), command.output()).await;
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
            parse_run_output(output).unwrap(),
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
            parse_run_output(output).unwrap(),
            RunOutput {
                session_id: Some("ses_456".into()),
                text: None,
            }
        );
    }
}
