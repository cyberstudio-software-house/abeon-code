use super::{
    decision_kind, excerpt, now, single_line, DiscordSync, Outbox, SessionListing, SupervisorCore,
    ANSWER_PREFIX, SUMMARY_CHARS,
};
use crate::db::supervisor_decisions_repo::NewDecision;
use crate::domain::supervisor::EscalationChannel;
use crate::sessions::reader::now_ms;

const RATIONALE_RELAY: &str = "Wiadomość od agenta sterującego";
const ERROR_EMPTY_MESSAGE: &str = "Wiadomość wymaga niepustego pola text";
const ERROR_NO_TERMINAL: &str = "Sesja nie ma otwartego terminala w AbeonCode";
const ERROR_SESSION_BUSY: &str = "Sesja nie czeka na wiadomość — agent w niej pracuje";
const ERROR_EMPTY_SUMMARY: &str = "Eskalacja wymaga niepustego pola summary";
const ERROR_NO_QUESTIONS: &str = "Eskalacja wymaga co najmniej jednego pytania w question_ids";
const ERROR_NOT_ESCALATABLE: &str =
    "Te pytania nie są otwarte albo nie zostały przekazane agentowi";
const ERROR_EMPTY_FIELD: &str = "Pole nie może być puste";

#[derive(Clone, Debug, PartialEq)]
pub struct EscalateOutcome {
    pub skipped: Vec<String>,
    pub channel: EscalationChannel,
}

impl SupervisorCore {
    pub fn escalate(
        &self,
        question_ids: &[String],
        summary: &str,
    ) -> Result<EscalateOutcome, String> {
        let summary = summary.trim();
        if summary.is_empty() {
            return Err(ERROR_EMPTY_SUMMARY.to_string());
        }
        let mut unique: Vec<&str> = Vec::new();
        for question_id in question_ids {
            if !unique.contains(&question_id.as_str()) {
                unique.push(question_id);
            }
        }
        if unique.is_empty() {
            return Err(ERROR_NO_QUESTIONS.to_string());
        }
        let settings = self.effects.settings();
        let now = now();
        let mut outbox = Outbox::default();
        let mut skipped = Vec::new();
        let mut channel = None;
        {
            let mut state = self.state.lock();
            for question_id in unique {
                let handed = state
                    .questions
                    .iter()
                    .any(|question| question.id == question_id && question.with_supervisor());
                let question = if handed {
                    state.take_question(question_id)
                } else {
                    None
                };
                let Some(question) = question else {
                    skipped.push(question_id.to_string());
                    continue;
                };
                state.discard_queued_question(question_id);
                let escalation = state.escalate_question(
                    question,
                    summary.to_string(),
                    summary,
                    &settings,
                    now,
                    &mut outbox,
                );
                channel = Some(escalation.channel);
            }
        }
        let Some(channel) = channel else {
            return Err(format!("{ERROR_NOT_ESCALATABLE}: {}", skipped.join(", ")));
        };
        self.flush(outbox);
        self.publish_with(&settings);
        Ok(EscalateOutcome { skipped, channel })
    }

    pub fn send_to_session(&self, session_id: &str, text: &str) -> Result<(), String> {
        let text = single_line(text);
        if text.is_empty() {
            return Err(ERROR_EMPTY_MESSAGE.to_string());
        }
        let info = self
            .effects
            .session_info(session_id)
            .filter(|info| info.pty_id.is_some())
            .ok_or_else(|| ERROR_NO_TERMINAL.to_string())?;
        {
            let mut state = self.state.lock();
            if !state.at_prompt(session_id) {
                return Err(ERROR_SESSION_BUSY.to_string());
            }
            state.queue_injection(session_id, &format!("{ANSWER_PREFIX}{text}"));
        }
        self.effects.log_decision(NewDecision {
            created_at: now_ms(),
            session_id: Some(session_id.to_string()),
            kind: decision_kind::RELAYED,
            question: info.label,
            decision: text,
            rationale: RATIONALE_RELAY.to_string(),
        });
        self.effects.discord_sync(DiscordSync::SessionSettled {
            session_id: session_id.to_string(),
        });
        Ok(())
    }

