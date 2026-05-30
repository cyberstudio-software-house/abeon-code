use async_trait::async_trait;
use serde_json::Value;

/// Outbound side of a Centrifugo connection. The real implementation
/// (tokio-tungstenite) and the test fake both implement this. Inbound
/// publications are delivered out-of-band via an mpsc channel owned by the
/// implementation (wired in plan 2b-β).
#[async_trait]
pub trait CentrifugoClient: Send + Sync {
    async fn publish(&self, channel: &str, data: Value) -> anyhow::Result<()>;
}

/// Test double: records every published (channel, data) pair.
#[derive(Default)]
pub struct FakeCentrifugoClient {
    published: parking_lot::Mutex<Vec<(String, Value)>>,
}

impl FakeCentrifugoClient {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn published(&self) -> Vec<(String, Value)> {
        self.published.lock().clone()
    }
}

#[async_trait]
impl CentrifugoClient for FakeCentrifugoClient {
    async fn publish(&self, channel: &str, data: Value) -> anyhow::Result<()> {
        self.published.lock().push((channel.to_string(), data));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn fake_records_published_messages() {
        let fake = FakeCentrifugoClient::new();
        fake.publish("sess:s1", json!({ "type": "cmdResult", "ok": true })).await.unwrap();
        fake.publish("sess:s1", json!({ "type": "sessionActivity" })).await.unwrap();

        let sent = fake.published();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0].0, "sess:s1");
        assert_eq!(sent[0].1, json!({ "type": "cmdResult", "ok": true }));
        assert_eq!(sent[1].0, "sess:s1");
    }
}
