use serde::Deserialize;

/// Errors from authenticated CloudService calls. `Unauthorized` is split out so
/// callers can transparently re-register a stale device secret and retry.
#[derive(Debug, thiserror::Error)]
pub enum CloudError {
    #[error("unauthorized: device secret not recognized by CloudService")]
    Unauthorized,
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

/// Async client for the CloudService REST API. The desktop uses it to register,
/// fetch short-lived Centrifugo tokens, and start phone pairing.
pub struct CloudClient {
    http: reqwest::Client,
    base: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterResponse {
    device_id: String,
    device_secret: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenResponse {
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairCode {
    pub code: String,
    pub expires_in_secs: i64,
}

impl CloudClient {
    pub fn new(base: impl Into<String>) -> Self {
        Self { http: reqwest::Client::new(), base: base.into() }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base.trim_end_matches('/'), path)
    }

    /// Map a response into `Unauthorized` on 401, else propagate other HTTP
    /// errors as `Other`. Used by authenticated calls that support retry.
    fn check_auth(resp: reqwest::Response) -> Result<reqwest::Response, CloudError> {
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(CloudError::Unauthorized);
        }
        resp.error_for_status().map_err(|e| CloudError::Other(e.into()))
    }

    /// First-boot registration → `(deviceId, deviceSecret)`.
    pub async fn register(&self) -> anyhow::Result<(String, String)> {
        let resp: RegisterResponse = self
            .http
            .post(self.url("/v1/devices"))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok((resp.device_id, resp.device_secret))
    }

    /// Exchange the device secret for a short-lived Centrifugo connection JWT.
    pub async fn fetch_token(&self, device_secret: &str) -> Result<String, CloudError> {
        let resp = self
            .http
            .post(self.url("/v1/token"))
            .bearer_auth(device_secret)
            .send()
            .await
            .map_err(|e| CloudError::Other(e.into()))?;
        let resp: TokenResponse = Self::check_auth(resp)?
            .json()
            .await
            .map_err(|e| CloudError::Other(e.into()))?;
        Ok(resp.token)
    }

    /// Best-effort push notification: a session is waiting for the user.
    pub async fn notify_permission(&self, device_secret: &str, session_id: &str) -> anyhow::Result<()> {
        self.http
            .post(self.url("/v1/notify"))
            .bearer_auth(device_secret)
            .json(&serde_json::json!({ "sessionId": session_id }))
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    /// Start pairing → a one-time code to display as text/QR.
    pub async fn pair_start(&self, device_secret: &str) -> Result<PairCode, CloudError> {
        let resp = self
            .http
            .post(self.url("/v1/pair/start"))
            .bearer_auth(device_secret)
            .send()
            .await
            .map_err(|e| CloudError::Other(e.into()))?;
        let pc: PairCode = Self::check_auth(resp)?
            .json()
            .await
            .map_err(|e| CloudError::Other(e.into()))?;
        Ok(pc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn register_parses_device_id_and_secret() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/devices"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "deviceId": "dev-1", "deviceSecret": "sekret"
            })))
            .mount(&server)
            .await;

        let client = CloudClient::new(server.uri());
        let (id, secret) = client.register().await.unwrap();
        assert_eq!(id, "dev-1");
        assert_eq!(secret, "sekret");
    }

    #[tokio::test]
    async fn fetch_token_sends_bearer_and_returns_token() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/token"))
            .and(header("authorization", "Bearer sekret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "token": "jwt-123", "expiresInSecs": 3600
            })))
            .mount(&server)
            .await;

        let client = CloudClient::new(server.uri());
        let token = client.fetch_token("sekret").await.unwrap();
        assert_eq!(token, "jwt-123");
    }

    #[tokio::test]
    async fn pair_start_maps_401_to_unauthorized() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/pair/start"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;

        let client = CloudClient::new(server.uri());
        let err = client.pair_start("stale").await.unwrap_err();
        assert!(matches!(err, CloudError::Unauthorized), "got {err:?}");
    }

    #[tokio::test]
    async fn fetch_token_maps_401_to_unauthorized() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/token"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;

        let client = CloudClient::new(server.uri());
        let err = client.fetch_token("stale").await.unwrap_err();
        assert!(matches!(err, CloudError::Unauthorized), "got {err:?}");
    }

    #[tokio::test]
    async fn pair_start_returns_code() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/pair/start"))
            .and(header("authorization", "Bearer sekret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "code": "ABCD2345", "expiresInSecs": 300
            })))
            .mount(&server)
            .await;

        let client = CloudClient::new(server.uri());
        let pc = client.pair_start("sekret").await.unwrap();
        assert_eq!(pc.code, "ABCD2345");
        assert_eq!(pc.expires_in_secs, 300);
    }
}
