use async_trait::async_trait;
use serde_json::json;

#[async_trait]
pub trait ExpoApi: Send + Sync {
    /// Best-effort push send. `data` is attached to the notification (e.g. {"sessionId": "..."}).
    async fn send_push(&self, to: &str, title: &str, body: &str, data: serde_json::Value) -> anyhow::Result<()>;
}

pub struct HttpExpo {
    client: reqwest::Client,
    url: String,
}

impl HttpExpo {
    pub fn new(url: impl Into<String>) -> Self {
        Self { client: reqwest::Client::new(), url: url.into() }
    }
}

#[async_trait]
impl ExpoApi for HttpExpo {
    async fn send_push(&self, to: &str, title: &str, body: &str, data: serde_json::Value) -> anyhow::Result<()> {
        let endpoint = format!("{}/--/api/v2/push/send", self.url.trim_end_matches('/'));
        self.client
            .post(&endpoint)
            .json(&json!({ "to": to, "title": title, "body": body, "sound": "default", "data": data }))
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }
}

#[derive(Default)]
pub struct FakeExpo {
    pub sent: std::sync::Mutex<Vec<(String, String, String, serde_json::Value)>>,
}

#[async_trait]
impl ExpoApi for FakeExpo {
    async fn send_push(&self, to: &str, title: &str, body: &str, data: serde_json::Value) -> anyhow::Result<()> {
        self.sent.lock().unwrap().push((to.into(), title.into(), body.into(), data));
        Ok(())
    }
}
