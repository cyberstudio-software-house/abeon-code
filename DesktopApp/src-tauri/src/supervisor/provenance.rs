use std::collections::HashMap;
use std::time::{Duration, Instant};

const EXPIRY: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptOrigin {
    Human,
    Supervisor,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromptEvidence {
    pub pty_known: bool,
    pub quiet_since_typed: bool,
    pub recent_submit: bool,
}

#[derive(Default)]
struct SessionProvenance {
    injections: Vec<(String, Instant)>,
    cli_prompts: Vec<(String, Instant)>,
    origin: Option<PromptOrigin>,
}

fn is_fresh(recorded: Instant, now: Instant) -> bool {
    now.saturating_duration_since(recorded) < EXPIRY
}

fn take_match(entries: &mut Vec<(String, Instant)>, prompt: &str, now: Instant) -> bool {
    entries.retain(|(_, recorded)| is_fresh(*recorded, now));
    match entries.iter().position(|(text, _)| text == prompt) {
        Some(index) => {
            entries.remove(index);
            true
        }
        None => false,
    }
}

#[derive(Default)]
pub struct ProvenanceTracker {
    sessions: HashMap<String, SessionProvenance>,
}

impl ProvenanceTracker {
    pub fn record_injection(&mut self, session_id: &str, text: &str, now: Instant) {
        self.sessions
            .entry(session_id.to_string())
            .or_default()
            .injections
            .push((text.trim().to_string(), now));
    }

    pub fn forget_injection(&mut self, session_id: &str, typed_at: Instant) {
        if let Some(session) = self.sessions.get_mut(session_id) {
            if let Some(index) = session
                .injections
                .iter()
                .rposition(|(_, recorded)| *recorded == typed_at)
            {
                session.injections.remove(index);
            }
        }
    }

    pub fn last_typed_at(&self, session_id: &str, now: Instant) -> Option<Instant> {
        self.sessions
            .get(session_id)?
            .injections
            .iter()
            .map(|(_, recorded)| *recorded)
            .filter(|recorded| is_fresh(*recorded, now))
            .max()
    }

    pub fn expect_cli_prompt(&mut self, session_id: &str, text: &str, now: Instant) {
        self.sessions
            .entry(session_id.to_string())
            .or_default()
            .cli_prompts
            .push((text.trim().to_string(), now));
    }

    pub fn on_user_prompt(
        &mut self,
        session_id: &str,
        prompt: &str,
        evidence: PromptEvidence,
        now: Instant,
    ) -> PromptOrigin {
        let session = self.sessions.entry(session_id.to_string()).or_default();
        let prompt = prompt.trim();
        let typed: Vec<(String, Instant)> = std::mem::take(&mut session.injections)
            .into_iter()
            .filter(|(_, recorded)| is_fresh(*recorded, now))
            .collect();
        let exact = typed.iter().any(|(text, _)| text == prompt);
        let typed_quietly = evidence.pty_known && !typed.is_empty() && evidence.quiet_since_typed;
        let origin = if exact || typed_quietly {
            PromptOrigin::Supervisor
        } else if take_match(&mut session.cli_prompts, prompt, now) {
            PromptOrigin::Agent
        } else if evidence.pty_known && evidence.recent_submit {
            PromptOrigin::Human
        } else {
            PromptOrigin::Agent
        };
        session.origin = Some(origin);
        origin
    }

    pub fn forget_session(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
    }

    pub fn mark_supervisor(&mut self, session_id: &str) {
        self.sessions
            .entry(session_id.to_string())
            .or_default()
            .origin = Some(PromptOrigin::Supervisor);
    }

    pub fn origin(&self, session_id: &str) -> PromptOrigin {
        self.sessions
            .get(session_id)
            .and_then(|session| session.origin)
            .unwrap_or(PromptOrigin::Human)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: Duration = Duration::from_secs(60);

    const TYPED_QUIETLY: PromptEvidence = PromptEvidence {
        pty_known: true,
        quiet_since_typed: true,
        recent_submit: false,
    };
    const SUBMIT: PromptEvidence = PromptEvidence {
        pty_known: true,
        quiet_since_typed: false,
        recent_submit: true,
    };
    const SILENT: PromptEvidence = PromptEvidence {
        pty_known: true,
        quiet_since_typed: false,
        recent_submit: false,
    };
    const NO_PTY: PromptEvidence = PromptEvidence {
        pty_known: false,
        quiet_since_typed: false,
        recent_submit: false,
    };

    #[test]
    fn typed_injection_without_keystrokes_marks_supervisor_even_if_altered() {
        let now = Instant::now();
        let mut tracker = ProvenanceTracker::default();
        tracker.record_injection("s1", "[agent sterujący] tak", now);
        assert_eq!(tracker.last_typed_at("s1", now + MINUTE), Some(now));
        assert_eq!(
            tracker.on_user_prompt(
                "s1",
                "[agent sterujący] tak, ale…",
                TYPED_QUIETLY,
                now + MINUTE
            ),
            PromptOrigin::Supervisor
        );
        assert_eq!(tracker.origin("s1"), PromptOrigin::Supervisor);
        assert_eq!(tracker.last_typed_at("s1", now + MINUTE), None);
    }

    #[test]
    fn exact_typed_text_marks_supervisor_despite_a_keystroke() {
        let now = Instant::now();
        let mut tracker = ProvenanceTracker::default();
        tracker.record_injection("s1", "[agent sterujący] tak", now);
        assert_eq!(
            tracker.on_user_prompt("s1", "  [agent sterujący] tak\n", SUBMIT, now),
            PromptOrigin::Supervisor
        );
    }

    #[test]
    fn keystroke_after_injection_with_other_text_marks_human_and_drops_the_injection() {
        let now = Instant::now();
        let mut tracker = ProvenanceTracker::default();
        tracker.record_injection("s1", "[agent sterujący] tak", now);
        assert_eq!(
            tracker.on_user_prompt("s1", "nie, poczekaj", SUBMIT, now),
            PromptOrigin::Human
        );
        assert_eq!(tracker.last_typed_at("s1", now), None);
        assert_eq!(
            tracker.on_user_prompt("s1", "[agent sterujący] tak", SILENT, now),
            PromptOrigin::Agent
        );
    }

    #[test]
    fn exact_typed_text_marks_supervisor_without_a_known_pty() {
        let now = Instant::now();
        let mut tracker = ProvenanceTracker::default();
        tracker.record_injection("s1", "[agent sterujący] tak", now);
        assert_eq!(
            tracker.on_user_prompt("s1", "[agent sterujący] tak", NO_PTY, now),
            PromptOrigin::Supervisor
        );
        tracker.record_injection("s1", "[agent sterujący] tak", now);
        assert_eq!(
            tracker.on_user_prompt("s1", "coś innego", NO_PTY, now),
            PromptOrigin::Agent
        );
    }

    #[test]
    fn cli_prompt_marks_agent() {
        let now = Instant::now();
        let mut tracker = ProvenanceTracker::default();
        tracker.expect_cli_prompt("s1", "do the thing", now);
        assert_eq!(
            tracker.on_user_prompt("s1", "do the thing", SUBMIT, now + MINUTE),
            PromptOrigin::Agent
        );
        assert_eq!(tracker.origin("s1"), PromptOrigin::Agent);
        assert_eq!(
            tracker.on_user_prompt("s1", "do the thing", SUBMIT, now + MINUTE),
            PromptOrigin::Human
        );
    }

    #[test]
    fn recent_submit_marks_human_and_silence_marks_agent() {
        let now = Instant::now();
        let mut tracker = ProvenanceTracker::default();
        assert_eq!(
            tracker.on_user_prompt("s1", "zrób push", SUBMIT, now),
            PromptOrigin::Human
        );
        assert_eq!(
            tracker.on_user_prompt("s1", "zrób push", SILENT, now),
            PromptOrigin::Agent
        );
        assert_eq!(tracker.origin("s1"), PromptOrigin::Agent);
    }

    #[test]
    fn unknown_pty_is_never_human() {
        let now = Instant::now();
        let mut tracker = ProvenanceTracker::default();
        tracker.expect_cli_prompt("s1", "przygotuj wydanie", now);
        assert_eq!(
            tracker.on_user_prompt("s1", "przygotuj wydanie", NO_PTY, now),
            PromptOrigin::Agent
        );
        assert_eq!(
            tracker.on_user_prompt("s1", "cokolwiek", NO_PTY, now),
            PromptOrigin::Agent
        );
        let submitted_without_pty = PromptEvidence {
            pty_known: false,
            quiet_since_typed: false,
            recent_submit: true,
        };
        assert_eq!(
            tracker.on_user_prompt("s1", "cokolwiek", submitted_without_pty, now),
            PromptOrigin::Agent
        );
    }

    #[test]
    fn forgotten_session_starts_from_scratch() {
        let now = Instant::now();
        let mut tracker = ProvenanceTracker::default();
        tracker.record_injection("s1", "answer", now);
        tracker.mark_supervisor("s1");
        tracker.forget_session("s1");
        assert_eq!(tracker.last_typed_at("s1", now), None);
        assert_eq!(tracker.origin("s1"), PromptOrigin::Human);
        assert_eq!(
            tracker.on_user_prompt("s1", "answer", TYPED_QUIETLY, now),
            PromptOrigin::Agent
        );
    }

    #[test]
    fn records_expire_after_ten_minutes() {
        let now = Instant::now();
        let mut tracker = ProvenanceTracker::default();
        tracker.record_injection("s1", "answer", now);
        tracker.expect_cli_prompt("s2", "cli", now);
        assert_eq!(tracker.last_typed_at("s1", now + 11 * MINUTE), None);
        assert_eq!(
            tracker.on_user_prompt("s1", "answer", TYPED_QUIETLY, now + 11 * MINUTE),
            PromptOrigin::Agent
        );
        assert_eq!(
            tracker.on_user_prompt("s2", "cli", SILENT, now + 11 * MINUTE),
            PromptOrigin::Agent
        );
        assert_eq!(
            tracker.on_user_prompt("s2", "cli", SUBMIT, now + 11 * MINUTE),
            PromptOrigin::Human
        );
    }

    #[test]
    fn forgotten_injection_no_longer_counts() {
        let now = Instant::now();
        let mut tracker = ProvenanceTracker::default();
        tracker.record_injection("s1", "first", now);
        tracker.record_injection("s1", "second", now + MINUTE);
        assert_eq!(
            tracker.last_typed_at("s1", now + MINUTE),
            Some(now + MINUTE)
        );
        tracker.forget_injection("s1", now + MINUTE);
        assert_eq!(tracker.last_typed_at("s1", now + MINUTE), Some(now));
        tracker.forget_injection("s1", now);
        assert_eq!(tracker.last_typed_at("s1", now + MINUTE), None);
        assert_eq!(
            tracker.on_user_prompt("s1", "first", SILENT, now + MINUTE),
            PromptOrigin::Agent
        );
    }

    #[test]
    fn mark_supervisor_sets_origin() {
        let mut tracker = ProvenanceTracker::default();
        assert_eq!(tracker.origin("unknown"), PromptOrigin::Human);
        tracker.mark_supervisor("s1");
        assert_eq!(tracker.origin("s1"), PromptOrigin::Supervisor);
        assert_eq!(tracker.origin("s2"), PromptOrigin::Human);
    }

    #[test]
    fn sessions_are_isolated() {
        let now = Instant::now();
        let mut tracker = ProvenanceTracker::default();
        tracker.record_injection("s1", "answer", now);
        assert_eq!(tracker.last_typed_at("s2", now), None);
        assert_eq!(
            tracker.on_user_prompt("s2", "answer", SUBMIT, now),
            PromptOrigin::Human
        );
        assert_eq!(
            tracker.on_user_prompt("s1", "x", TYPED_QUIETLY, now),
            PromptOrigin::Supervisor
        );
    }
}
