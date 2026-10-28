use std::collections::HashMap;
use parking_lot::Mutex;
use crate::commands::pty::PtyKind;
use crate::domain::Provider;

#[derive(Default)]
pub struct SessionPtyRegistry {
    inner: Mutex<HashMap<String, String>>,
}

impl SessionPtyRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn bind(&self, session_id: &str, pty_id: &str) {
        self.inner.lock().insert(session_id.to_string(), pty_id.to_string());
    }

    pub fn pty_for(&self, session_id: &str) -> Option<String> {
        self.inner.lock().get(session_id).cloned()
    }

    pub fn session_for(&self, pty_id: &str) -> Option<String> {
        self.inner
            .lock()
            .iter()
            .find(|(_, v)| v.as_str() == pty_id)
            .map(|(k, _)| k.clone())
    }

    pub fn unbind_pty(&self, pty_id: &str) {
        self.inner.lock().retain(|_, v| v != pty_id);
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
