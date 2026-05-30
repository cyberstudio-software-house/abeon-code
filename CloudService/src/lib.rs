pub mod auth;
pub mod centrifugo;
pub mod config;
pub mod crypto;
pub mod error;
pub mod routes;
pub mod store;

use axum::routing::{get, post};
use axum::Router;
use std::sync::Arc;

/// Shared application state. Trait objects let production wire sqlx/reqwest impls
/// while tests wire in-memory fakes.
#[derive(Clone)]
pub struct AppState {
    pub devices: Arc<dyn store::DeviceStore>,
    pub phones: Arc<dyn store::PhoneTokenStore>,
    pub pairing: Arc<dyn store::PairingStore>,
    pub centrifugo: Arc<dyn centrifugo::CentrifugoApi>,
    pub config: Arc<config::Config>,
}

/// Build the router. Pure function of state so tests can call it with fakes.
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(routes::health::healthz))
        .route("/readyz", get(routes::health::readyz))
        .route("/v1/devices", post(routes::devices::register))
        .route("/v1/token", post(routes::token::issue))
        .route("/v1/pair/start", post(routes::pairing::start))
        .route("/v1/pair/claim", post(routes::pairing::claim))
        .route("/v1/command", post(routes::command::publish))
        .with_state(state)
}

/// Wire production dependencies (sqlx pool + Centrifugo HTTP client), running
/// pending migrations before serving.
pub async fn build_state(config: config::Config) -> anyhow::Result<AppState> {
    use sqlx::mysql::MySqlPoolOptions;
    let pool = MySqlPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(&config.database_url)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;

    let store = Arc::new(store::mysql::MysqlStore::new(pool));
    let centrifugo = Arc::new(centrifugo::HttpCentrifugo::new(
        config.centrifugo_api_url.clone(),
        config.centrifugo_api_key.clone(),
    ));
    Ok(AppState {
        devices: store.clone(),
        phones: store.clone(),
        pairing: store,
        centrifugo,
        config: Arc::new(config),
    })
}
