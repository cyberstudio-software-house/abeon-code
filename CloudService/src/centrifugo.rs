use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Mutex;

/// The Centrifugo server-side operations CloudService needs: publish a command
/// and check whether the target desktop is connected (presence).
#[async_trait]
pub trait CentrifugoApi: Send + Sync {
    async fn publish(&self, channel: &str, data: Value) -> anyhow::Result<()>;
    /// Number of connected clients on a channel (0 ⇒ desktop offline).
    async fn presence_count(&self, channel: &str) -> anyhow::Result<u64>;
}

/// Real client against the Centrifugo HTTP server API (in-cluster).
pub struct HttpCentrifugo {
    client: reqwest::Client,
    api_url: String,
    api_key: String,
}

impl HttpCentrifugo {
    pub fn new(api_url: String, api_key: String) -> Self {
        Self { client: reqwest::Client::new(), api_url, api_key }
    }

    async fn call(&self, method: &str, params: Value) -> anyhow::Result<Value> {
        let url = format!("{}/api", self.api_url.trim_end_matches('/'));
        let resp = self
            .client
            .post(&url)
            .header("X-API-Key", &self.api_key)
            .json(&json!({ "method": method, "params": params }))
            .send()
            .await?
            .error_for_status()?;
        let body: Value = resp.json().await?;
        if let Some(err) = body.get("error") {
            anyhow::bail!("centrifugo {method} error: {err}");
        }
        Ok(body.get("result").cloned().unwrap_or(Value::Null))
    }
}

#[async_trait]
impl CentrifugoApi for HttpCentrifugo {
    async fn publish(&self, channel: &str, data: Value) -> anyhow::Result<()> {
        self.call("publish", json!({ "channel": channel, "data": data })).await?;
        Ok(())
    }
    async fn presence_count(&self, channel: &str) -> anyhow::Result<u64> {
        let result = self.call("presence_stats", json!({ "channel": channel })).await?;
        Ok(result.get("num_clients").and_then(Value::as_u64).unwrap_or(0))
    }
}

/// Fake recording published messages; presence is configurable per test.
pub struct FakeCentrifugo {
    pub published: Mutex<Vec<(String, Value)>>,
    pub present: Mutex<u64>,
}

impl Default for FakeCentrifugo {
    fn default() -> Self {
        Self { published: Mutex::new(Vec::new()), present: Mutex::new(1) }
    }
}

#[async_trait]
impl CentrifugoApi for FakeCentrifugo {
    async fn publish(&self, channel: &str, data: Value) -> anyhow::Result<()> {
        self.published.lock().unwrap().push((channel.to_string(), data));
        Ok(())
    }
    async fn presence_count(&self, _channel: &str) -> anyhow::Result<u64> {
        Ok(*self.present.lock().unwrap())
    }
}
