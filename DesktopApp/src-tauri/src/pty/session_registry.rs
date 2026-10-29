use std::collections::{HashMap, HashSet};
use parking_lot::Mutex;
use crate::commands::pty::PtyKind;
use crate::domain::Provider;

pub const PTY_ID_ENV: &str = "ABEONCODE_PTY_ID";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionClaim {
    Refused,
    Kept,
    Rebound { displaced: Vec<String> },
}

#[derive(Default)]
struct Bindings {
    current: HashMap<String, String>,
    homes: HashMap<String, String>,
    hooked: HashSet<String>,
}

#[derive(Default)]
pub struct SessionPtyRegistry {
    inner: Mutex<Bindings>,
}

impl SessionPtyRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn bind(&self, session_id: &str, pty_id: &str) {
        let mut inner = self.inner.lock();
        inner.current.insert(session_id.to_string(), pty_id.to_string());
        inner.homes.insert(session_id.to_string(), pty_id.to_string());
    }

    pub fn register_hooked_pty(&self, pty_id: &str) {
        self.inner.lock().hooked.insert(pty_id.to_string());
    }

    pub fn claim(&self, session_id: &str, pty_id: &str, submitted: bool) -> SessionClaim {
        let mut inner = self.inner.lock();
        if !inner.hooked.contains(pty_id) {
            return SessionClaim::Refused;
        }
        if inner.homes.get(session_id).is_some_and(|home| home != pty_id) {
            return SessionClaim::Refused;
        }
        if inner.current.get(session_id).is_some_and(|current| current == pty_id) {
            return SessionClaim::Kept;
        }
        let displaced: Vec<String> = inner
            .current
            .iter()
            .filter(|(session, pty)| session.as_str() != session_id && pty.as_str() == pty_id)
            .map(|(session, _)| session.clone())
            .collect();
        if !displaced.is_empty() && !submitted {
            return SessionClaim::Refused;
        }
        inner
            .homes
            .entry(session_id.to_string())
            .or_insert_with(|| pty_id.to_string());
        for session in &displaced {
            inner.current.remove(session);
        }
        inner.current.insert(session_id.to_string(), pty_id.to_string());
        SessionClaim::Rebound { displaced }
    }

    pub fn pty_for(&self, session_id: &str) -> Option<String> {
        self.inner.lock().current.get(session_id).cloned()
    }

    pub fn session_for(&self, pty_id: &str) -> Option<String> {
        self.inner
            .lock()
            .current
            .iter()
            .find(|(_, v)| v.as_str() == pty_id)
            .map(|(k, _)| k.clone())
    }

    pub fn unbind_pty(&self, pty_id: &str) {
        let mut inner = self.inner.lock();
        inner.current.retain(|_, v| v != pty_id);
        inner.homes.retain(|_, v| v != pty_id);
        inner.hooked.remove(pty_id);
    }
}