    pub fn open_session(
        &self,
        project_path: &str,
        prompt: &str,
        rationale: &str,
    ) -> Result<(), String> {
        for (name, value) in [
            ("project_path", project_path),
            ("prompt", prompt),
            ("rationale", rationale),
        ] {
            if value.trim().is_empty() {
                return Err(format!("{ERROR_EMPTY_FIELD}: {name}"));
            }
        }
        self.effects.open_session(project_path, prompt)?;
        self.effects.log_decision(NewDecision {
            created_at: now_ms(),
            session_id: None,
            kind: decision_kind::SESSION_OPENED,
            question: project_path.to_string(),
            decision: excerpt(prompt, SUMMARY_CHARS),
            rationale: rationale.trim().to_string(),
        });
        Ok(())
    }

    pub fn list_sessions(&self) -> Vec<SessionListing> {
        let mut listings = self.effects.list_sessions();
        let state = self.state.lock();
        for listing in &mut listings {
            listing.pending_question_id = state
                .questions
                .iter()
                .find(|question| {
                    question.session_id == listing.session_id && question.with_supervisor()
                })
                .map(|question| question.id.clone());
        }
        listings
    }

    pub fn read_session(&self, session_id: &str, max_blocks: usize) -> Option<String> {
        self.effects.read_session(session_id, max_blocks)
    }
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use crate::supervisor::test_support::*;

    #[tokio::test(start_paused = true)]
    async fn relay_into_escalated_session_clears_awaiting_user() {
        let (effects, core) = setup();
        core.set_away(true);
        let handle = spawn_menu(&core, "s1").await;
        let question_id = only_question_id(core.take_events());
        core.escalate(&[question_id], "Kolor wybiera użytkownik")
            .unwrap();
        assert!(matches!(reply_of(handle).await, HookReply::Deny { .. }));
        core.on_session_hook(stop("s1", "Czekam na decyzję użytkownika."))
            .await;
        assert!(core.take_events().is_empty());
        core.send_to_session("s1", "Użytkownik wybrał zielony")
            .unwrap();
        core.tick();
        assert_eq!(
            effects.typed(),
            vec![(
                "pty-s1".to_string(),
                "[agent sterujący] Użytkownik wybrał zielony\r".to_string()
            )]
        );
        core.on_session_hook(prompt("s1", "[agent sterujący] Użytkownik wybrał zielony"))
            .await;
        assert_eq!(
            core.state.lock().provenance.origin("s1"),
            PromptOrigin::Supervisor
        );
        assert_eq!(core.snapshot().escalations.len(), 1);
        core.on_session_hook(stop("s1", "Zrobione. Commitować?"))
            .await;
        assert_eq!(core.take_events().len(), 1);
        assert_eq!(
            effects.kinds(),
            vec![decision_kind::ESCALATED, decision_kind::RELAYED]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn any_prompt_closes_the_open_turn_end() {
        let (effects, core) = setup();
        core.set_away(true);
        core.on_session_hook(stop("s1", "Czy kontynuować?")).await;
        let seen = only_question_id(core.take_events());
        core.send_to_session("s1", "Najpierw uruchom testy")
            .unwrap();
        core.tick();
        core.on_session_hook(prompt("s1", "[agent sterujący] Najpierw uruchom testy"))
            .await;
        assert_eq!(
            core.take_events(),
            vec![SupervisorEvent::QuestionResolved {
                question_id: seen.clone(),
                by: ResolvedBy::User,
            }]
        );
        assert!(core
            .answer_question(&seen, Some("tak".into()), None, "x")
            .is_err());
        core.on_session_hook(stop("s1", "Testy przechodzą. Dalej?"))
            .await;
        core.send_to_session("s1", "Dalej").unwrap();
        core.tick();
        core.on_session_hook(prompt("s1", "[agent sterujący] Dalej"))
            .await;
        assert!(core.take_events().is_empty());
        assert_eq!(effects.typed().len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn send_to_session_settles_the_session_on_discord() {
        let (effects, core) = setup();
        core.set_away(true);
        assert!(core.send_to_session("s1", "Dalej").is_err());
        assert!(effects.discord_syncs().is_empty());
        core.on_session_hook(stop("s1", "Czy kontynuować?")).await;
        core.send_to_session("s1", "Użytkownik wybrał wariant A")
            .unwrap();
        assert_eq!(
            effects.discord_syncs(),
            vec![DiscordSync::SessionSettled {
                session_id: "s1".into()
            }]
        );
    }
}
