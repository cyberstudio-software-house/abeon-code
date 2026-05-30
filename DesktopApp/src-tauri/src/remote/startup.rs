use std::sync::Arc;
use tauri::{AppHandle, Manager};
use crate::state::AppState;
use crate::remote::bus::RemoteEventBus;
use crate::remote::bridge::{RemoteBridge, AppPtyActuator, PtyActuator, cmd_channel};
use crate::remote::ws_client::TungsteniteCentrifugoClient;
use crate::remote::token::mint_connection_token;
use crate::remote::cloud_client::CloudClient;
use crate::db::DbPool;

const DEFAULT_WS_URL: &str = "wss://ws.k8s.abeon.app/connection/websocket";

/// Wire the remote bridge at startup, only when enabled (`remoteBridgeEnabled ==
/// "true"`). Identity/token come from CloudService when `cloudServiceUrl` is set;
/// otherwise the legacy self-mint path (needs `CENTRIFUGO_TOKEN_SECRET`) is used.
pub fn init_remote_bridge(app: AppHandle) {
    let state = app.state::<AppState>();
    let conn = match state.db.get() { Ok(c) => c, Err(_) => return };

    let enabled = matches!(crate::db::settings_repo::get(&conn, "remoteBridgeEnabled"), Ok(Some(ref v)) if v == "true");
    if !enabled { return; }

    let cloud_url = crate::db::settings_repo::get(&conn, "cloudServiceUrl")
        .ok()
        .flatten()
        .filter(|s| !s.is_empty());
    let legacy_secret = std::env::var("CENTRIFUGO_TOKEN_SECRET").ok().filter(|s| !s.is_empty());

    // Without CloudService AND without a legacy secret there is no way to auth.
    if cloud_url.is_none() && legacy_secret.is_none() { return; }

    let url = std::env::var("CENTRIFUGO_WS_URL").unwrap_or_else(|_| DEFAULT_WS_URL.to_string());
    let allow_spawn = crate::commands::settings::allow_remote_spawn(&conn);
    let legacy_device_id = resolve_device_id(&conn);
    drop(conn);

    let bus = RemoteEventBus::new();
    state.session_watchers.set_bus(bus.clone());

    let registry_for_hook = state.session_pty.clone();
    state.pty.set_exit_hook(Arc::new(move |id| registry_for_hook.unbind_pty(&id)));

    let registry = state.session_pty.clone();
    let app_for_actuator = app.clone();
    let bus_rx = bus.subscribe();
    let db = state.db.clone();

    tauri::async_runtime::spawn(async move {
        let (device_id, token) = match acquire_identity(&db, cloud_url, legacy_secret, &legacy_device_id).await {
            Ok(v) => v,
            Err(e) => { eprintln!("remote bridge: identity acquisition failed: {e}"); return; }
        };

        let conn = match TungsteniteCentrifugoClient::connect(&url, &token, &cmd_channel(&device_id), None).await {
            Ok(c) => c,
            Err(e) => { eprintln!("remote bridge: connect failed: {e}"); return; }
        };
        let bridge = Arc::new(RemoteBridge::new(registry, allow_spawn));
        let actuator: Arc<dyn PtyActuator> = Arc::new(AppPtyActuator::new(app_for_actuator));
        bridge.run(device_id, conn.inbound, bus_rx, conn.client, actuator).await;
        eprintln!("remote bridge: run-loop ended");
    });
}

/// Resolve `(deviceId, connectionToken)`. CloudService path: register once
/// (persisting id+secret), then fetch a token. Legacy path: self-mint with the
/// env secret and the locally-assigned device id.
async fn acquire_identity(
    db: &DbPool,
    cloud_url: Option<String>,
    legacy_secret: Option<String>,
    legacy_device_id: &str,
) -> anyhow::Result<(String, String)> {
    if let Some(base) = cloud_url {
        let client = CloudClient::new(base);
        let (device_id, device_secret) = ensure_registered(db, &client).await?;
        let token = client.fetch_token(&device_secret).await?;
        return Ok((device_id, token));
    }
    let secret = legacy_secret.expect("checked before spawn");
    let now = unix_now();
    let token = mint_connection_token(&secret, legacy_device_id, now, 3600)?;
    Ok((legacy_device_id.to_string(), token))
}

/// Read persisted `remoteDeviceId`/`remoteDeviceSecret`; if absent, register with
/// CloudService and persist both. The secret is stored only locally (SQLite).
async fn ensure_registered(db: &DbPool, client: &CloudClient) -> anyhow::Result<(String, String)> {
    {
        let conn = db.get()?;
        let id = crate::db::settings_repo::get(&conn, "remoteDeviceId").ok().flatten();
        let secret = crate::db::settings_repo::get(&conn, "remoteDeviceSecret").ok().flatten();
        if let (Some(id), Some(secret)) = (id, secret) {
            if !id.is_empty() && !secret.is_empty() {
                return Ok((id, secret));
            }
        }
    }
    let (device_id, device_secret) = client.register().await?;
    let conn = db.get()?;
    crate::db::settings_repo::set(&conn, "remoteDeviceId", &device_id)?;
    crate::db::settings_repo::set(&conn, "remoteDeviceSecret", &device_secret)?;
    Ok((device_id, device_secret))
}

fn unix_now() -> usize {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as usize)
        .unwrap_or(0)
}

fn resolve_device_id(conn: &rusqlite::Connection) -> String {
    if let Ok(Some(id)) = crate::db::settings_repo::get(conn, "remoteDeviceId") {
        if !id.is_empty() { return id; }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = crate::db::settings_repo::set(conn, "remoteDeviceId", &id);
    id
}
