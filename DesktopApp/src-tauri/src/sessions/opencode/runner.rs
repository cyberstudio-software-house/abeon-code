use crate::error::{AppError, AppResult};
use crate::sessions::opencode::reader;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;

#[derive(Debug, PartialEq)]
pub struct RunOutput {
    pub session_id: Option<String>,
    pub text: Option<String>,
}

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
    run_prompt_with_timeout(
        model,
        prompt,
        binary,
        environment,
        Duration::from_secs(90),
    )
    .await
}

async fn run_prompt_with_timeout(
    model: Option<&str>,
    prompt: &str,
    binary: &Path,
    environment: Option<&HashMap<String, String>>,
    timeout: Duration,
) -> AppResult<String> {
    let mut command = tokio::process::Command::new(binary);
    command.arg("run").arg("--format").arg("json");
    if let Some(model) = model.filter(|value| !value.is_empty()) {
        command.arg("--model").arg(model);
    }
    command.arg(prompt);
    command.current_dir(std::env::temp_dir());
    command.kill_on_drop(true);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(environment) = environment {
        command.envs(environment);
    }

    let mut child = command
        .spawn()
        .map_err(|error| AppError::Other(format!("opencode run: {error}")))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Other("OpenCode nie udostępnił stdout".into()))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Other("OpenCode nie udostępnił stderr".into()))?;
    let stdout_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes).await;
        bytes
    });
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes).await;
        bytes
    });
    let completion = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => Ok(status),
        Ok(Err(error)) => Err(AppError::Other(format!("opencode run: {error}"))),
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(AppError::Other("Generowanie tytułu przekroczyło limit 90s".into()))
        }
    };
    let stdout = stdout_task.await.unwrap_or_default();
    let _stderr = stderr_task.await.unwrap_or_default();
    let parsed = parse_run_output(&String::from_utf8_lossy(&stdout));
    let session_id = parsed.session_id.clone();
    let result = match completion {
        Ok(status) if status.success() => resolve_run_text(&parsed),
        Ok(_) => Err(AppError::Other(opencode_failure_message())),
        Err(error) => Err(error),
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
        Err(AppError::Other(opencode_failure_message()))
    }
}

fn opencode_failure_message() -> String {
    "Polecenie OpenCode zakończyło się błędem".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn cleans_a_partial_session_after_timeout() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::TempDir::new().unwrap();
        let binary = directory.path().join("opencode-test");
        let marker = directory.path().join("cleanup-marker");
        std::fs::write(
            &binary,
            "#!/bin/sh\nif [ \"$1\" = \"run\" ]; then\n  printf '%s\\n' '{\"type\":\"step_start\",\"sessionID\":\"temporary\"}'\n  while true; do :; done\nfi\nif [ \"$1\" = \"session\" ] && [ \"$2\" = \"delete\" ]; then\n  printf '%s' \"$3\" > \"$CLEANUP_MARKER\"\n  exit 0\nfi\nexit 1\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&binary).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&binary, permissions).unwrap();
        let environment = HashMap::from([(
            "CLEANUP_MARKER".to_string(),
            marker.display().to_string(),
        )]);

        let result = run_prompt_with_timeout(
            None,
            "prompt",
            &binary,
            Some(&environment),
            Duration::from_millis(50),
        )
        .await;

        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "temporary");
    }

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
    fn does_not_expose_cli_error_output() {
        let message = opencode_failure_message();

        assert_eq!(message, "Polecenie OpenCode zakończyło się błędem");
        assert!(!message.contains("token"));
    }
}
