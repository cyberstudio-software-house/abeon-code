use std::collections::HashMap;
use std::time::{Duration, Instant};

const EXPIRY: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptOrigin {
    Human,
    Supervisor,
    Agent,
}

#[derive(Default)]
struct SessionProvenance {
    injections: Vec<(String, Instant)>,
    cli_prompts: Vec<(String, Instant)>,
    origin: Option<PromptOrigin>,
}

fn take_match(entries: &mut Vec<(String, Instant)>, prompt: &str, now: Instant) -> bool {
    entries.retain(|(_, recorded)| now.saturating_duration_since(*recorded) < EXPIRY);
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

    pub fn expect_cli_prompt(&mut self, session_id: &str, text: &str, now: Instant) {
        self.sessions
            .entry(session_id.to_string())
            .or_default()
            .cli_prompts
            .push((text.trim().to_string(), now));
    }

    pub fn on_user_prompt(&mut self, session_id: &str, prompt: &str, now: Instant) -> PromptOrigin {
        let session = self.sessions.entry(session_id.to_string()).or_default();
        let prompt = prompt.trim();
        let origin = if take_match(&mut session.injections, prompt, now) {
            PromptOrigin::Supervisor
        } else if take_match(&mut session.cli_prompts, prompt, now) {
            PromptOrigin::Agent
        } else {
            PromptOrigin::Human
        };
        session.origin = Some(origin);
        origin
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

    #[test]
    fn injected_text_marks_supervisor() {
        let now = Instant::now();
        let mut tracker = ProvenanceTracker::default();
        tracker.record_injection("s1", "[agent sterujący] tak", now);
        assert_eq!(
            tracker.on_user_prompt("s1", "  [agent sterujący] tak\n", now + MINUTE),
            PromptOrigin::Supervisor
        );
        assert_eq!(tracker.origin("s1"), PromptOrigin::Supervisor);
    }

    #[test]
    fn cli_prompt_marks_agent() {
        let now = Instant::now();
        let mut tracker = ProvenanceTracker::default();
        tracker.expect_cli_prompt("s1", "do the thing", now);
        assert_eq!(
            tracker.on_user_prompt("s1", "do the thing", now + MINUTE),
            PromptOrigin::Agent
        );
        assert_eq!(tracker.origin("s1"), PromptOrigin::Agent);
    }

    #[test]
    fn other_prompt_marks_human_and_resets() {
        let now = Instant::now();
        let mut tracker = ProvenanceTracker::default();
        tracker.record_injection("s1", "answer", now);
        assert_eq!(
            tracker.on_user_prompt("s1", "answer", now),
            PromptOrigin::Supervisor
        );
        assert_eq!(
            tracker.on_user_prompt("s1", "something else", now),
            PromptOrigin::Human
        );
        assert_eq!(tracker.origin("s1"), PromptOrigin::Human);
        assert_eq!(
            tracker.on_user_prompt("s1", "answer", now),
            PromptOrigin::Human
        );
    }

    #[test]
    fn injection_expires_after_ten_minutes() {
        let now = Instant::now();
        let mut tracker = ProvenanceTracker::default();
        tracker.record_injection("s1", "answer", now);
        assert_eq!(
            tracker.on_user_prompt("s1", "answer", now + 11 * MINUTE),
            PromptOrigin::Human
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
    fn several_pending_entries_per_session_are_consumed_individually() {
        let now = Instant::now();
        let mut tracker = ProvenanceTracker::default();
        tracker.record_injection("s1", "first", now);
        tracker.record_injection("s1", "second", now);
        tracker.expect_cli_prompt("s1", "cli", now);
        assert_eq!(
            tracker.on_user_prompt("s1", "second", now),
            PromptOrigin::Supervisor
        );
        assert_eq!(
            tracker.on_user_prompt("s1", "first", now),
            PromptOrigin::Supervisor
        );
        assert_eq!(
            tracker.on_user_prompt("s1", "cli", now),
            PromptOrigin::Agent
        );
        assert_eq!(
            tracker.on_user_prompt("s1", "first", now),
            PromptOrigin::Human
        );
    }

    #[test]
    fn sessions_are_isolated() {
        let now = Instant::now();
        let mut tracker = ProvenanceTracker::default();
        tracker.record_injection("s1", "answer", now);
        assert_eq!(
            tracker.on_user_prompt("s2", "answer", now),
            PromptOrigin::Human
        );
        assert_eq!(
            tracker.on_user_prompt("s1", "answer", now),
            PromptOrigin::Supervisor
        );
    }
}
