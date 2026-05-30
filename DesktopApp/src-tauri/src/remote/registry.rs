use std::collections::HashMap;
use parking_lot::Mutex;

/// Maps a Claude `sessionId` to the live `ptyId` backing it, so remote
/// commands can be routed to the right PTY. Populated in `spawn_pty`,
/// cleared in `pty_kill`.
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

    pub fn unbind_pty(&self, pty_id: &str) {
        self.inner.lock().retain(|_, v| v != pty_id);
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
}
