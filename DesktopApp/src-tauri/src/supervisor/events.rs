use serde::Serialize;

use crate::domain::supervisor::{MenuQuestion, SupervisorLevel};

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum QuestionKind {
    TurnEnded,
    Menu,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResolvedBy {
    User,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SupervisorEvent {
    Question {
        question_id: String,
        session_id: String,
        label: String,
        kind: QuestionKind,
        text: Option<String>,
        questions: Option<Vec<MenuQuestion>>,
    },
    GuardBlocked {
        approval_id: String,
        session_id: String,
        label: String,
        action: String,
        detail: String,
        code: String,
    },
    ApprovalResolved {
        approval_id: String,
        approved: bool,
    },
    QuestionResolved {
        question_id: String,
        by: ResolvedBy,
    },
    LevelChanged {
        level: SupervisorLevel,
    },
}

impl SupervisorEvent {
    pub fn wakes_supervisor(&self) -> bool {
        matches!(
            self,
            SupervisorEvent::Question { .. } | SupervisorEvent::GuardBlocked { .. }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn question_event_json_shape() {
        let event = SupervisorEvent::Question {
            question_id: "q1".into(),
            session_id: "s1".into(),
            label: "projekt · sesja".into(),
            kind: QuestionKind::TurnEnded,
            text: Some("Dalej?".into()),
            questions: None,
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({
                "type": "question",
                "question_id": "q1",
                "session_id": "s1",
                "label": "projekt · sesja",
                "kind": "turnEnded",
                "text": "Dalej?",
                "questions": null,
            })
        );
    }

    #[test]
    fn small_event_json_shapes() {
        assert_eq!(
            serde_json::to_value(SupervisorEvent::QuestionResolved {
                question_id: "q1".into(),
                by: ResolvedBy::User,
            })
            .unwrap(),
            json!({"type": "questionResolved", "question_id": "q1", "by": "user"})
        );
        assert_eq!(
            serde_json::to_value(SupervisorEvent::LevelChanged {
                level: SupervisorLevel::Relay,
            })
            .unwrap(),
            json!({"type": "levelChanged", "level": "relay"})
        );
    }

    #[test]
    fn only_actionable_events_wake_the_supervisor() {
        assert!(SupervisorEvent::GuardBlocked {
            approval_id: "a".into(),
            session_id: "s".into(),
            label: "l".into(),
            action: "git push → main".into(),
            detail: "git push origin main".into(),
            code: "K7QX".into(),
        }
        .wakes_supervisor());
        assert!(!SupervisorEvent::ApprovalResolved {
            approval_id: "a".into(),
            approved: true,
        }
        .wakes_supervisor());
        assert!(!SupervisorEvent::LevelChanged {
            level: SupervisorLevel::Assistant,
        }
        .wakes_supervisor());
    }
}
