use std::env;

/// Typed runtime configuration, loaded from environment variables.
#[derive(Debug, Clone)]
pub struct Config {
    pub bind_addr: String,
    pub database_url: String,
    pub centrifugo_token_secret: String,
    pub centrifugo_api_key: String,
    pub centrifugo_api_url: String,
    pub token_ttl_secs: i64,
    pub pairing_ttl_secs: i64,
}

impl Config {
    /// Load from env, returning an error naming the first missing required var.
    pub fn from_env() -> anyhow::Result<Self> {
        fn req(key: &str) -> anyhow::Result<String> {
            env::var(key).map_err(|_| anyhow::anyhow!("missing required env var {key}"))
        }
        Ok(Config {
            bind_addr: env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into()),
            database_url: req("DATABASE_URL")?,
            centrifugo_token_secret: req("CENTRIFUGO_TOKEN_SECRET")?,
            centrifugo_api_key: req("CENTRIFUGO_API_KEY")?,
            centrifugo_api_url: req("CENTRIFUGO_API_URL")?,
            token_ttl_secs: env::var("TOKEN_TTL_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(3600),
            pairing_ttl_secs: env::var("PAIRING_TTL_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(300),
        })
    }
}
