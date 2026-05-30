use tokio::sync::broadcast;

/// A session-domain event observed from `SessionWatchers`, to be forwarded
/// to Centrifugo by the bridge. Mirrors the existing `session:{id}:*` emits.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionBusEvent {
    Append { session_id: String, blocks: serde_json::Value },
    Activity { session_id: String, activity: serde_json::Value },
    Title { session_id: String, title: String },
    Usage { session_id: String, summary: serde_json::Value },
}

/// Broadcast hub. `SessionWatchers` publishes; the bridge subscribes.
#[derive(Clone)]
pub struct RemoteEventBus {
    tx: broadcast::Sender<SessionBusEvent>,
}

impl RemoteEventBus {
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(256);
        Self { tx }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SessionBusEvent> {
        self.tx.subscribe()
    }

    /// Publish an event. Ignores the "no active receivers" error so the watcher
    /// never blocks or fails when the bridge isn't connected.
    pub fn publish(&self, event: SessionBusEvent) {
        let _ = self.tx.send(event);
    }
}

impl Default for RemoteEventBus {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn subscriber_receives_published_event() {
        let bus = RemoteEventBus::new();
        let mut rx = bus.subscribe();
        bus.publish(SessionBusEvent::Title { session_id: "s1".into(), title: "Hello".into() });
        let got = rx.recv().await.unwrap();
        assert_eq!(got, SessionBusEvent::Title { session_id: "s1".into(), title: "Hello".into() });
    }

    #[test]
    fn publish_without_subscribers_does_not_panic() {
        let bus = RemoteEventBus::new();
        bus.publish(SessionBusEvent::Title { session_id: "s1".into(), title: "x".into() });
    }
}
