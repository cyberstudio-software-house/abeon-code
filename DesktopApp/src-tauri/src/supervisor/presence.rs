use std::time::{Duration, Instant};

#[derive(Default)]
pub struct Presence {
    last_activity: Option<Instant>,
    away: bool,
    focused_session: Option<String>,
}

impl Presence {
    pub fn record_activity(&mut self, now: Instant, focused_session: Option<String>) {
        self.last_activity = Some(now);
        self.focused_session = focused_session;
    }

    pub fn set_away(&mut self, away: bool) {
        self.away = away;
    }

    pub fn away(&self) -> bool {
        self.away
    }

    pub fn is_present(&self, now: Instant, threshold: Duration) -> bool {
        !self.away
            && self
                .last_activity
                .is_some_and(|last| now.saturating_duration_since(last) < threshold)
    }

    pub fn focused_session(&self) -> Option<&str> {
        self.focused_session.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const THRESHOLD: Duration = Duration::from_secs(300);

    #[test]
    fn absent_without_activity() {
        let presence = Presence::default();
        assert!(!presence.is_present(Instant::now(), THRESHOLD));
    }

    #[test]
    fn present_within_threshold() {
        let now = Instant::now();
        let mut presence = Presence::default();
        presence.record_activity(now, None);
        assert!(presence.is_present(now + Duration::from_secs(299), THRESHOLD));
    }

    #[test]
    fn absent_after_threshold() {
        let now = Instant::now();
        let mut presence = Presence::default();
        presence.record_activity(now, None);
        assert!(!presence.is_present(now + THRESHOLD, THRESHOLD));
    }

    #[test]
    fn away_overrides_activity() {
        let now = Instant::now();
        let mut presence = Presence::default();
        presence.record_activity(now, None);
        presence.set_away(true);
        assert!(presence.away());
        assert!(!presence.is_present(now, THRESHOLD));
        presence.set_away(false);
        assert!(presence.is_present(now, THRESHOLD));
    }

    #[test]
    fn focused_session_tracks_last_report() {
        let now = Instant::now();
        let mut presence = Presence::default();
        assert_eq!(presence.focused_session(), None);
        presence.record_activity(now, Some("s1".to_string()));
        assert_eq!(presence.focused_session(), Some("s1"));
        presence.record_activity(now, None);
        assert_eq!(presence.focused_session(), None);
    }
}
