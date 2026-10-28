use std::collections::HashMap;
use std::time::{Duration, Instant};
use parking_lot::Mutex;

#[derive(Default)]
pub struct InputActivity {
    inner: Mutex<HashMap<String, Instant>>,
}

impl InputActivity {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&self, pty_id: &str) {
        self.record_at(pty_id, Instant::now());
    }

    pub fn record_at(&self, pty_id: &str, at: Instant) {
        self.inner.lock().insert(pty_id.to_string(), at);
    }

    pub fn quiet_for(&self, pty_id: &str, window: Duration) -> bool {
        match self.inner.lock().get(pty_id) {
            Some(last) => last.elapsed() >= window,
            None => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_when_never_recorded() {
        let activity = InputActivity::new();
        assert!(activity.quiet_for("p1", Duration::from_secs(5)));
    }

    #[test]
    fn not_quiet_right_after_record() {
        let activity = InputActivity::new();
        activity.record("p1");
        assert!(!activity.quiet_for("p1", Duration::from_secs(5)));
    }

    #[test]
    fn quiet_after_window_elapsed() {
        let activity = InputActivity::new();
        activity.record_at("p1", Instant::now() - Duration::from_secs(6));
        assert!(activity.quiet_for("p1", Duration::from_secs(5)));
    }
}
