use serde::Deserialize;
use crate::domain::clickup::ClickUpWorkspace;

const DEFAULT_BASE: &str = "https://api.clickup.com/api/v2";

#[derive(Debug, thiserror::Error)]
pub enum ClickUpError {
    #[error("clickup token invalid or expired")]
    InvalidToken,
    #[error("clickup rate limit exceeded")]
    RateLimited,
    #[error("clickup unreachable: {0}")]
    Offline(String),
    #[error("clickup api error {status}: {message}")]
    Api { status: u16, message: String },
}

pub struct ClickUpClient {
    http: reqwest::Client,
    token: String,
    base: String,
}

#[derive(Deserialize)]
struct TeamsResponse { teams: Vec<Team> }
#[derive(Deserialize)]
struct Team { id: String, name: String }

impl ClickUpClient {
    pub fn new(token: impl Into<String>) -> Self {
        Self::with_base(token, DEFAULT_BASE)
    }

    pub fn with_base(token: impl Into<String>, base: impl Into<String>) -> Self {
        Self { http: reqwest::Client::new(), token: token.into(), base: base.into() }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base.trim_end_matches('/'), path)
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, ClickUpError> {
        let resp = self.http
            .get(self.url(path))
            .header("Authorization", &self.token)
            .send().await
            .map_err(|e| ClickUpError::Offline(e.to_string()))?;
        Self::ok(resp).await?.json().await
            .map_err(|e| ClickUpError::Offline(e.to_string()))
    }

    async fn ok(resp: reqwest::Response) -> Result<reqwest::Response, ClickUpError> {
        match resp.status().as_u16() {
            200..=299 => Ok(resp),
            401 | 403 => Err(ClickUpError::InvalidToken),
            429 => Err(ClickUpError::RateLimited),
            status => {
                let message = resp.text().await.unwrap_or_default();
                Err(ClickUpError::Api { status, message })
            }
        }
    }

    pub async fn get_user(&self) -> Result<(), ClickUpError> {
        let resp = self.http
            .get(self.url("/user"))
            .header("Authorization", &self.token)
            .send().await
            .map_err(|e| ClickUpError::Offline(e.to_string()))?;
        Self::ok(resp).await.map(|_| ())
    }

    pub async fn list_workspaces(&self) -> Result<Vec<ClickUpWorkspace>, ClickUpError> {
        let r: TeamsResponse = self.get_json("/team").await?;
        Ok(r.teams.into_iter().map(|t| ClickUpWorkspace { id: t.id, name: t.name }).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn get_user_ok_sends_authorization_header() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/user"))
            .and(header("authorization", "pk_test"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "user": { "id": 1, "username": "u" }
            })))
            .mount(&server).await;
        let client = ClickUpClient::with_base("pk_test", server.uri());
        client.get_user().await.unwrap();
    }

    #[tokio::test]
    async fn get_user_401_maps_invalid_token() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/user"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server).await;
        let client = ClickUpClient::with_base("bad", server.uri());
        assert!(matches!(client.get_user().await.unwrap_err(), ClickUpError::InvalidToken));
    }

    #[tokio::test]
    async fn list_workspaces_parses_teams() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/team"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "teams": [ { "id": "111", "name": "Acme" }, { "id": "222", "name": "Beta" } ]
            })))
            .mount(&server).await;
        let client = ClickUpClient::with_base("pk_test", server.uri());
        let ws = client.list_workspaces().await.unwrap();
        assert_eq!(ws.len(), 2);
        assert_eq!(ws[0].id, "111");
        assert_eq!(ws[0].name, "Acme");
    }

    #[tokio::test]
    async fn rate_limit_maps_429() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/team"))
            .respond_with(ResponseTemplate::new(429))
            .mount(&server).await;
        let client = ClickUpClient::with_base("pk_test", server.uri());
        assert!(matches!(client.list_workspaces().await.unwrap_err(), ClickUpError::RateLimited));
    }
}
