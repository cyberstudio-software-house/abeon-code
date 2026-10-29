use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::domain::supervisor::MenuQuestion;

#[derive(Deserialize, Debug, Clone)]
pub struct HookInput {
    pub session_id: String,
    pub hook_event_name: String,
    pub cwd: Option<String>,
    pub prompt: Option<String>,
    pub last_assistant_message: Option<String>,
    pub tool_name: Option<String>,
    pub tool_input: Option<Value>,
    pub source: Option<String>,
    #[serde(default)]
    pub stop_hook_active: Option<bool>,
    #[serde(skip)]
    pub pty_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum HookReply {
    Empty,
    AnswerMenu {
        questions: Value,
        answers: Map<String, Value>,
    },
    Deny {
        reason: String,
    },
}

impl HookReply {
    pub fn to_stdout(&self) -> Option<String> {
        let value = match self {
            HookReply::Empty => return None,
            HookReply::AnswerMenu { questions, answers } => json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "updatedInput": {
                        "questions": questions,
                        "answers": answers,
                    }
                }
            }),
            HookReply::Deny { reason } => json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            }),
        };
        Some(value.to_string())
    }
}

pub fn menu_questions(tool_input: &Value) -> Vec<MenuQuestion> {
    let Some(questions) = tool_input.get("questions").and_then(Value::as_array) else {
        return Vec::new();
    };
    questions
        .iter()
        .map(|entry| MenuQuestion {
            question: entry
                .get("question")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            header: entry
                .get("header")
                .and_then(Value::as_str)
                .map(str::to_string),
            options: entry
                .get("options")
                .and_then(Value::as_array)
                .map(|options| {
                    options
                        .iter()
                        .filter_map(|option| option.get("label").and_then(Value::as_str))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            multi_select: entry
                .get("multiSelect")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPIKE: &str = r#"{"session_id":"s","hook_event_name":"PreToolUse","cwd":"/w","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Which color do you prefer?","header":"Color","multiSelect":false,"options":[{"label":"Red","description":""},{"label":"Green","description":""}]}]},"extra":1}"#;

    fn spike_input() -> HookInput {
        serde_json::from_str(SPIKE).unwrap()
    }

    #[test]
    fn parses_spike_payload() {
        let input = spike_input();
        assert_eq!(input.session_id, "s");
        assert_eq!(input.hook_event_name, "PreToolUse");
        assert_eq!(input.cwd.as_deref(), Some("/w"));
        assert_eq!(input.tool_name.as_deref(), Some("AskUserQuestion"));
        assert!(input.tool_input.is_some());
        assert!(input.prompt.is_none());
        assert!(input.last_assistant_message.is_none());
        assert!(input.source.is_none());
    }

    #[test]
    fn menu_questions_extracts_labels() {
        let input = spike_input();
        let questions = menu_questions(input.tool_input.as_ref().unwrap());
        assert_eq!(
            questions,
            vec![MenuQuestion {
                question: "Which color do you prefer?".into(),
                header: Some("Color".into()),
                options: vec!["Red".into(), "Green".into()],
                multi_select: false,
            }]
        );
    }

    #[test]
    fn menu_questions_without_questions_is_empty() {
        assert!(menu_questions(&json!({"other": 1})).is_empty());
    }

    #[test]
    fn answer_menu_json_shape() {
        let input = spike_input();
        let mut answers = Map::new();
        answers.insert("Which color do you prefer?".into(), json!("Green"));
        let reply = HookReply::AnswerMenu {
            questions: input.tool_input.unwrap()["questions"].clone(),
            answers,
        };
        let parsed: Value = serde_json::from_str(&reply.to_stdout().unwrap()).unwrap();
        let output = &parsed["hookSpecificOutput"];
        assert_eq!(output["hookEventName"], "PreToolUse");
        assert_eq!(output["permissionDecision"], "allow");
        assert_eq!(
            output["updatedInput"]["answers"]["Which color do you prefer?"],
            "Green"
        );
        assert_eq!(
            output["updatedInput"]["questions"][0]["question"],
            "Which color do you prefer?"
        );
    }

    #[test]
    fn deny_json_shape() {
        let reply = HookReply::Deny {
            reason: "Nie".into(),
        };
        let parsed: Value = serde_json::from_str(&reply.to_stdout().unwrap()).unwrap();
        let output = &parsed["hookSpecificOutput"];
        assert_eq!(output["hookEventName"], "PreToolUse");
        assert_eq!(output["permissionDecision"], "deny");
        assert_eq!(output["permissionDecisionReason"], "Nie");
    }

    #[test]
    fn empty_prints_nothing() {
        assert_eq!(HookReply::Empty.to_stdout(), None);
    }
}
