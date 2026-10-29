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

    pub fn claim(&self, session_id: &str, pty_id: &str) -> SessionClaim {
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
        inner
            .homes
            .entry(session_id.to_string())
            .or_insert_with(|| pty_id.to_string());
        let displaced: Vec<String> = inner
            .current
            .iter()
            .filter(|(session, pty)| session.as_str() != session_id && pty.as_str() == pty_id)
            .map(|(session, _)| session.clone())
            .collect();
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
        assert_eq!(reg.claim("s3", "p1"), rebound(&["s1"]));
        assert_eq!(reg.pty_for("s3"), Some("p1".to_string()));
        assert_eq!(reg.pty_for("s1"), None);
        assert_eq!(reg.session_for("p1"), Some("s3".to_string()));
        assert_eq!(reg.pty_for("s2"), Some("p2".to_string()));
        assert_eq!(reg.claim("s3", "p1"), SessionClaim::Kept);
        assert_eq!(reg.pty_for("s3"), Some("p1".to_string()));
    }

    #[test]
    fn claim_ignores_ptys_the_app_did_not_issue() {
        let reg = SessionPtyRegistry::new();
        reg.bind("s1", "shell");
        assert_eq!(reg.claim("s2", "shell"), SessionClaim::Refused);
        assert_eq!(reg.claim("s2", "p9"), SessionClaim::Refused);
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
        assert_eq!(reg.claim("s1", "p2"), SessionClaim::Refused);
        assert_eq!(reg.pty_for("s1"), Some("p1".to_string()));
        assert_eq!(reg.session_for("p2"), Some("s2".to_string()));
        assert_eq!(reg.claim("x", "p1"), rebound(&["s1"]));
        assert_eq!(reg.claim("x", "p2"), SessionClaim::Refused);
        assert_eq!(reg.claim("s1", "p2"), SessionClaim::Refused);
        assert_eq!(reg.pty_for("s1"), None);
        assert_eq!(reg.session_for("p2"), Some("s2".to_string()));
    }

    #[test]
    fn clear_then_resume_in_the_same_pty_swaps_the_sessions() {
        let reg = SessionPtyRegistry::new();
        reg.register_hooked_pty("p1");
        reg.bind("a", "p1");
        assert_eq!(reg.claim("b", "p1"), rebound(&["a"]));
        assert_eq!(reg.claim("a", "p1"), rebound(&["b"]));
        assert_eq!(reg.pty_for("a"), Some("p1".to_string()));
        assert_eq!(reg.pty_for("b"), None);
        assert_eq!(reg.claim("b", "p1"), rebound(&["a"]));
    }

    #[test]
    fn the_app_moves_a_session_explicitly() {
        let reg = SessionPtyRegistry::new();
        reg.register_hooked_pty("p1");
        reg.register_hooked_pty("p2");
        reg.bind("a", "p1");
        reg.bind("a", "p2");
        assert_eq!(reg.claim("a", "p1"), SessionClaim::Refused);
        assert_eq!(reg.claim("a", "p2"), SessionClaim::Kept);
    }

    #[test]
    fn unbinding_a_pty_drops_its_history_and_issued_id() {
        let reg = SessionPtyRegistry::new();
        reg.register_hooked_pty("p1");
        reg.register_hooked_pty("p2");
        reg.bind("a", "p1");
        assert_eq!(reg.claim("b", "p1"), rebound(&["a"]));
        reg.unbind_pty("p1");
        assert_eq!(reg.pty_for("b"), None);
        assert_eq!(reg.claim("a", "p1"), SessionClaim::Refused);
        assert_eq!(reg.claim("a", "p2"), rebound(&[]));
        assert_eq!(reg.claim("b", "p2"), rebound(&["a"]));
        assert_eq!(reg.inner.lock().homes.len(), 2);
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
