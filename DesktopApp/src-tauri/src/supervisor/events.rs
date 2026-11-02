use serde::Serialize;

use crate::domain::supervisor::{EscalationChannel, MenuQuestion, SupervisorLevel};

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
pub struct ForwardedEscalation {
    pub session_id: String,
    pub question_id: String,
    pub label: String,
    pub summary: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ForwardedApproval {
    pub approval_id: String,
    pub label: String,
    pub action: String,
    pub code: String,
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
        channel: EscalationChannel,
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
    Forwarded {
        escalations: Vec<ForwardedEscalation>,
        approvals: Vec<ForwardedApproval>,
    },
    DiscordAnswer {
        question_id: String,
        session_id: String,
        label: String,
        key: String,
        question: String,
        value: String,
        open_keys: Vec<String>,
    },
}

impl SupervisorEvent {
    pub fn wakes_supervisor(&self) -> bool {
        matches!(
            self,
            SupervisorEvent::Question { .. }
                | SupervisorEvent::GuardBlocked { .. }
                | SupervisorEvent::Forwarded { .. }
                | SupervisorEvent::DiscordAnswer { .. }
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

    fn guard_blocked(channel: EscalationChannel) -> SupervisorEvent {
        SupervisorEvent::GuardBlocked {
            approval_id: "a".into(),
            session_id: "s".into(),
            label: "l".into(),
            action: "git push → main".into(),
            detail: "git push origin main".into(),
            code: "K7QX".into(),
            channel,
        }
    }

    #[test]
    fn guard_blocked_carries_its_channel() {
        assert_eq!(
            serde_json::to_value(guard_blocked(EscalationChannel::Discord)).unwrap(),
            json!({
                "type": "guardBlocked",
                "approval_id": "a",
                "session_id": "s",
                "label": "l",
                "action": "git push → main",
                "detail": "git push origin main",
                "code": "K7QX",
                "channel": "discord",
            })
        );
        assert_eq!(
            serde_json::to_value(guard_blocked(EscalationChannel::App)).unwrap()["channel"],
            "app"
        );
    }

    #[test]
    fn forwarded_event_json_shape() {
        let event = SupervisorEvent::Forwarded {
            escalations: vec![ForwardedEscalation {
                session_id: "s1".into(),
                question_id: "q1".into(),
                label: "projekt · s1".into(),
                summary: "Który kolor?".into(),
            }],
            approvals: vec![ForwardedApproval {
                approval_id: "a1".into(),
                label: "projekt · s2".into(),
                action: "git push → main".into(),
                code: "K7QX".into(),
            }],
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({
                "type": "forwarded",
                "escalations": [{
                    "session_id": "s1",
                    "question_id": "q1",
                    "label": "projekt · s1",
                    "summary": "Który kolor?",
                }],
                "approvals": [{
                    "approval_id": "a1",
                    "label": "projekt · s2",
                    "action": "git push → main",
                    "code": "K7QX",
                }],
            })
        );
    }

    #[test]
    fn forwarded_wakes_the_supervisor() {
        assert!(SupervisorEvent::Forwarded {
            escalations: Vec::new(),
            approvals: Vec::new(),
        }
        .wakes_supervisor());
    }

    fn discord_answer() -> SupervisorEvent {
        SupervisorEvent::DiscordAnswer {
            question_id: "q1".into(),
            session_id: "s1".into(),
            label: "projekt · s1".into(),
            key: "S1".into(),
            question: "Specyfikacja etapu 2: akceptujesz?".into(),
            value: "tak".into(),
            open_keys: vec!["S2".into()],
        }
    }

    #[test]
    fn discord_answer_event_json_shape() {
        assert_eq!(
            serde_json::to_value(discord_answer()).unwrap(),
            json!({
                "type": "discordAnswer",
                "question_id": "q1",
                "session_id": "s1",
                "label": "projekt · s1",
                "key": "S1",
                "question": "Specyfikacja etapu 2: akceptujesz?",
                "value": "tak",
                "open_keys": ["S2"],
            })
        );
    }

    #[test]
    fn discord_answer_wakes_the_supervisor() {
        assert!(discord_answer().wakes_supervisor());
    }

    #[test]
    fn only_actionable_events_wake_the_supervisor() {
        assert!(guard_blocked(EscalationChannel::App).wakes_supervisor());
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
