use std::time::Duration;

use serde::Deserialize;

pub const API_BASE: &str = "https://discord.com/api/v10";

const MESSAGE_CONTENT_INTENT_MASK: u64 = (1 << 18) | (1 << 19);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_RETRY_AFTER: Duration = Duration::from_secs(1);
pub const MESSAGES_PAGE_LIMIT: usize = 100;

#[derive(Debug, thiserror::Error)]
pub enum DiscordError {
    #[error("Discord odrzucił token bota")]
    Unauthorized,
    #[error("Discord zwrócił błąd HTTP {0}")]
    Http(u16),
    #[error("Discord ogranicza liczbę zapytań")]
    RateLimited(Duration),
    #[error("Brak połączenia z Discordem: {0}")]
    Network(String),
    #[error("Nieprawidłowa odpowiedź Discorda: {0}")]
    Decode(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotInfo {
    pub name: String,
    pub message_content_intent: bool,
    pub guild_count: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscordMessage {
    pub id: String,
    pub author_id: String,
    pub author_is_bot: bool,
    pub content: String,
}

pub struct DiscordClient {
    http: reqwest::Client,
    token: String,
    base: String,
}

#[derive(Deserialize)]
struct ApplicationDto {
    name: String,
    #[serde(default)]
    flags: u64,
    #[serde(default)]
    approximate_guild_count: Option<u64>,
}

#[derive(Deserialize)]
struct IdDto {
    id: String,
}

#[derive(Deserialize)]
struct AuthorDto {
    id: String,
    #[serde(default)]
    bot: bool,
}

#[derive(Deserialize)]
struct MessageDto {
    id: String,
    author: AuthorDto,
    #[serde(default)]
    content: String,
}

#[derive(Deserialize)]
struct RateLimitDto {
    retry_after: f64,
}

fn network_error(error: reqwest::Error) -> DiscordError {
    DiscordError::Network(error.without_url().to_string())
}

fn decode_error(error: reqwest::Error) -> DiscordError {
    DiscordError::Decode(error.without_url().to_string())
}

fn encode_path_segment(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

impl DiscordClient {
    pub fn new(token: impl Into<String>) -> Self {
        Self::with_base(token, API_BASE)
    }

    pub fn with_base(token: impl Into<String>, base: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent(format!(
                "DiscordBot (abeoncode, {})",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            http,
            token: token.into(),
            base: base.into(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base.trim_end_matches('/'), path)
    }

    fn anonymous_request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.http.request(method, self.url(path))
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.anonymous_request(method, path)
            .header("Authorization", format!("Bot {}", self.token))
    }

    async fn send(request: reqwest::RequestBuilder) -> Result<reqwest::Response, DiscordError> {
        let resp = request.send().await.map_err(network_error)?;
        match resp.status().as_u16() {
            200..=299 => Ok(resp),
            401 => Err(DiscordError::Unauthorized),
            429 => {
                let wait = resp
                    .json::<RateLimitDto>()
                    .await
                    .ok()
                    .and_then(|dto| Duration::try_from_secs_f64(dto.retry_after).ok())
                    .unwrap_or(DEFAULT_RETRY_AFTER);
                Err(DiscordError::RateLimited(wait))
            }
            status => Err(DiscordError::Http(status)),
        }
    }

    pub async fn bot(&self) -> Result<BotInfo, DiscordError> {
        let resp = Self::send(self.request(reqwest::Method::GET, "/applications/@me")).await?;
        let dto: ApplicationDto = resp.json().await.map_err(decode_error)?;
        Ok(BotInfo {
            name: dto.name,
            message_content_intent: dto.flags & MESSAGE_CONTENT_INTENT_MASK != 0,
            guild_count: dto.approximate_guild_count,
        })
    }

    pub async fn open_dm(&self, user_id: &str) -> Result<String, DiscordError> {
        let request = self
            .request(reqwest::Method::POST, "/users/@me/channels")
            .json(&serde_json::json!({ "recipient_id": user_id }));
        let resp = Self::send(request).await?;
        let dto: IdDto = resp.json().await.map_err(decode_error)?;
        Ok(dto.id)
    }

    pub async fn messages_after(
        &self,
        channel_id: &str,
        after: &str,
    ) -> Result<Vec<DiscordMessage>, DiscordError> {
        let path = format!("/channels/{}/messages", encode_path_segment(channel_id));
        let request = self.request(reqwest::Method::GET, &path).query(&[
            ("after", after.to_string()),
            ("limit", MESSAGES_PAGE_LIMIT.to_string()),
        ]);
        let resp = Self::send(request).await?;
        let dtos: Vec<MessageDto> = resp.json().await.map_err(decode_error)?;
        let mut messages: Vec<(u64, DiscordMessage)> =
            dtos.into_iter()
                .map(|dto| {
                    let numeric_id = dto.id.parse::<u64>().map_err(|_| {
                        DiscordError::Decode(format!("invalid message id: {}", dto.id))
                    })?;
                    Ok((
                        numeric_id,
                        DiscordMessage {
                            id: dto.id,
                            author_id: dto.author.id,
                            author_is_bot: dto.author.bot,
                            content: dto.content,
                        },
                    ))
                })
                .collect::<Result<_, DiscordError>>()?;
        messages.sort_by_key(|(numeric_id, _)| *numeric_id);
        Ok(messages.into_iter().map(|(_, message)| message).collect())
    }

    pub async fn react(
        &self,
        channel_id: &str,
        message_id: &str,
        emoji: &str,
    ) -> Result<(), DiscordError> {
        let path = format!(
            "/channels/{}/messages/{}/reactions/{}/@me",
            encode_path_segment(channel_id),
            encode_path_segment(message_id),
            encode_path_segment(emoji)
        );
        Self::send(self.request(reqwest::Method::PUT, &path))
            .await
            .map(|_| ())
    }

    pub async fn post_message(
        &self,
        channel_id: &str,
        payload: &serde_json::Value,
    ) -> Result<String, DiscordError> {
        let path = format!("/channels/{}/messages", encode_path_segment(channel_id));
        let request = self.request(reqwest::Method::POST, &path).json(payload);
        let resp = Self::send(request).await?;
        let dto: IdDto = resp.json().await.map_err(decode_error)?;
        Ok(dto.id)
    }

    pub async fn edit_message(
        &self,
        channel_id: &str,
        message_id: &str,
        payload: &serde_json::Value,
    ) -> Result<(), DiscordError> {
        let path = format!(
            "/channels/{}/messages/{}",
            encode_path_segment(channel_id),
            encode_path_segment(message_id)
        );
        let request = self.request(reqwest::Method::PATCH, &path).json(payload);
        Self::send(request).await.map(|_| ())
    }

    pub async fn interaction_callback(
        &self,
        interaction_id: &str,
        interaction_token: &str,
        payload: &serde_json::Value,
    ) -> Result<(), DiscordError> {
        let path = format!(
            "/interactions/{}/{}/callback",
            encode_path_segment(interaction_id),
            encode_path_segment(interaction_token)
        );
        let request = self
            .anonymous_request(reqwest::Method::POST, &path)
            .json(payload);
        Self::send(request).await.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, header, header_regex, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn bot_reads_name_intent_and_guild_count() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/applications/@me"))
            .and(header("Authorization", "Bot tok"))
            .and(header_regex("User-Agent", r"^DiscordBot \(abeoncode, "))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "name": "AbeonCode", "flags": 524288, "approximate_guild_count": 1
            })))
            .mount(&server)
            .await;
        let client = DiscordClient::with_base("tok", server.uri());
        let info = client.bot().await.unwrap();
        assert_eq!(info.name, "AbeonCode");
        assert!(info.message_content_intent);
        assert_eq!(info.guild_count, Some(1));
    }

    #[tokio::test]
    async fn bot_without_intent_flag() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/applications/@me"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "name": "AbeonCode", "flags": 0
            })))
            .mount(&server)
            .await;
        let client = DiscordClient::with_base("tok", server.uri());
        let info = client.bot().await.unwrap();
        assert!(!info.message_content_intent);
        assert_eq!(info.guild_count, None);
    }

    #[tokio::test]
    async fn unauthorized_maps_to_its_own_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/applications/@me"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let client = DiscordClient::with_base("s3cr3t-value", server.uri());
        let err = client.bot().await.unwrap_err();
        assert!(matches!(err, DiscordError::Unauthorized));
        assert!(!err.to_string().contains("s3cr3t-value"));
        assert!(!format!("{err:?}").contains("s3cr3t-value"));
    }

    #[tokio::test]
    async fn open_dm_posts_recipient_and_returns_channel_id() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/users/@me/channels"))
            .and(body_json(serde_json::json!({ "recipient_id": "u1" })))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "id": "d1" })),
            )
            .mount(&server)
            .await;
        let client = DiscordClient::with_base("tok", server.uri());
        assert_eq!(client.open_dm("u1").await.unwrap(), "d1");
    }

    #[tokio::test]
    async fn messages_after_sends_cursor_and_returns_oldest_first() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/channels/c1/messages"))
            .and(query_param("after", "100"))
            .and(query_param("limit", "100"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                { "id": "300", "author": { "id": "a", "bot": true }, "content": "x" },
                { "id": "200", "author": { "id": "b" }, "content": "y" }
            ])))
            .mount(&server)
            .await;
        let client = DiscordClient::with_base("tok", server.uri());
        let messages = client.messages_after("c1", "100").await.unwrap();
        let ids: Vec<&str> = messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["200", "300"]);
        assert!(!messages[0].author_is_bot);
        assert!(messages[1].author_is_bot);
        assert_eq!(messages[1].author_id, "a");
        assert_eq!(messages[0].content, "y");
    }

    #[tokio::test]
    async fn react_encodes_the_emoji() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/channels/c1/messages/m1/reactions/%E2%9C%85/@me"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        let client = DiscordClient::with_base("tok", server.uri());
        client.react("c1", "m1", "\u{2705}").await.unwrap();
    }

    #[tokio::test]
    async fn post_message_returns_the_new_message_id() {
        let server = MockServer::start().await;
        let payload = serde_json::json!({ "flags": 32768, "components": [] });
        Mock::given(method("POST"))
            .and(path("/channels/d1/messages"))
            .and(header("Authorization", "Bot tok"))
            .and(body_json(payload.clone()))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "id": "m1" })),
            )
            .expect(1)
            .mount(&server)
            .await;
        let client = DiscordClient::with_base("tok", server.uri());
        assert_eq!(client.post_message("d1", &payload).await.unwrap(), "m1");
    }

    #[tokio::test]
    async fn edit_message_patches_the_message() {
        let server = MockServer::start().await;
        let payload = serde_json::json!({ "flags": 32768, "components": [] });
        Mock::given(method("PATCH"))
            .and(path("/channels/d1/messages/m1"))
            .and(header("Authorization", "Bot tok"))
            .and(body_json(payload.clone()))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "id": "m1" })),
            )
            .expect(1)
            .mount(&server)
            .await;
        let client = DiscordClient::with_base("tok", server.uri());
        client.edit_message("d1", "m1", &payload).await.unwrap();
    }

    #[tokio::test]
    async fn interaction_callback_sends_no_bot_token() {
        let server = MockServer::start().await;
        let payload = serde_json::json!({ "type": 6 });
        Mock::given(method("POST"))
            .and(path("/interactions/i1/itok/callback"))
            .and(header_regex("User-Agent", r"^DiscordBot \(abeoncode, "))
            .and(body_json(payload.clone()))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        let client = DiscordClient::with_base("bot-secret", server.uri());
        client
            .interaction_callback("i1", "itok", &payload)
            .await
            .unwrap();
        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].headers.get("authorization").is_none());
    }

    #[tokio::test]
    async fn interaction_callback_errors_do_not_leak_the_interaction_token() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let client = DiscordClient::with_base("tok", server.uri());
        let err = client
            .interaction_callback("i1", "itok-secret", &serde_json::json!({ "type": 6 }))
            .await
            .unwrap_err();
        assert!(matches!(err, DiscordError::Http(404)));
        assert!(!err.to_string().contains("itok-secret"));
        assert!(!format!("{err:?}").contains("itok-secret"));
    }

    #[tokio::test]
    async fn rate_limit_maps_to_retry_after() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/channels/d1/messages"))
            .respond_with(
                ResponseTemplate::new(429).set_body_json(serde_json::json!({ "retry_after": 1.5 })),
            )
            .mount(&server)
            .await;
        let client = DiscordClient::with_base("tok", server.uri());
        let err = client
            .post_message("d1", &serde_json::json!({}))
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            DiscordError::RateLimited(wait) if wait == Duration::from_millis(1500)
        ));
        assert_eq!(err.to_string(), "Discord ogranicza liczbę zapytań");
    }

    #[tokio::test]
    async fn rate_limit_with_unreadable_body_falls_back_to_one_second() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/applications/@me"))
            .respond_with(ResponseTemplate::new(429).set_body_string("slow down"))
            .mount(&server)
            .await;
        let client = DiscordClient::with_base("tok", server.uri());
        assert!(matches!(
            client.bot().await.unwrap_err(),
            DiscordError::RateLimited(wait) if wait == Duration::from_secs(1)
        ));
    }

    #[tokio::test]
    async fn other_status_maps_to_http_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/applications/@me"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        let client = DiscordClient::with_base("tok", server.uri());
        assert!(matches!(
            client.bot().await.unwrap_err(),
            DiscordError::Http(500)
        ));
    }
}