pub fn session_to_bind(kind: &PtyKind) -> Option<String> {
    match kind {
        PtyKind::Agent { provider: Provider::Claude, session_id: Some(id), .. } => Some(id.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_then_lookup() {
        let reg = SessionPtyRegistry::new();
        reg.bind("sess-1", "pty-a");
        assert_eq!(reg.pty_for("sess-1"), Some("pty-a".to_string()));
        assert_eq!(reg.pty_for("missing"), None);
    }

    #[test]
    fn rebind_overwrites() {
        let reg = SessionPtyRegistry::new();
        reg.bind("sess-1", "pty-a");
        reg.bind("sess-1", "pty-b");
        assert_eq!(reg.pty_for("sess-1"), Some("pty-b".to_string()));
    }

    #[test]
    fn unbind_pty_removes_all_entries_for_that_pty() {
        let reg = SessionPtyRegistry::new();
        reg.bind("sess-1", "pty-a");
        reg.bind("sess-2", "pty-b");
        reg.unbind_pty("pty-a");
        assert_eq!(reg.pty_for("sess-1"), None);
        assert_eq!(reg.pty_for("sess-2"), Some("pty-b".to_string()));
    }

    const SUBMITTED: bool = true;
    const SILENT: bool = false;

    fn rebound(displaced: &[&str]) -> SessionClaim {
        SessionClaim::Rebound {
            displaced: displaced.iter().map(|id| id.to_string()).collect(),
        }
    }

    #[test]
    fn claim_moves_an_issued_pty_to_the_new_session() {
        let reg = SessionPtyRegistry::new();
        reg.register_hooked_pty("p1");
        reg.register_hooked_pty("p2");
        reg.bind("s1", "p1");
        reg.bind("s2", "p2");
        assert_eq!(reg.claim("s3", "p1", SUBMITTED), rebound(&["s1"]));
        assert_eq!(reg.pty_for("s3"), Some("p1".to_string()));
        assert_eq!(reg.pty_for("s1"), None);
        assert_eq!(reg.session_for("p1"), Some("s3".to_string()));
        assert_eq!(reg.pty_for("s2"), Some("p2".to_string()));
        assert_eq!(reg.claim("s3", "p1", SUBMITTED), SessionClaim::Kept);
        assert_eq!(reg.pty_for("s3"), Some("p1".to_string()));
    }

    #[test]
    fn claim_ignores_ptys_the_app_did_not_issue() {
        let reg = SessionPtyRegistry::new();
        reg.bind("s1", "shell");
        assert_eq!(reg.claim("s2", "shell", SUBMITTED), SessionClaim::Refused);
        assert_eq!(reg.claim("s2", "p9", SUBMITTED), SessionClaim::Refused);
        assert_eq!(reg.pty_for("s2"), None);
        assert_eq!(reg.session_for("shell"), Some("s1".to_string()));
    }

    #[test]
    fn a_session_never_leaves_its_first_pty() {
        let reg = SessionPtyRegistry::new();
        reg.register_hooked_pty("p1");
        reg.register_hooked_pty("p2");
        reg.bind("s1", "p1");
        reg.bind("s2", "p2");
        assert_eq!(reg.claim("s1", "p2", SUBMITTED), SessionClaim::Refused);
        assert_eq!(reg.pty_for("s1"), Some("p1".to_string()));
        assert_eq!(reg.session_for("p2"), Some("s2".to_string()));
        assert_eq!(reg.claim("x", "p1", SUBMITTED), rebound(&["s1"]));
        assert_eq!(reg.claim("x", "p2", SUBMITTED), SessionClaim::Refused);
        assert_eq!(reg.claim("s1", "p2", SUBMITTED), SessionClaim::Refused);
        assert_eq!(reg.pty_for("s1"), None);
        assert_eq!(reg.session_for("p2"), Some("s2".to_string()));
    }

    #[test]
    fn clear_then_resume_in_the_same_pty_swaps_the_sessions() {
        let reg = SessionPtyRegistry::new();
        reg.register_hooked_pty("p1");
        reg.bind("a", "p1");
        assert_eq!(reg.claim("b", "p1", SUBMITTED), rebound(&["a"]));
        assert_eq!(reg.claim("a", "p1", SUBMITTED), rebound(&["b"]));
        assert_eq!(reg.pty_for("a"), Some("p1".to_string()));
        assert_eq!(reg.pty_for("b"), None);
        assert_eq!(reg.claim("b", "p1", SUBMITTED), rebound(&["a"]));
    }

    #[test]
    fn the_app_moves_a_session_explicitly() {
        let reg = SessionPtyRegistry::new();
        reg.register_hooked_pty("p1");
        reg.register_hooked_pty("p2");
        reg.bind("a", "p1");
        reg.bind("a", "p2");
        assert_eq!(reg.claim("a", "p1", SUBMITTED), SessionClaim::Refused);
        assert_eq!(reg.claim("a", "p2", SUBMITTED), SessionClaim::Kept);
    }

    #[test]
    fn unbinding_a_pty_drops_its_history_and_issued_id() {
        let reg = SessionPtyRegistry::new();
        reg.register_hooked_pty("p1");
        reg.register_hooked_pty("p2");
        reg.bind("a", "p1");
        assert_eq!(reg.claim("b", "p1", SUBMITTED), rebound(&["a"]));
        reg.unbind_pty("p1");
        assert_eq!(reg.pty_for("b"), None);
        assert_eq!(reg.claim("a", "p1", SUBMITTED), SessionClaim::Refused);
        assert_eq!(reg.claim("a", "p2", SUBMITTED), rebound(&[]));
        assert_eq!(reg.claim("b", "p2", SUBMITTED), rebound(&["a"]));
        assert_eq!(reg.inner.lock().homes.len(), 2);
    }

    #[test]
    fn displacing_a_live_session_needs_a_recent_submit() {
        let reg = SessionPtyRegistry::new();
        reg.register_hooked_pty("p1");
        reg.bind("t", "p1");
        assert_eq!(reg.claim("y", "p1", SILENT), SessionClaim::Refused);
        assert_eq!(reg.pty_for("t"), Some("p1".to_string()));
        assert_eq!(reg.pty_for("y"), None);
        assert!(!reg.inner.lock().homes.contains_key("y"));
        assert_eq!(reg.claim("y", "p1", SUBMITTED), rebound(&["t"]));
        assert_eq!(reg.claim("t", "p1", SILENT), SessionClaim::Refused);
        assert_eq!(reg.pty_for("y"), Some("p1".to_string()));
        assert_eq!(reg.claim("t", "p1", SUBMITTED), rebound(&["y"]));
    }

    #[test]
    fn a_homeless_session_needs_a_submit_to_take_an_occupied_pty() {
        let reg = SessionPtyRegistry::new();
        reg.register_hooked_pty("p1");
        reg.register_hooked_pty("p2");
        reg.bind("a", "p1");
        reg.unbind_pty("p1");
        reg.bind("t", "p2");
        assert_eq!(reg.claim("a", "p2", SILENT), SessionClaim::Refused);
        assert_eq!(reg.session_for("p2"), Some("t".to_string()));
        assert_eq!(reg.claim("a", "p2", SUBMITTED), rebound(&["t"]));
    }

    #[test]
    fn claims_that_displace_nobody_need_no_submit() {
        let reg = SessionPtyRegistry::new();
        reg.register_hooked_pty("p1");
        assert_eq!(reg.claim("a", "p1", SILENT), rebound(&[]));
        assert_eq!(reg.claim("a", "p1", SILENT), SessionClaim::Kept);
        assert_eq!(reg.pty_for("a"), Some("p1".to_string()));
    }

    #[test]
    fn session_for_reverse_lookup() {
        let reg = SessionPtyRegistry::new();
        reg.bind("s1", "p1");
        assert_eq!(reg.session_for("p1"), Some("s1".to_string()));
        assert_eq!(reg.session_for("x"), None);
    }

    #[test]
    fn session_to_bind_only_for_claude_with_id() {
        assert_eq!(
            session_to_bind(&PtyKind::Agent {
                provider: Provider::Claude,
                session_id: Some("s1".into()), model: None, effort: None, skip_permissions: false, fresh: true, initial_prompt: None,
            }),
            Some("s1".to_string())
        );
        assert_eq!(
            session_to_bind(&PtyKind::Agent {
                provider: Provider::Claude,
                session_id: None, model: None, effort: None, skip_permissions: false, fresh: false, initial_prompt: None,
            }),
            None
        );
        assert_eq!(session_to_bind(&PtyKind::Shell), None);
        assert_eq!(session_to_bind(&PtyKind::Action { action_id: 1 }), None);
    }

    #[test]
    fn session_to_bind_none_for_codex() {
        assert_eq!(
            session_to_bind(&PtyKind::Agent {
                provider: Provider::Codex,
                session_id: Some("s1".into()), model: None, effort: None, skip_permissions: false, fresh: true, initial_prompt: None,
            }),
            None
        );
    }
}
